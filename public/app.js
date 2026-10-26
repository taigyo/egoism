'use strict';
const screens = [...document.querySelectorAll('.screen')];
const $ = id => document.getElementById(id);
let dictionary = null;
let config = {};
let position = 3;
let matchRemaining = 300;
let questionRemaining = 120;
let matchTimer = null;
let questionTimer = null;
let clockTimer = null;
let currentPattern = '';
let currentAnswer = '';
let gameHistory = [];
let gameEnded = false;
let inOvertime = false;
let questionRecorded = false;
let online = false;
let socket = null;
let roomCode = '';
let roomToken = '';
let playerRole = '';
let lastServerState = null;
let matchDeadline = 0;
let questionDeadline = 0;
let lastQuestionId = 0;
let lastSuccessKey = '';
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

function goTo(id) {
  screens.forEach(s => s.classList.toggle('active', s.id === id));
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (id === 'battle') $('answer').focus({ preventScroll: true });
}
document.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => {
  if (online && b.dataset.go !== 'battle') disconnectOnline();
  stopTimers();
  goTo(b.dataset.go);
}));

async function loadDictionary() {
  try {
    const r = await fetch('/data/words.json');
    if (!r.ok) throw Error(`HTTP ${r.status}`);
    dictionary = await r.json();
    $('dictionary-status').textContent = `収録：${Object.keys(dictionary).length.toLocaleString()}種類の読み（SKK辞書加工データ）`;
  } catch (e) {
    $('dictionary-status').textContent = '辞書を読み込めません。Cloudflare Workers経由で開いてください。';
    console.error(e);
  }
}
loadDictionary();

function readConfig() {
  return {
    lengthMin: Number($('length-min').value),
    lengthMax: Number($('length-max').value),
    revealedMin: Number($('revealed-min').value),
    revealedMax: Number($('revealed-max').value),
    matchTime: Number($('match-time').value),
    questionTime: Number($('question-time').value),
    overtime: $('overtime').value
  };
}
function formatTime(seconds) {
  if (seconds === 0 || seconds === null) return '∞';
  seconds = Math.max(0, Math.ceil(seconds));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
function normalizeInput(value) {
  let out = '';
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code >= 0x30A1 && code <= 0x30F6) out += String.fromCharCode(code - 0x60);
    else if (/[ぁ-ゖー]/.test(ch)) out += ch;
  }
  return out;
}
function matchesPattern(word, pattern) {
  return [...word].length === [...pattern].length && [...pattern].every((ch, i) => ch === '〇' || ch === [...word][i]);
}
function animateQuestionText() {
  for (const id of ['pattern-desktop', 'pattern-mobile']) {
    const el = $(id);
    if (!el) continue;
    // Use Web Animations API directly instead of relying on CSS animation cascade.
    el.getAnimations().forEach(animation => animation.cancel());
    el.animate(
      [{ opacity: 0, transform: 'translateX(-18px)' }, { opacity: 1, transform: 'translateX(0)' }],
      { duration: 550, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'both' }
    );
  }
}
function buildQuestion() {
  if (!dictionary) { $('answer-message').textContent = '辞書を読み込み中です。少し待ってから再試行してください。'; return; }
  const keys = Object.keys(dictionary).filter(w => /^[ぁ-ゖー]+$/.test(w) && w.length >= config.lengthMin && w.length <= config.lengthMax);
  if (!keys.length) { $('answer-message').textContent = 'この条件に合う単語がありません。文字数を変えてください。'; return; }
  currentAnswer = keys[Math.floor(Math.random() * keys.length)];
  const revealedLow = Math.min(config.revealedMin ?? 1, config.revealedMax ?? 3);
  const revealedHigh = Math.max(config.revealedMin ?? 1, config.revealedMax ?? 3);
  const n = Math.min(currentAnswer.length, revealedLow + Math.floor(Math.random() * (revealedHigh - revealedLow + 1))); 
  const indexes = [...currentAnswer].map((_, i) => i).sort(() => Math.random() - .5).slice(0, n);
  const chars = [...'〇'.repeat(currentAnswer.length)];
  indexes.forEach(i => chars[i] = currentAnswer[i]);
  currentPattern = chars.join('');
  questionRecorded = false;
  $('pattern-desktop').textContent = currentPattern;
  $('pattern-mobile').textContent = currentPattern;
  animateQuestionText();
  $('answer').value = '';
  $('answer-message').textContent = '表示された文字に合う読みを入力してください。';
  questionRemaining = config.questionTime;
  updateClockLocal();
  startQuestionTimer();
}
function recordUnanswered(reason) {
  if (questionRecorded || !currentAnswer || !dictionary) return;
  const candidates = Object.keys(dictionary).filter(w => /^[ぁ-ゖー]+$/.test(w) && matchesPattern(w, currentPattern));
  gameHistory.push({ unanswered: true, pattern: currentPattern, reason, candidates: candidates.sort(() => Math.random() - .5).slice(0, 5), who: 'none', word: '未回答の問題' });
  questionRecorded = true;
}
function updateBoard(previous = position, animate = true) {
  const cells = [...document.querySelectorAll('.track-cell')];
  cells.forEach((cell, i) => {
    const wasRed = i < previous;
    const isRed = i < position;
    const changed = animate && wasRed !== isRed;
    const oldColor = getComputedStyle(cell).backgroundColor;
    cell.querySelectorAll('.territory-wipe').forEach(node => node.remove());
    cell.classList.remove('captured-red', 'captured-blue');
    cell.classList.toggle('red-territory', isRed);
    cell.classList.toggle('blue-territory', !isRed);
    if (changed) {
      // Animate a real overlay element with the Web Animations API. This avoids
      // CSS animation overrides and makes the old color visibly wipe away.
      const wipe = document.createElement('span');
      wipe.className = 'territory-wipe';
      wipe.style.backgroundColor = oldColor;
      wipe.style.transformOrigin = isRed ? 'right center' : 'left center';
      cell.appendChild(wipe);
      const animation = wipe.animate(
        [{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }],
        { duration: 1000, easing: 'cubic-bezier(.22,.75,.25,1)', fill: 'forwards' }
      );
      animation.onfinish = () => wipe.remove();
    }
  });
}
function updateClockLocal() { $('match-clock').textContent = inOvertime ? '延長' : formatTime(matchRemaining); }
function stopTimers() {
  [matchTimer, questionTimer, clockTimer].forEach(t => { if (t) clearInterval(t); });
  matchTimer = questionTimer = clockTimer = null;
}
function startMatchTimer() {
  if (config.matchTime === 0) return;
  matchTimer = setInterval(() => {
    if (gameEnded || inOvertime) return;
    matchRemaining = Math.max(0, matchRemaining - 1);
    updateClockLocal();
    if (matchRemaining <= 0) { clearInterval(matchTimer); matchTimer = null; onMatchTimeUp(); }
  }, 1000);
}
function startQuestionTimer() {
  if (questionTimer) clearInterval(questionTimer);
  if (config.questionTime === 0) return;
  questionTimer = setInterval(() => {
    questionRemaining--;
    if (questionRemaining <= 0) {
      clearInterval(questionTimer); questionTimer = null;
      nextQuestion('問題の制限時間が終了しました。', '制限時間終了');
    }
  }, 1000);
}
function onMatchTimeUp() {
  if (position === 3 && config.overtime === 'sudden') { inOvertime = true; updateClockLocal(); $('answer-message').textContent = '延長戦！ 次に正解した側が勝利です。'; return; }
  if (position === 3) { endGame('引き分け', '時間切れまでに差がつきませんでした。'); return; }
  endGame(position > 3 ? 'エ語彙スト！' : '相手がエ語彙スト！', '時間切れ。塗り替えたマスの数で勝敗が決まりました。');
}
function renderGameHistory() {
  const list = $('game-history'); list.replaceChildren();
  if (!gameHistory.length) { const empty = document.createElement('li'); empty.className = 'history-empty'; empty.textContent = 'この試合で記録された言葉・問題はありません。'; list.append(empty); return; }
  gameHistory.forEach((entry, index) => {
    const li = document.createElement('li'); li.className = 'history-entry ' + (entry.who === 'red' ? 'history-red' : entry.who === 'blue' ? 'history-blue' : 'history-unanswered');
    const number = document.createElement('span'); number.className = 'history-number'; number.textContent = String(index + 1).padStart(2, '0');
    const content = document.createElement('span'); content.className = 'history-content';
    const word = document.createElement('strong'); word.textContent = entry.unanswered ? `問題：${entry.pattern}` : entry.word;
    const forms = document.createElement('small'); forms.textContent = entry.unanswered ? `未回答（${entry.reason}）候補：${(entry.candidates || []).join(' ・ ') || '候補なし'}` : (entry.forms || []).join(' ・ ') || '表記候補なし';
    content.append(word, forms);
    const player = document.createElement('span'); player.className = 'history-player'; player.textContent = entry.unanswered ? '未回答' : entry.who === 'red' ? '赤' : '青';
    li.append(number, content, player); list.append(li);
  });
}
function endGame(title, detail) {
  if (online) return;
  if (!questionRecorded && currentAnswer) recordUnanswered('試合終了');
  gameEnded = true; stopTimers();
  $('end-title').textContent = title; $('end-detail').textContent = detail; renderGameHistory(); $('end-overlay').classList.remove('hidden');
}
function showSuccess(word, formsOverride = null) {
  const forms = [...new Set(formsOverride || dictionary?.[word] || [])];
  $('success-reading').textContent = word; $('success-forms').textContent = forms.slice(0, 10).join(' ・ ') || '表記候補なし';
  $('meaning-link').href = 'https://jisho.org/search/' + encodeURIComponent(forms[0] || word);
  const banner = $('success-banner'); banner.classList.remove('show'); void banner.offsetWidth; banner.classList.add('show');
}
function acceptAnswer(word, who = 'red') {
  if (gameEnded) return;
  if (!dictionary) { $('answer-message').textContent = '辞書を読み込めていません。'; return; }
  if (!/^[ぁ-ゖー]+$/.test(word)) { $('answer-message').textContent = 'ひらがなで入力してください。'; return; }
  if (!matchesPattern(word, currentPattern)) { $('answer-message').textContent = '文字数、または公開された文字が合っていません。'; return; }
  if (!dictionary[word]) { $('answer-message').textContent = '辞書にない読みです。別の言葉を試してください。'; return; }
  questionRecorded = true; gameHistory.push({ word, who, forms: [...new Set(dictionary[word] || [])] }); showSuccess(word);
  if (inOvertime) { endGame(who === 'red' ? 'エ語彙スト！' : '相手がエ語彙スト！', '延長戦で先に正解しました。'); return; }
  const previous = position; position = clamp(position + (who === 'red' ? 1 : -1), 0, 6); updateBoard(previous);
  $('answer-message').textContent = `正解：${word}。${who === 'red' ? '青のマスを赤に' : '赤のマスを青に'}塗り替えました。`;
  if (position === 6) { endGame('エ語彙スト！', '6マスすべてを赤に塗り替えました。'); return; }
  if (position === 0) { endGame('相手がエ語彙スト！', '6マスすべてを青に塗り替えられました。'); return; }
  buildQuestion();
}
function nextQuestion(message, reason = 'パス') {
  if (gameEnded) return; recordUnanswered(reason); $('answer-message').textContent = message; buildQuestion();
}
function startDemo() {
  disconnectOnline(); stopTimers(); config = readConfig(); position = 3; gameEnded = false; inOvertime = false;
  matchRemaining = config.matchTime; questionRemaining = config.questionTime; gameHistory = [];
  $('end-overlay').classList.add('hidden'); $('match-room-label').textContent = 'LOCAL PREVIEW'; $('success-banner').classList.remove('show');
  updateBoard(3, false); goTo('battle'); buildQuestion(); startMatchTimer();
}

function syncDualRange(prefix, minAllowed, maxAllowed) {
  const min = $(`${prefix}-min`), max = $(`${prefix}-max`);
  if (Number(min.value) > Number(max.value)) {
    if (document.activeElement === min) max.value = min.value;
    else min.value = max.value;
  }
  const minValue = Number(min.value), maxValue = Number(max.value);
  const low = (minValue - minAllowed) / (maxAllowed - minAllowed) * 100;
  const high = (maxValue - minAllowed) / (maxAllowed - minAllowed) * 100;
  $(`${prefix}-range-fill`).style.left = low + '%';
  $(`${prefix}-range-fill`).style.width = (high - low) + '%';
  $(`${prefix}-range-label`).textContent = `${minValue}～${maxValue}文字`;
}
$('length-min').addEventListener('input', () => syncDualRange('length', 3, 10));
$('length-max').addEventListener('input', () => syncDualRange('length', 3, 10));
$('revealed-min').addEventListener('input', () => syncDualRange('revealed', 0, 10));
$('revealed-max').addEventListener('input', () => syncDualRange('revealed', 0, 10));
syncDualRange('length', 3, 10);
syncDualRange('revealed', 0, 10);
$('settings-form').addEventListener('submit', e => e.preventDefault());

function setRoomMessage(message) { $('room-message').textContent = message; }
function makeToken() { return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36); }
function websocketUrl(code, token) { const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'; return `${scheme}//${location.host}/api/rooms/${encodeURIComponent(code)}/ws?token=${encodeURIComponent(token)}`; }
async function createOnlineRoom() {
  const button = $('create-room'); button.disabled = true; setRoomMessage('部屋を作成しています…');
  try {
    const cfg = readConfig();
    const res = await fetch('/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
    const responseText = await res.text();
    let data;
    try { data = JSON.parse(responseText); }
    catch {
      const hint = responseText.trim().startsWith('<!DOCTYPE') || responseText.trim().startsWith('<html')
        ? 'サーバーがJSONではなくHTMLを返しました。Cloudflareのデプロイ先・Workerログ・/api/healthを確認してください。'
        : 'サーバーから正しいJSON応答がありませんでした。';
      throw new Error(`${hint} (HTTP ${res.status})`);
    }
    if (!res.ok) {
      const detail = data.detail ? `\n詳細: ${data.detail}` : '';
      throw new Error(`${data.error || '部屋を作成できませんでした。'}${data.code ? ` [${data.code}]` : ''}${detail}`);
    }
    roomCode = data.code; roomToken = data.token; playerRole = 'red';
    try { sessionStorage.setItem('egoism-room:' + roomCode, JSON.stringify({ token: roomToken, role: playerRole })); } catch {}
    $('room-code').textContent = roomCode; $('room-created').classList.remove('hidden');
    $('room-created').querySelector('.small').textContent = '部屋ID（相手に共有）';
    $('room-message').textContent = '部屋を作成しました。相手の参加を待っています…';
    connectOnline(roomCode, roomToken);
  } catch (e) { setRoomMessage(e.message || '部屋を作成できませんでした。'); }
  finally { button.disabled = false; }
}
function joinOnlineRoom() {
  const code = $('room-id').value.trim().toUpperCase();
  if (!/^[A-Z0-9]{4,8}$/.test(code)) { setRoomMessage('4〜8文字の部屋IDを入力してください。'); return; }
  roomCode = code;
  let saved = null; try { saved = JSON.parse(sessionStorage.getItem('egoism-room:' + roomCode) || 'null'); } catch {}
  roomToken = saved?.token || makeToken(); playerRole = saved?.role || 'blue';
  try { sessionStorage.setItem('egoism-room:' + roomCode, JSON.stringify({ token: roomToken, role: playerRole })); } catch {}
  setRoomMessage('部屋に接続しています…'); connectOnline(roomCode, roomToken);
}
function connectOnline(code, token) {
  disconnectOnline(); online = true; gameEnded = false; lastQuestionId = 0; lastSuccessKey = ''; stopTimers();
  socket = new WebSocket(websocketUrl(code, token));
  socket.addEventListener('open', () => setRoomMessage('接続しました。相手の参加を待っています…'));
  socket.addEventListener('message', event => {
    let msg; try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.type === 'error') { if ($('battle').classList.contains('active')) $('answer-message').textContent = msg.message || '接続エラー'; else setRoomMessage(msg.message || '接続エラー'); if (msg.fatal) disconnectOnline(); return; }
    if (msg.type === 'state') applyServerState(msg.state);
    if (msg.type === 'room-full') { setRoomMessage('この部屋は満員です。'); disconnectOnline(); }
  });
  socket.addEventListener('close', () => { if (online && !gameEnded) setRoomMessage('サーバーとの接続が切れました。部屋IDを使って再接続してください。'); });
  socket.addEventListener('error', () => setRoomMessage('接続に失敗しました。部屋IDと公開先の設定を確認してください。'));
}
function disconnectOnline() {
  online = false;
  if (socket) { try { socket.close(); } catch {} socket = null; }
  lastServerState = null; matchDeadline = questionDeadline = 0;
  if (clockTimer) clearInterval(clockTimer); clockTimer = null;
}
function sendOnline(type, payload = {}) {
  if (!socket || socket.readyState !== WebSocket.OPEN) { $('answer-message').textContent = 'サーバーに接続していません。'; return false; }
  socket.send(JSON.stringify({ type, ...payload })); return true;
}
function applyServerState(state) {
  const previous = lastServerState ? lastServerState.position : state.position;
  lastServerState = state; position = state.position; config = state.config || config;
  currentPattern = state.pattern || ''; gameEnded = state.ended; inOvertime = state.inOvertime;
  matchDeadline = state.matchDeadline || 0; questionDeadline = state.questionDeadline || 0;
  $('match-room-label').textContent = `${roomCode} / ${state.started ? (playerRole === 'red' ? '赤' : '青') : '相手待ち'}`;
  if (!state.started) { setRoomMessage(state.players?.blue?.connected ? '対戦を準備しています…' : '相手の参加を待っています…'); $('answer-message').textContent = '相手が参加すると対戦が始まります。'; return; }
  setRoomMessage('対戦中です。部屋IDを共有している相手と接続中です。');
  if (!$('battle').classList.contains('active')) goTo('battle');
  $('end-overlay').classList.add('hidden');
  $('pattern-desktop').textContent = currentPattern; $('pattern-mobile').textContent = currentPattern;
  if (state.questionId !== lastQuestionId) { lastQuestionId = state.questionId; animateQuestionText(); $('answer').value = ''; }
  updateBoard(previous, !!lastServerState && previous !== position);
  if (state.lastSuccess) {
    const key = `${state.lastSuccess.reading}:${state.lastSuccess.questionId}`;
    if (key !== lastSuccessKey) { lastSuccessKey = key; showSuccess(state.lastSuccess.reading, state.lastSuccess.forms); }
  }
  gameHistory = state.history || [];
  if (state.passed?.length) $('answer-message').textContent = state.passed.includes(playerRole) ? 'パス済みです。相手のパスを待っています。' : '相手がパスしました。パスするか、回答してください。';
  else $('answer-message').textContent = inOvertime ? '延長戦！ 次の正解で決着します。' : '表示された文字に合う読みを入力してください。';
  if (state.ended) {
    stopTimers(); const winner = state.result?.winner; $('end-title').textContent = winner === null || winner === undefined ? '引き分け' : winner === playerRole ? 'エ語彙スト！' : '相手がエ語彙スト！'; $('end-detail').textContent = state.result?.detail || '対戦が終了しました。'; renderGameHistory(); $('end-overlay').classList.remove('hidden');
  }
  if (!clockTimer) clockTimer = setInterval(updateOnlineClock, 250);
  updateOnlineClock();
}
function updateOnlineClock() {
  if (!online || !lastServerState) return;
  const now = Date.now();
  const match = matchDeadline ? Math.max(0, Math.ceil((matchDeadline - now) / 1000)) : 0;
  const question = questionDeadline ? Math.max(0, Math.ceil((questionDeadline - now) / 1000)) : 0;
  $('match-clock').textContent = lastServerState.inOvertime ? '延長' : matchDeadline ? formatTime(match) : '∞';
  questionRemaining = questionDeadline ? question : 0;
}

$('create-room').addEventListener('click', createOnlineRoom);
$('copy-room').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('room-code').textContent); setRoomMessage('部屋IDをコピーしました。'); } catch { setRoomMessage('部屋ID：' + $('room-code').textContent); } });
$('join-room').addEventListener('click', joinOnlineRoom);
$('preview-battle').addEventListener('click', startDemo);
$('answer').addEventListener('input', e => {
  if (e.isComposing) return;
  const el = e.target, start = el.selectionStart, cleaned = normalizeInput(el.value);
  if (cleaned !== el.value) { el.value = cleaned; try { el.setSelectionRange(Math.min(start, cleaned.length), Math.min(start, cleaned.length)); } catch {} }
});
$('answer-form').addEventListener('submit', e => {
  e.preventDefault(); const input = $('answer'), answer = normalizeInput(input.value.trim());
  if (online) sendOnline('answer', { word: answer, questionId: lastServerState?.questionId }); else acceptAnswer(answer, 'red');
  input.value = ''; if (!gameEnded) input.focus({ preventScroll: true });
});
$('pass-button').addEventListener('click', () => {
  if (online) sendOnline('pass', { questionId: lastServerState?.questionId });
  else { nextQuestion('パスしました。次の問題です。', 'パス'); }
  $('answer').focus({ preventScroll: true });
});
$('opponent-test').addEventListener('click', () => { if (!online) acceptAnswer(currentAnswer, 'blue'); if (!gameEnded) $('answer').focus({ preventScroll: true }); });
$('rematch').addEventListener('click', () => { if (online) { disconnectOnline(); goTo('settings'); } else startDemo(); });
document.addEventListener('keydown', e => {
  if (!$('battle').classList.contains('active') || gameEnded || e.ctrlKey || e.altKey || e.metaKey || e.key.length !== 1) return;
  const input = $('answer'); if (document.activeElement !== input && !e.target.matches('input,select,textarea,button')) input.focus({ preventScroll: true });
});
$('battle').addEventListener('click', e => {
  if (e.target.closest('button') || e.target.closest('input') || !$('end-overlay').classList.contains('hidden')) return;
  $('answer').focus({ preventScroll: true });
});
$('answer').addEventListener('blur', () => {
  if ($('battle').classList.contains('active') && !gameEnded && document.activeElement === document.body) requestAnimationFrame(() => $('answer').focus({ preventScroll: true }));
});
