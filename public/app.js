'use strict';
const screens = [...document.querySelectorAll('.screen')];
const $ = id => document.getElementById(id);
let dictionary = null;
let properNounReadings = new Set();
let meaningDictionary = null;
let meaningDictionaryPromise = null;
let wikipediaMeaningDictionary = {};
const loadedWikipediaMeaningShards = new Set();
const wikipediaMeaningShardPromises = new Map();
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
let usedQuestionWords = new Set();
let usedAnswerWords = new Set();
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
let countdownRunning = false;
let countdownTimer = null;
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

function goTo(id) {
  screens.forEach(s => s.classList.toggle('active', s.id === id));
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (id === 'battle' && !countdownRunning && !gameEnded) $('answer').focus({ preventScroll: true });
}
document.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', async () => {
  if (online && b.dataset.go !== 'battle') {
    disconnectOnline();
    resetRoomUi();
  }
  stopTimers();
  goTo(b.dataset.go);
}));

async function loadDictionary() {
  try {
    const shardFiles = ['/data/words-1.json', '/data/words-2.json', '/data/words-3.json', '/data/words-4.json', '/data/words-5.json', '/data/words-6.json', '/data/words-7.json', '/data/words-8.json'];
    const dictionaries = await Promise.all(shardFiles.map(async file => {
      const response = await fetch(file);
      if (!response.ok) throw Error(`${file}: HTTP ${response.status}`);
      return response.json();
    }));
    dictionary = Object.assign({}, ...dictionaries);
    try {
      const properResponse = await fetch('/data/proper-noun-readings.json');
      if (properResponse.ok) properNounReadings = new Set(await properResponse.json());
    } catch (error) { console.warn('固有名詞候補リストを読み込めませんでした', error); }
    $('dictionary-status').textContent = `収録：約${Object.keys(dictionary).length.toLocaleString()}種類の読み（複数辞書統合）`;
  } catch (e) {
    $('dictionary-status').textContent = '辞書を読み込めません。Cloudflare Workers経由で開いてください。';
    console.error(e);
  }
}
loadDictionary();

function loadMeaningDictionary() {
  if (meaningDictionary) return Promise.resolve(meaningDictionary);
  if (!meaningDictionaryPromise) {
    meaningDictionaryPromise = fetch('/data/meanings.json')
      .then(r => { if (!r.ok) throw Error(`HTTP ${r.status}`); return r.json(); })
      .then(data => { meaningDictionary = data; return data; })
      .catch(error => {
        console.error('意味辞書の読み込みに失敗しました', error);
        meaningDictionary = {};
        return meaningDictionary;
      });
  }
  return meaningDictionaryPromise;
}

function wikipediaMeaningBucket(reading) {
  let hash = 0;
  for (let i = 0; i < reading.length; i++) hash = (hash * 31 + reading.charCodeAt(i)) >>> 0;
  return hash % 128;
}
async function loadWikipediaMeaningsForHistory(entries) {
  await loadMeaningDictionary();
  const readings = new Set();
  for (const entry of entries) {
    if (!entry || entry.unanswered || !entry.word) continue;
    const forms = [...new Set(entry.forms || [])];
    const existing = forms.some(form => meaningDictionary?.[entry.word]?.[form]?.length);
    if (!existing) readings.add(entry.word);
  }
  const buckets = new Set([...readings].map(reading => wikipediaMeaningBucket(reading)));
  await Promise.all([...buckets].map(bucket => {
    if (loadedWikipediaMeaningShards.has(bucket)) return Promise.resolve();
    if (!wikipediaMeaningShardPromises.has(bucket)) {
      const filename = `/data/wiki-meanings-${String(bucket).padStart(3, '0')}.json`;
      const promise = fetch(filename)
        .then(response => { if (!response.ok) throw Error(`${filename}: HTTP ${response.status}`); return response.json(); })
        .then(data => {
          Object.assign(wikipediaMeaningDictionary, data);
          loadedWikipediaMeaningShards.add(bucket);
        })
        .catch(error => { console.error('Wikipedia意味データの読み込みに失敗しました', error); });
      wikipediaMeaningShardPromises.set(bucket, promise);
    }
    return wikipediaMeaningShardPromises.get(bucket);
  }));
}

function collectMeaningDefinitions(reading, forms) {
  const definitions = [];
  for (const form of [...new Set(forms || [])]) {
    definitions.push(...(meaningDictionary?.[reading]?.[form] || []));
    definitions.push(...(wikipediaMeaningDictionary?.[reading]?.[form] || []));
  }
  return [...new Set(definitions.filter(value => typeof value === 'string' && value.trim()))];
}
function pickRandomMeaning(reading, forms) {
  const definitions = collectMeaningDefinitions(reading, forms);
  return definitions.length ? definitions[Math.floor(Math.random() * definitions.length)] : '';
}
async function loadMeaningsForWord(reading, forms) {
  await loadMeaningDictionary();
  await loadWikipediaMeaningsForHistory([{ word: reading, forms }]);
  return pickRandomMeaning(reading, forms);
}

function readConfig() {
  return {
    lengthMin: Number($('length-min').value),
    lengthMax: Number($('length-max').value),
    difficulty: $('difficulty-level').value,
    revealedMin: Number($('revealed-min').value),
    revealedMax: Number($('revealed-max').value),
    matchTime: Number($('match-time').value),
    questionTime: Number($('question-time').value),
    overtime: $('overtime').value
  };
}
function formatTime(seconds) {
  if (seconds === null) return '∞';
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
function classifyWordDifficulty(reading, forms = []) {
  if (properNounReadings.has(String(reading || ''))) return 'advanced';
  const chars = [...String(reading || '')];
  const safeForms = [...new Set(Array.isArray(forms) ? forms.filter(form => typeof form === 'string') : [])];
  const isComplexForm = form => /[\u3400-\u4DBF\u{20000}-\u{2FA1F}]/u.test(form) || [...form].length >= 8 || (form.match(/[一-龯]/g) || []).length >= 5;
  const isIntermediateForm = form => /[ァ-ヺ]/.test(form) || (form.match(/[一-龯]/g) || []).length >= 3;
  const allFormsComplex = safeForms.length > 0 && safeForms.every(isComplexForm);
  const allFormsIntermediate = safeForms.length > 0 && safeForms.every(isIntermediateForm);
  if (chars.length >= 7 || allFormsComplex) return 'advanced';
  if (chars.length >= 5 || allFormsIntermediate) return 'intermediate';
  return 'beginner';
}
function matchesDifficulty(reading, forms, difficulty) {
  return difficulty === 'unlimited' || classifyWordDifficulty(reading, forms) === difficulty;
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
  const eligible = Object.keys(dictionary).filter(w => /^[ぁ-ゖー]+$/.test(w) && w.length >= config.lengthMin && w.length <= config.lengthMax && matchesDifficulty(w, dictionary[w], config.difficulty || 'unlimited'));
  if (!eligible.length) { $('answer-message').textContent = 'この難易度と文字数に合う単語がありません。難易度または文字数を変えてください。'; return; }
  const keys = eligible.filter(w => !usedQuestionWords.has(w) && !usedAnswerWords.has(w));
  if (!keys.length) {
    currentAnswer = ''; currentPattern = '';
    $('pattern-desktop').textContent = ''; $('pattern-mobile').textContent = '';
    if ($('pattern-mobile-below')) $('pattern-mobile-below').textContent = '';
    endGame('語彙切れ', 'この試合で使える言葉がなくなりました。');
    return;
  }
  currentAnswer = keys[Math.floor(Math.random() * keys.length)];
  usedQuestionWords.add(currentAnswer);
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
  if ($('pattern-mobile-below')) $('pattern-mobile-below').textContent = currentPattern;
  animateQuestionText();
  $('answer').value = '';
  $('answer-message').textContent = '表示された文字に合う読みを入力してください。';
  questionRemaining = config.questionTime;
  updateClockLocal();
  startQuestionTimer();
}
function recordUnanswered(reason) {
  if (questionRecorded || !currentAnswer || !dictionary) return;
  const candidates = Object.keys(dictionary).filter(w => /^[ぁ-ゖー]+$/.test(w) && matchesDifficulty(w, dictionary[w], config.difficulty || 'unlimited') && matchesPattern(w, currentPattern) && !usedAnswerWords.has(w));
  gameHistory.push({ unanswered: true, pattern: currentPattern, reason, candidates: candidates.sort(() => Math.random() - .5).slice(0, 5), who: 'none', word: '未回答の問題' });
  questionRecorded = true;
}
function updateBoard(previous = position, animate = true) {
  const cells = [...document.querySelectorAll('.track-cell')];
  cells.forEach((cell, i) => {
    const wasRed = playerRole === 'blue' ? i >= previous : i < previous;
    const isRed = playerRole === 'blue' ? i >= position : i < position;
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
function updateClockLocal() { $('match-clock').textContent = inOvertime ? '延長' : config.matchTime === 0 ? '∞' : formatTime(matchRemaining); }
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
    li.style.setProperty('--underline-delay', `${index * 0.12}s`);
    const number = document.createElement('span'); number.className = 'history-number'; number.textContent = String(index + 1).padStart(2, '0');
    const content = document.createElement('span'); content.className = 'history-content';
    const word = document.createElement('strong'); word.textContent = entry.unanswered ? `問題：${entry.pattern}` : entry.word;
    if (!entry.unanswered) word.classList.add(entry.who === 'red' ? 'history-word-red' : 'history-word-blue');
    const forms = document.createElement('small');
    if (entry.unanswered) {
      forms.textContent = `候補：${(entry.candidates || []).join(' ・ ') || '候補なし'}`;
    } else {
      const candidates = [...new Set(entry.forms || [])];
      forms.textContent = candidates.length > 3 ? `${candidates.slice(0, 3).join(' ・ ')} ほか${candidates.length - 3}件` : candidates.join(' ・ ') || '表記候補なし';
    }
    content.append(word, forms);
    if (!entry.unanswered) {
      const selectedMeaning = entry.selectedMeaning || pickRandomMeaning(entry.word, entry.forms || []);
      if (selectedMeaning) {
        const fullText = selectedMeaning;
        const definition = document.createElement('small');
        definition.className = 'history-definition';
        const chars = Array.from(fullText);
        const hasToggle = chars.length > 25;
        const collapsedText = hasToggle ? chars.slice(0, 25).join('') + '…' : fullText;
        definition.textContent = collapsedText;
        content.append(definition);
        if (hasToggle) {
          const toggle = document.createElement('button');
          toggle.type = 'button';
          toggle.className = 'history-definition-toggle';
          toggle.textContent = '▼';
          toggle.setAttribute('aria-expanded', 'false');
          toggle.setAttribute('aria-label', `${entry.word}の意味を全文表示`);
          toggle.addEventListener('click', () => {
            const expanded = toggle.getAttribute('aria-expanded') !== 'true';
            definition.textContent = expanded ? fullText : collapsedText;
            definition.classList.toggle('is-expanded', expanded);
            toggle.textContent = expanded ? '▲' : '▼';
            toggle.setAttribute('aria-expanded', String(expanded));
            toggle.setAttribute('aria-label', `${entry.word}の意味を${expanded ? '折りたたむ' : '全文表示'}`);
          });
          content.append(toggle);
        }
      }
    }
    const links = document.createElement('span');
    links.className = 'history-links';
    if (!entry.unanswered) {
      const sourceWord = (entry.forms || [])[0] || entry.word;
      const meaning = document.createElement('a');
      meaning.className = 'history-meaning-link'; meaning.textContent = '辞書 ↗';
      meaning.href = 'https://ja.wiktionary.org/wiki/' + encodeURIComponent(sourceWord);
      meaning.target = '_blank'; meaning.rel = 'noopener noreferrer'; meaning.setAttribute('aria-label', `${entry.word}の辞書ページを開く`);
      const wikipedia = document.createElement('a');
      wikipedia.className = 'history-meaning-link wikipedia-link';
      wikipedia.textContent = 'Wikipedia ↗';
      wikipedia.href = 'https://ja.wikipedia.org/wiki/' + encodeURIComponent(sourceWord);
      wikipedia.target = '_blank'; wikipedia.rel = 'noopener noreferrer';
      wikipedia.setAttribute('aria-label', `${sourceWord}のWikipediaページを開く`);
      links.append(meaning, wikipedia);
    }
    li.append(number, content, links); list.append(li);
  });
}
async function showEndOverlay() {
  // Load all meaning sources needed by this match before revealing the results.
  await loadMeaningDictionary();
  await loadWikipediaMeaningsForHistory(gameHistory);
  renderGameHistory();
  const overlay = $('end-overlay');
  overlay.classList.remove('hidden', 'result-fade-in');
  void overlay.offsetWidth;
  overlay.classList.add('result-fade-in');
}
function endGame(title, detail) {
  if (online) return;
  if (!questionRecorded && currentAnswer) recordUnanswered('試合終了');
  gameEnded = true; stopTimers();
  currentPattern = '';
  $('pattern-desktop').textContent = ''; $('pattern-mobile').textContent = '';
  if ($('pattern-mobile-below')) $('pattern-mobile-below').textContent = '';
  $('answer').disabled = true; $('pass-button').disabled = true;
  $('end-title').textContent = title; $('end-detail').textContent = detail;
  showEndOverlay();
}
let successMeaningRequest = 0;
function showSuccess(word, formsOverride = null) {
  const forms = [...new Set(formsOverride || dictionary?.[word] || [])];
  const requestId = ++successMeaningRequest;
  $('success-reading').textContent = word;
  $('success-forms').textContent = forms.slice(0, 10).join(' ・ ') || '表記候補なし';
  const meaning = $('success-meaning');
  meaning.textContent = '';
  meaning.classList.add('hidden');
  const banner = $('success-banner'); banner.classList.remove('show'); void banner.offsetWidth; banner.classList.add('show');
  loadMeaningsForWord(word, forms).then(selected => {
    if (requestId !== successMeaningRequest || $('success-reading').textContent !== word || !selected) return;
    meaning.textContent = selected;
    meaning.classList.remove('hidden');
  }).catch(error => console.error('正解語の意味表示に失敗しました', error));
}
function acceptAnswer(word, who = 'red') {
  if (gameEnded) return;
  if (!dictionary) { $('answer-message').textContent = '辞書を読み込めていません。'; return; }
  if (!/^[ぁ-ゖー]+$/.test(word)) { $('answer-message').textContent = 'ひらがなで入力してください。'; return; }
  if (!matchesPattern(word, currentPattern)) { $('answer-message').textContent = '文字数、または公開された文字が合っていません。'; return; }
  if (!dictionary[word]) { $('answer-message').textContent = '辞書にない読みです。別の言葉を試してください。'; return; }
  if (usedAnswerWords.has(word) || (usedQuestionWords.has(word) && word !== currentAnswer)) { $('answer-message').textContent = 'この試合ですでに使われた言葉です。別の言葉を試してください。'; return; }
  questionRecorded = true; usedAnswerWords.add(word); gameHistory.push({ word, who, forms: [...new Set(dictionary[word] || [])] }); showSuccess(word);
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
  usedQuestionWords = new Set(); usedAnswerWords = new Set();
  $('answer').disabled = false; $('pass-button').disabled = false;
  currentAnswer = ''; currentPattern = ''; questionRecorded = false;
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
async function cleanupOnlineRoom() {
  const code = roomCode, token = roomToken;
  if (code && token) {
    try {
      await fetch(`/api/rooms/${encodeURIComponent(code)}/cleanup`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token })
      });
    } catch (error) { console.warn('Room cleanup request failed', error); }
  }
  disconnectOnline();
}
function resetRoomUi() {
  if (countdownTimer) clearTimeout(countdownTimer); countdownTimer = null; countdownRunning = false;
  $('countdown-overlay')?.classList.add('hidden');
  $('answer').disabled = false;
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const key = sessionStorage.key(i);
      if (key && key.startsWith('egoism-room:')) sessionStorage.removeItem(key);
    }
  } catch {}
  roomCode = ''; roomToken = ''; playerRole = ''; lastServerState = null;
  lastQuestionId = 0; lastSuccessKey = ''; gameHistory = []; currentPattern = ''; currentAnswer = '';
  gameEnded = false; inOvertime = false; questionRecorded = false; position = 3;
  $('room-created').classList.add('hidden'); $('room-code').textContent = '—';
  $('room-id').value = ''; $('room-message').textContent = '';
  $('create-room').disabled = false; $('create-room').textContent = '部屋を作成';
  $('end-overlay').classList.add('hidden'); $('game-history').replaceChildren();
  $('success-banner').classList.remove('show'); $('success-reading').textContent = ''; $('success-forms').textContent = '';
  $('answer').value = ''; $('answer-message').textContent = '盤面を押して勝利を目指そう。';
  $('match-room-label').textContent = 'LOCAL PREVIEW'; matchRemaining = 300; questionRemaining = 120;
  updateBoard(3, false); updateClockLocal();
}

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
  socket.addEventListener('close', event => { if (online && !gameEnded) setRoomMessage(event.reason === 'room-cleaned' ? '部屋が終了しました。' : 'サーバーとの接続が切れました。部屋IDを使って再接続してください。'); });
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
function startCountdown() {
  if (countdownRunning) return;
  countdownRunning = true;
  $('answer').disabled = true;
  $('countdown-overlay').classList.remove('hidden');
  const glyph = $('countdown-glyph');
  const sequence = ['参', '弐', '壱'];
  let index = 0;
  const showNext = () => {
    if (index >= sequence.length) {
      glyph.animate([{ opacity: 1, transform: 'scale(1.18)' }, { opacity: 0, transform: 'scale(1.65)' }], { duration: 650, easing: 'ease-out', fill: 'forwards' });
      countdownTimer = setTimeout(() => {
        $('countdown-overlay').classList.add('hidden');
        countdownRunning = false; countdownTimer = null; $('answer').disabled = false;
        if (!gameEnded && online) $('answer').focus({ preventScroll: true });
      }, 650);
      return;
    }
    glyph.textContent = sequence[index++];
    glyph.getAnimations().forEach(a => a.cancel());
    glyph.animate([{ opacity: 0, transform: 'scale(.45)' }, { opacity: 1, transform: 'scale(1.08)', offset: .68 }, { opacity: 0, transform: 'scale(1.42)' }], { duration: 900, easing: 'cubic-bezier(.2,.75,.25,1)', fill: 'forwards' });
    countdownTimer = setTimeout(showNext, 900);
  };
  showNext();
}
function applyServerState(state) {
  const oldState = lastServerState;
  const oldVisualPosition = oldState ? (playerRole === 'blue' ? 6 - oldState.position : oldState.position) : (playerRole === 'blue' ? 6 - state.position : state.position);
  const wasEnded = !!oldState?.ended;
  // A rematch starts a fresh match. Clear the previous winning word even if the
  // server resets questionId to a value that matches the previous match.
  if (wasEnded && !state.ended) {
    lastQuestionId = 0;
    lastSuccessKey = '';
    $('success-banner').classList.remove('show');
    $('success-reading').textContent = '';
    $('success-forms').textContent = '';
  }
  lastServerState = state;
  position = playerRole === 'blue' ? 6 - state.position : state.position;
  config = state.config || config;
  currentPattern = state.pattern || ''; gameEnded = state.ended; inOvertime = state.inOvertime;
  matchDeadline = state.matchDeadline || 0; questionDeadline = state.questionDeadline || 0;
  const ownColor = playerRole === 'blue' ? '青' : '赤';
  const enemyColor = playerRole === 'blue' ? '赤' : '青';
  $('match-room-label').textContent = `${roomCode} / ${state.started ? ownColor : '相手待ち'}`;
  $('board').classList.toggle('view-blue', playerRole === 'blue');
  $('board').parentElement.querySelector('.own-side-label').innerHTML = `自陣 <b class="${playerRole === 'blue' ? 'blue-text' : 'red-text'}">${ownColor}</b>`;
  $('board').parentElement.querySelector('.enemy-side-label').innerHTML = `敵陣 <b class="${playerRole === 'blue' ? 'red-text' : 'blue-text'}">${enemyColor}</b>`;
  if (state.started && (!oldState?.started || (wasEnded && !state.ended))) startCountdown();
  if (!state.started) { setRoomMessage(state.players?.blue?.connected ? '対戦を準備しています…' : '相手の参加を待っています…'); $('answer-message').textContent = '相手が参加すると対戦が始まります。'; return; }
  setRoomMessage('対戦中です。部屋IDを共有している相手と接続中です。');
  if (!$('battle').classList.contains('active')) goTo('battle');
  $('end-overlay').classList.add('hidden');
  const visiblePattern = state.ended ? '' : currentPattern;
  $('pattern-desktop').textContent = visiblePattern; $('pattern-mobile').textContent = visiblePattern; if ($('pattern-mobile-below')) $('pattern-mobile-below').textContent = visiblePattern;
  $('answer').disabled = !!state.ended; $('pass-button').disabled = !!state.ended;
  if (state.questionId !== lastQuestionId) { lastQuestionId = state.questionId; animateQuestionText(); $('answer').value = ''; }
  updateBoard(oldVisualPosition, oldVisualPosition !== position);
  if (state.lastSuccess) {
    const key = `${state.lastSuccess.reading}:${state.lastSuccess.questionId}`;
    if (key !== lastSuccessKey) { lastSuccessKey = key; showSuccess(state.lastSuccess.reading, state.lastSuccess.forms); }
  }
  gameHistory = state.history || [];
  if (state.passed?.length) $('answer-message').textContent = state.passed.includes(playerRole) ? 'パス済みです。相手のパスを待っています。' : '相手がパスしました。パスするか、回答してください。';
  else $('answer-message').textContent = inOvertime ? '延長戦！ 次の正解で決着します。' : '表示された文字に合う読みを入力してください。';
  if (state.ended) {
    stopTimers(); const winner = state.result?.winner; $('end-title').textContent = winner === null || winner === undefined ? '引き分け' : winner === playerRole ? 'エ語彙スト！' : '相手がエ語彙スト！';
    const opponentRole = playerRole === 'red' ? 'blue' : 'red';
    const opponentConnected = !!state.players?.[opponentRole]?.connected;
    const votes = state.rematchVotes || {};
    const rematchButton = $('rematch');
    if (!opponentConnected) {
      $('end-detail').textContent = '相手が部屋を退出しました。再戦するには新しい部屋を作成してください。';
      rematchButton.disabled = true; rematchButton.textContent = '相手が退出しました';
    } else if (votes[playerRole]) {
      $('end-detail').textContent = votes[opponentRole] ? '再戦を準備しています…' : '再戦を申し込みました。相手が押すのを待っています。';
      rematchButton.disabled = true; rematchButton.textContent = '再戦を待っています…';
    } else {
      $('end-detail').textContent = state.result?.detail || '対戦が終了しました。';
      rematchButton.disabled = false; rematchButton.textContent = '再戦';
    }
    showEndOverlay();
  } else {
    $('end-overlay').classList.add('hidden'); $('rematch').disabled = false; $('rematch').textContent = '再戦';
  }
  if (!clockTimer) clockTimer = setInterval(updateOnlineClock, 250);
  updateOnlineClock();
}
function updateOnlineClock() {
  if (!online || !lastServerState) return;
  const now = Date.now();
  const match = matchDeadline ? Math.min(config.matchTime || Infinity, Math.max(0, Math.ceil((matchDeadline - now) / 1000))) : 0;
  const question = questionDeadline ? Math.min(config.questionTime || Infinity, Math.max(0, Math.ceil((questionDeadline - now) / 1000))) : 0;
  $('match-clock').textContent = lastServerState.inOvertime ? '延長' : config.matchTime === 0 ? '∞' : formatTime(match);
  questionRemaining = questionDeadline ? question : 0;
}

function katakanaToHiragana(value) {
  return [...value].map(ch => {
    const code = ch.charCodeAt(0);
    return code >= 0x30A1 && code <= 0x30F6 ? String.fromCharCode(code - 0x60) : ch;
  }).join('');
}
function findMeaning(reading, forms) {
  for (const form of forms) {
    const defs = meaningDictionary?.[reading]?.[form];
    if (defs?.length) return [...new Set(defs)].join(' ／ ');
  }
  for (const form of forms) {
    const defs = wikipediaMeaningDictionary?.[reading]?.[form];
    if (defs?.length) return [...new Set(defs)].join(' ／ ');
  }
  return '';
}
async function lookupHomeWord() {
  const input = $('dictionary-search-input');
  const output = $('dictionary-search-results');
  const query = input.value.trim();
  output.replaceChildren();
  if (!query) { output.textContent = '言葉を入力してください。'; return; }
  if (!dictionary) { output.textContent = '辞書を読み込み中です。少し待ってからお試しください。'; return; }
  const kanaQuery = katakanaToHiragana(query);
  let matches = [];
  if (/^[ぁ-ゖー]+$/.test(kanaQuery) && dictionary[kanaQuery]) {
    matches = [{ reading: kanaQuery, forms: [...new Set(dictionary[kanaQuery])] }];
  } else {
    for (const reading in dictionary) {
      const forms = dictionary[reading];
      if (Array.isArray(forms) && forms.includes(query)) matches.push({ reading, forms: [query] });
      if (matches.length >= 30) break;
    }
  }
  if (!matches.length) { output.textContent = '辞書に見つかりませんでした。'; return; }
  await loadMeaningDictionary();
  const wikiEntries = matches.filter(item => !findMeaning(item.reading, item.forms)).map(item => ({ word: item.reading, forms: item.forms }));
  if (wikiEntries.length) await loadWikipediaMeaningsForHistory(wikiEntries);
  for (const item of matches.slice(0, 10)) {
    const row = document.createElement('article'); row.className = 'dictionary-result-row';
    const heading = document.createElement('strong'); heading.textContent = item.forms.join(' ・ ');
    const reading = document.createElement('small'); reading.textContent = `読み：${item.reading}`;
    row.append(heading, reading);
    const meaning = findMeaning(item.reading, item.forms);
    if (meaning) { const description = document.createElement('p'); description.textContent = meaning; row.append(description); }
    output.append(row);
  }
  if (matches.length > 10) { const more = document.createElement('p'); more.className = 'dictionary-search-note'; more.textContent = `ほか ${matches.length - 10} 件の候補があります。`; output.append(more); }
}
$('dictionary-search-form').addEventListener('submit', event => { event.preventDefault(); lookupHomeWord(); });

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
$('rematch').addEventListener('click', () => { if (online) { if (lastServerState?.ended) { sendOnline('rematch'); $('rematch').disabled = true; $('rematch').textContent = '再戦を待っています…'; $('end-detail').textContent = '再戦を申し込みました。相手が押すのを待っています。'; } } else startDemo(); });
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
