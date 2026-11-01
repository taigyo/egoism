'use strict';
const screens = [...document.querySelectorAll('.screen')];
const $ = id => document.getElementById(id);
let dictionary = null;
let properNounReadings = new Set();
let wordDifficultyMap = {};
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
let reconnectTimer = null;
let heartbeatTimer = null;
let heartbeatWatchdog = null;
let reconnectAttempts = 0;
let answerComposing = false;
let lastCompositionEnd = 0;
let answerSubmissionPending = false;
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
}
document.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', async () => {
  if (online && b.dataset.go !== 'battle') {
    disconnectOnline();
    resetRoomUi();
  }
  stopTimers();
  goTo(b.dataset.go);
}));

let homeDriftStarted = false;
function animateHomeTitle() {
  const title = document.querySelector('.home-title');
  if (!title || title.dataset.letterAnimated === 'true') return;
  title.dataset.letterAnimated = 'true';
  const chars = Array.from(title.textContent);
  title.replaceChildren();
  chars.forEach((character, index) => {
    const glyph = document.createElement('span');
    glyph.textContent = character;
    glyph.className = 'home-title-glyph';
    glyph.style.setProperty('--glyph-index', index);
    if (character === '。') glyph.classList.add('title-period');
    title.append(glyph);
  });
}

async function initHomeWordDrift() {
  const layer = $('home-word-drift');
  if (!layer || !dictionary || homeDriftStarted || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  homeDriftStarted = true;
  animateHomeTitle();
  await loadMeaningDictionary();
  const keys = Object.keys(dictionary);
  const pool = [];
  const seenForms = new Set();
  const maxAttempts = Math.min(keys.length * 2, 350000);
  for (let attempt = 0; attempt < maxAttempts && pool.length < 500; attempt++) {
    const reading = keys[Math.floor(Math.random() * keys.length)];
    const forms = dictionary[reading] || [];
    const eligible = forms.filter(form => !seenForms.has(form) && meaningDictionary?.[reading]?.[form]?.length);
    if (!eligible.length) continue;
    const form = eligible[Math.floor(Math.random() * eligible.length)];
    const meaning = pickRandomMeaning(reading, [form]);
    if (!meaning) continue;
    seenForms.add(form);
    pool.push({ reading, form, meaning });
    if (attempt % 5000 === 4999) await new Promise(resolve => requestAnimationFrame(resolve));
  }
  if (pool.length < 500) {
    for (const reading of keys) {
      if (pool.length >= 500) break;
      const form = (dictionary[reading] || []).find(item => !seenForms.has(item) && meaningDictionary?.[reading]?.[item]?.length);
      if (!form) continue;
      const meaning = pickRandomMeaning(reading, [form]);
      if (!meaning) continue;
      seenForms.add(form);
      pool.push({ reading, form, meaning });
      if (pool.length % 100 === 0) await new Promise(resolve => requestAnimationFrame(resolve));
    }
  }
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  if (!pool.length) return;
  let index = 0;
  const occupied = [];
  const spawn = () => {
    if (!layer.isConnected || !$('home')?.classList.contains('active')) {
      window.setTimeout(spawn, 500);
      return;
    }
    const data = pool[index];
    index = (index + 1) % pool.length;
    if (index === 0) {
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
    }
    const item = document.createElement('span');
    const layout = Math.random();
    const vertical = layout < 0.25;
    const lShape = layout >= 0.25 && layout < 0.43;
    const variedLetters = Math.random() < 0.2;
    item.className = `drift-word${vertical ? ' is-vertical' : ''}${lShape ? ' is-lshape' : ''}${variedLetters ? ' varied-letters' : ''}`;
    let x = 8 + Math.random() * 78;
    let y = 10 + Math.random() * 72;
    for (let attempt = 0; attempt < 18; attempt++) {
      const candidateX = 8 + Math.random() * 78;
      const candidateY = 10 + Math.random() * 72;
      if (occupied.every(pos => Math.hypot((candidateX - pos.x) * 0.75, candidateY - pos.y) > 22)) {
        x = candidateX; y = candidateY; break;
      }
    }
    occupied.push({ x, y });
    if (occupied.length > 24) occupied.shift();
    item.style.left = `${x}%`;
    item.style.top = `${y}%`;
    item.style.setProperty('--word-size', `${20 + Math.random() * 26}px`);
    item.style.setProperty('--meaning-size', `${10 + Math.random() * 7}px`);
    item.style.setProperty('--letter-gap', `${0.16 + Math.random() * 0.38}em`);
    item.style.setProperty('--drift-opacity', `${0.2 + Math.random() * 0.22}`);
    item.style.setProperty('--drift-x', `${(Math.random() - 0.5) * 3}vw`);
    item.style.setProperty('--drift-y', `${(Math.random() - 0.5) * 3}vh`);
    const word = document.createElement('strong');
    if (variedLetters) {
      for (const character of Array.from(data.form)) {
        const glyph = document.createElement('span');
        glyph.textContent = character;
        glyph.style.fontSize = `${0.72 + Math.random() * 0.58}em`;
        glyph.style.display = 'inline-block';
        glyph.style.transform = `translateY(${Math.random() * 5 - 2.5}px)`;
        word.append(glyph);
      }
    } else word.textContent = data.form;
    const definition = document.createElement('small');
    definition.textContent = data.meaning;
    definition.setAttribute('aria-hidden', 'true');
    item.append(word);
    layer.append(item);
    requestAnimationFrame(() => item.classList.add('settled'));
    const meaningDelay = 500 + Math.random() * 6500;
    window.setTimeout(() => {
      if (!item.isConnected) return;
      item.append(definition);
      item.classList.add('has-meaning');
      window.setTimeout(() => {
        if (!item.isConnected) return;
        item.classList.add('ink-fade');
        window.setTimeout(() => item.remove(), 1500);
      }, 2000);
    }, meaningDelay);
    window.setTimeout(spawn, 400 + Math.random() * 5600);
  };
  window.setTimeout(spawn, 1800);
}

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
      const difficultyResponse = await fetch('/data/word-difficulty.json');
      if (difficultyResponse.ok) wordDifficultyMap = await difficultyResponse.json();
      else throw Error(`HTTP ${difficultyResponse.status}`);
    } catch (error) { console.warn('難易度データを読み込めませんでした。未収録語は上級として扱います。', error); }
    try {
      const properResponse = await fetch('/data/proper-noun-readings.json');
      if (properResponse.ok) properNounReadings = new Set(await properResponse.json());
    } catch (error) { console.warn('固有名詞候補リストを読み込めませんでした', error); }
    initHomeWordDrift();
  } catch (e) {
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
    const forms = [...new Set(entry.forms?.length ? entry.forms : (dictionary?.[entry.word] || []))];
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
const ROMAJI_BASE = {
  a:'あ',i:'い',u:'う',e:'え',o:'お', ka:'か',ki:'き',ku:'く',ke:'け',ko:'こ',
  sa:'さ',si:'し',su:'す',se:'せ',so:'そ',ta:'た',ti:'ち',tu:'つ',te:'て',to:'と',
  na:'な',ni:'に',nu:'ぬ',ne:'ね',no:'の',ha:'は',hi:'ひ',hu:'ふ',he:'へ',ho:'ほ',
  ma:'ま',mi:'み',mu:'む',me:'め',mo:'も',ya:'や',yu:'ゆ',yo:'よ',
  ra:'ら',ri:'り',ru:'る',re:'れ',ro:'ろ',wa:'わ',wo:'を',
  ga:'が',gi:'ぎ',gu:'ぐ',ge:'げ',go:'ご',za:'ざ',zi:'じ',ji:'じ',zu:'ず',ze:'ぜ',zo:'ぞ',
  da:'だ',di:'ぢ',du:'づ',de:'で',do:'ど',ba:'ば',bi:'び',bu:'ぶ',be:'べ',bo:'ぼ',
  pa:'ぱ',pi:'ぴ',pu:'ぷ',pe:'ぺ',po:'ぽ',
  kya:'きゃ',kyu:'きゅ',kyo:'きょ',gya:'ぎゃ',gyu:'ぎゅ',gyo:'ぎょ',sha:'しゃ',shu:'しゅ',sho:'しょ',
  sya:'しゃ',syu:'しゅ',syo:'しょ',ja:'じゃ',ju:'じゅ',jo:'じょ',jya:'じゃ',jyu:'じゅ',jyo:'じょ',
  cha:'ちゃ',chu:'ちゅ',cho:'ちょ',tya:'ちゃ',tyu:'ちゅ',tyo:'ちょ',nya:'にゃ',nyu:'にゅ',nyo:'にょ',
  hya:'ひゃ',hyu:'ひゅ',hyo:'ひょ',mya:'みゃ',myu:'みゅ',myo:'みょ',rya:'りゃ',ryu:'りゅ',ryo:'りょ',
  bya:'びゃ',byu:'びゅ',byo:'びょ',pya:'ぴゃ',pyu:'ぴゅ',pyo:'ぴょ',
  fa:'ふぁ',fi:'ふぃ',fe:'ふぇ',fo:'ふぉ',wi:'うぃ',we:'うぇ',she:'しぇ',je:'じぇ',che:'ちぇ',shi:'し',chi:'ち',tsu:'つ',
  tsa:'つぁ',tsi:'つぃ',tse:'つぇ',tso:'つぉ',va:'ゔぁ',vi:'ゔぃ',vu:'ゔ',ve:'ゔぇ',vo:'ゔぉ'
};
function romanToHiragana(input, finalize = false) {
  const text = String(input || '').normalize('NFKC').toLowerCase();
  if (text === 'konnichiwa') return 'こんにちは';
  let out = '';
  for (let i = 0; i < text.length;) {
    const ch = text[i];
    if (/[ぁ-ゖー]/.test(ch)) { out += ch; i++; continue; }
    if (/[ァ-ヶ]/.test(ch)) { out += String.fromCharCode(ch.charCodeAt(0) - 0x60); i++; continue; }
    if (ch === '-') { out += 'ー'; i++; continue; }
    if (!/[a-z']/.test(ch)) { i++; continue; }
    const rest = text.slice(i);
    if (ch === 'n') {
      if (rest.startsWith("n'") ) { out += 'ん'; i += 2; continue; }
      if (rest.length === 1) { if (finalize) out += 'ん'; else out += 'n'; i++; continue; }
      if (rest[1] === 'n') {
        if (rest.length === 2) { if (finalize) { out += 'ん'; i += 2; continue; } out += rest; break; }
        if (!/[yaeiou]/.test(rest[2] || '')) { out += 'ん'; i += 2; continue; }
        out += 'ん'; i++; continue;
      }
      if (!/[yaeiou]/.test(rest[1])) { out += 'ん'; i++; continue; }
    }
    if (rest.length >= 2 && rest[0] === rest[1] && /^[bcdfghjklmpqrstvwxyz]$/.test(ch)) { out += 'っ'; i++; continue; }
    let matched = false;
    for (let size = Math.min(3, rest.length); size >= 1; size--) {
      const token = rest.slice(0, size);
      if (ROMAJI_BASE[token]) { out += ROMAJI_BASE[token]; i += size; matched = true; break; }
    }
    if (matched) continue;
    const isPrefix = Object.keys(ROMAJI_BASE).some(token => token.startsWith(rest));
    if (isPrefix) { out += rest; break; }
    i++;
  }
  return out;
}
function normalizeInput(value, finalize = false) {
  const normalized = romanToHiragana(value, finalize);
  return normalized === 'こんにちわ' ? 'こんにちは' : normalized;
}

function classifyWordDifficulty(reading, forms = []) {
  // The precomputed map uses corpus frequency and metadata. Missing readings default to advanced.
  return wordDifficultyMap[String(reading || '')] || 'advanced';
}
function difficultyLabel(level) {
  return ({ beginner: '初級', intermediate: '中級', advanced: '上級', unlimited: '無制限' })[level] || '上級';
}
function difficultyClass(level) { return `difficulty-badge difficulty-${level || 'advanced'}`; }
function matchesDifficulty(reading, forms, difficulty) {
  return difficulty === 'unlimited' || classifyWordDifficulty(reading, forms) === difficulty;
}
function matchesPattern(word, pattern) {
  return [...word].length === [...pattern].length && [...pattern].every((ch, i) => ch === '〇' || ch === [...word][i]);
}
function questionTierForCount(count) {
  if (count >= 20) return 'beginner';
  if (count >= 5) return 'intermediate';
  return count >= 1 ? 'advanced' : 'none';
}
function matchesQuestionTier(count, requested) {
  return requested === 'unlimited' || questionTierForCount(count) === requested;
}
function makePatternForAnswer(answer, low, high) {
  const chars = [...answer];
  const revealCount = Math.min(chars.length, low + Math.floor(Math.random() * (high - low + 1)));
  const indexes = chars.map((_, i) => i).sort(() => Math.random() - .5).slice(0, revealCount);
  const pattern = [...'〇'.repeat(chars.length)];
  indexes.forEach(i => pattern[i] = chars[i]);
  return pattern.join('');
}
function countLocalSolutions(pattern, eligible, used, limit = 20) {
  let count = 0;
  for (const word of eligible) {
    if (!used.has(word) && matchesPattern(word, pattern) && ++count >= limit) return count;
  }
  return count;
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
  const eligible = Object.keys(dictionary).filter(w => /^[ぁ-ゖー]+$/.test(w) && w.length >= config.lengthMin && w.length <= config.lengthMax);
  if (!eligible.length) { $('answer-message').textContent = 'この文字数に合う単語がありません。文字数設定を変えてください。'; return; }
  const eligibleByLength = {};
  for (const word of eligible) (eligibleByLength[word.length] ||= []).push(word);
  const available = eligible.filter(w => !usedQuestionWords.has(w) && !usedAnswerWords.has(w));
  if (!available.length) {
    currentAnswer = ''; currentPattern = '';
    $('pattern-desktop').textContent = ''; $('pattern-mobile').textContent = '';
    if ($('pattern-mobile-below')) $('pattern-mobile-below').textContent = '';
    endGame('語彙切れ', 'この試合で使える言葉がなくなりました。');
    return;
  }
  const revealedLow = Math.min(config.revealedMin ?? 1, config.revealedMax ?? 3);
  const revealedHigh = Math.max(config.revealedMin ?? 1, config.revealedMax ?? 3);
  let chosen = null, chosenPattern = '', chosenCount = 0, bestDistance = Infinity;
  for (let attempt = 0; attempt < 150; attempt++) {
    const answer = available[Math.floor(Math.random() * available.length)];
    const pattern = makePatternForAnswer(answer, (config.difficulty || 'unlimited') === 'advanced' ? revealedHigh : revealedLow, revealedHigh);
    const count = countLocalSolutions(pattern, eligibleByLength[answer.length] || [], new Set([...usedAnswerWords, ...usedQuestionWords]), (config.difficulty || 'unlimited') === 'advanced' ? 5 : 20);
    const requested = config.difficulty || 'unlimited';
    const distance = requested === 'unlimited' ? 0 : requested === 'beginner' ? Math.max(0, 20 - count) : requested === 'intermediate' ? (count >= 5 && count < 20 ? 0 : count < 5 ? 5 - count : count - 19) : Math.max(0, count - 4);
    if (distance < bestDistance) { chosen = answer; chosenPattern = pattern; chosenCount = count; bestDistance = distance; }
    if (matchesQuestionTier(count, requested)) break;
  }
  if (!chosen || chosenCount < 1) { $('answer-message').textContent = '解答候補のある問題を準備できませんでした。設定を変えてください。'; return; }
  currentAnswer = chosen;
  usedQuestionWords.add(currentAnswer);
  currentPattern = chosenPattern;
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
  const candidates = Object.keys(dictionary).filter(w => /^[ぁ-ゖー]+$/.test(w) && matchesPattern(w, currentPattern) && ((!usedAnswerWords.has(w) && !usedQuestionWords.has(w)) || w === currentAnswer));
  if (!candidates.includes(currentAnswer)) candidates.unshift(currentAnswer);
  const easyOrder = { beginner: 0, intermediate: 1, advanced: 2 };
  candidates.sort((a, b) => (easyOrder[classifyWordDifficulty(a)] ?? 2) - (easyOrder[classifyWordDifficulty(b)] ?? 2) || Math.random() - .5);
  gameHistory.push({ unanswered: true, pattern: currentPattern, reason, candidates: candidates.slice(0, 5), solutionCount: candidates.length, who: 'none', word: '未回答の問題' });
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
    const entryForms = !entry.unanswered ? (entry.forms?.length ? entry.forms : (dictionary?.[entry.word] || [])) : [];
    if (entry.unanswered) {
      let unansweredCandidates = [...new Set(entry.candidates || [])];
      let solutionCount = entry.solutionCount || 0;
      if (!unansweredCandidates.length && dictionary && entry.pattern) {
        const matches = Object.keys(dictionary).filter(candidate => /^[ぁ-ゖー]+$/.test(candidate) && matchesPattern(candidate, entry.pattern));
        solutionCount = matches.length;
        unansweredCandidates = matches.slice(0, 5);
      }
      const countLabel = solutionCount ? `（${solutionCount >= 20 ? '20件以上' : `${solutionCount}件`}）` : '';
      forms.textContent = `候補：${unansweredCandidates.join(' ・ ') || '候補なし（辞書に一致する読みがありません）'}${countLabel}`;
    } else {
      const candidates = [...new Set(entryForms)];
      const selectedForm = entry.selectedForm || chooseDisplayForm(candidates);
      entry.selectedForm = selectedForm;
      if (selectedForm) {
        const google = document.createElement('a');
        google.className = 'history-google-link';
        google.textContent = selectedForm;
        google.href = `https://www.google.com/search?q=${encodeURIComponent(selectedForm)}`;
        google.target = '_blank';
        google.rel = 'noopener noreferrer';
        google.setAttribute('aria-label', `${selectedForm}をGoogleで検索（新しいタブ）`);
        forms.append(google);
        if (candidates.length <= 3) {
          const remaining = candidates.filter(form => form !== selectedForm);
          if (remaining.length) forms.append(document.createTextNode(` ・ ${remaining.join(' ・ ')}`));
        } else {
          const others = Math.max(0, candidates.length - 1);
          if (others) forms.append(document.createTextNode(` ほか ${others}件`));
        }
      } else {
        forms.textContent = '表記候補なし';
      }
    }
    if (!entry.unanswered) {
      const wordRow = document.createElement('div');
      wordRow.className = 'history-word-row';
      const level = classifyWordDifficulty(entry.word, entryForms);
      const difficulty = document.createElement('small');
      difficulty.className = difficultyClass(level);
      difficulty.textContent = difficultyLabel(level);
      wordRow.append(word, difficulty);
      content.append(wordRow, forms);
    } else {
      content.append(word, forms);
    }
    if (!entry.unanswered) {
      const selectedMeaning = entry.selectedMeaning || (entry.selectedForm ? pickRandomMeaning(entry.word, [entry.selectedForm]) : '');
      entry.selectedMeaning = selectedMeaning;
      if (selectedMeaning) {
        const fullText = selectedMeaning;
        const definition = document.createElement('small');
        definition.className = 'history-definition';
        const chars = Array.from(fullText);
        const hasToggle = chars.length > 25;
        const collapsedText = hasToggle ? chars.slice(0, 25).join('') + '…' : fullText;
        definition.textContent = `→ ${collapsedText}`;
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
            definition.textContent = `→ ${expanded ? fullText : collapsedText}`;
            definition.classList.toggle('is-expanded', expanded);
            toggle.textContent = expanded ? '▲' : '▼';
            toggle.setAttribute('aria-expanded', String(expanded));
            toggle.setAttribute('aria-label', `${entry.word}の意味を${expanded ? '折りたたむ' : '全文表示'}`);
          });
          content.append(toggle);
        }
      }
    }
    li.append(number, content);
    list.append(li);
  });
}
async function showEndOverlay() {
  // Load all meaning sources needed by this match before revealing the results.
  await loadMeaningDictionary();
  await loadWikipediaMeaningsForHistory(gameHistory);
  for (const entry of gameHistory) {
    if (!entry || entry.unanswered) continue;
    const forms = [...new Set(entry.forms?.length ? entry.forms : (dictionary?.[entry.word] || []))];
    if (!entry.selectedForm || !entry.selectedMeaning) {
      const selected = await chooseDisplayFormWithMeaning(entry.word, forms);
      if (!entry.selectedForm) entry.selectedForm = selected.selectedForm;
      if (!entry.selectedMeaning) entry.selectedMeaning = selected.selectedMeaning;
    }
  }
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
function clearSuccessDisplay() {
  successMeaningRequest++;
  $('success-banner').classList.remove('show');
  $('success-reading').textContent = '';
  $('success-forms').textContent = '';
  $('success-meaning').textContent = '';
  $('success-meaning').classList.add('hidden');
}
function formatSelectedForm(forms, selectedForm) {
  const unique = [...new Set((forms || []).filter(Boolean))];
  if (!unique.length) return '表記候補なし';
  if (unique.length <= 3) return unique.join(' ・ ');
  const others = Math.max(0, unique.length - 1);
  return `${selectedForm || unique[0]}${others ? ` ほか ${others}件` : ''}`;
}
function chooseDisplayForm(forms) {
  const unique = [...new Set((forms || []).filter(Boolean))];
  return unique.length ? unique[Math.floor(Math.random() * unique.length)] : '';
}
async function chooseDisplayFormWithMeaning(reading, forms) {
  const unique = [...new Set((forms || []).filter(Boolean))];
  await loadMeaningDictionary();
  await loadWikipediaMeaningsForHistory([{ word: reading, forms: unique }]);
  const withMeanings = unique.filter(form => collectMeaningDefinitions(reading, [form]).length);
  const selectedForm = chooseDisplayForm(withMeanings.length ? withMeanings : unique);
  return { selectedForm, selectedMeaning: selectedForm ? pickRandomMeaning(reading, [selectedForm]) : '' };
}
function showSuccess(word, formsOverride = null) {
  const forms = [...new Set(formsOverride?.length ? formsOverride : (dictionary?.[word] || []))];
  const requestId = ++successMeaningRequest;
  $('success-reading').textContent = word;
  $('success-forms').textContent = '表記候補を確認中…';
  const difficulty = $('success-difficulty');
  difficulty.textContent = difficultyLabel(classifyWordDifficulty(word, forms));
  difficulty.className = difficultyClass(classifyWordDifficulty(word, forms));
  const meaning = $('success-meaning');
  meaning.textContent = '';
  meaning.classList.add('hidden');
  const banner = $('success-banner'); banner.classList.remove('show'); void banner.offsetWidth; banner.classList.add('show');
  chooseDisplayFormWithMeaning(word, forms).then(({ selectedForm, selectedMeaning }) => {
    if (requestId !== successMeaningRequest || $('success-reading').textContent !== word) return;
    $('success-forms').textContent = formatSelectedForm(forms, selectedForm);
    if (selectedMeaning) { meaning.textContent = `→ ${selectedMeaning}`; meaning.classList.remove('hidden'); }
  }).catch(error => console.error('正解語の意味表示に失敗しました', error));
}
function animateInvalidAnswer() {
  const input = $('answer');
  const opponentColor = (online ? playerRole : 'red') === 'red' ? 'blue' : 'red';
  input.classList.remove('answer-invalid-red', 'answer-invalid-blue');
  void input.offsetWidth;
  input.classList.add(`answer-invalid-${opponentColor}`);
  clearTimeout(input._invalidTimer);
  input._invalidTimer = setTimeout(() => input.classList.remove('answer-invalid-red', 'answer-invalid-blue'), 2100);
}
function rejectAnswer(message) { $('answer-message').textContent = message; animateInvalidAnswer(); }
function acceptAnswer(word, who = 'red') {
  if (gameEnded) return;
  if (!dictionary) { rejectAnswer('辞書を読み込めていません。'); return; }
  if (!/^[ぁ-ゖー]+$/.test(word)) { rejectAnswer('ひらがなで入力してください。'); return; }
  if (!matchesPattern(word, currentPattern)) { rejectAnswer('文字数、または公開された文字が合っていません。'); return; }
  if (!dictionary[word]) { rejectAnswer('辞書にない読みです。別の言葉を試してください。'); return; }
  if (usedAnswerWords.has(word) || (usedQuestionWords.has(word) && word !== currentAnswer)) { rejectAnswer('この試合ですでに使われた言葉です。別の言葉を試してください。'); return; }
  questionRecorded = true; usedAnswerWords.add(word); gameHistory.push({ word, who, forms: [...new Set(dictionary[word] || [])] }); showSuccess(word);
  if (inOvertime) { endGame(who === 'red' ? 'エ語彙スト！' : '相手がエ語彙スト！', '延長戦で先に正解しました。'); return; }
  const previous = position; position = clamp(position + (who === 'red' ? 1 : -1), 0, 6); updateBoard(previous);
  $('answer-message').textContent = `正解：${word}。${who === 'red' ? '青のマスを赤に' : '赤のマスを青に'}塗り替えました。`;
  if (position === 6) { endGame('エ語彙スト！', '6マスすべてを赤に塗り替えました。'); return; }
  if (position === 0) { endGame('相手がエ語彙スト！', '6マスすべてを青に塗り替えられました。'); return; }
  buildQuestion();
}
async function showUnansweredExample(entry) {
  if (!entry?.unanswered || !entry.candidates?.length) return;
  const easyOrder = { beginner: 0, intermediate: 1, advanced: 2 };
  const easiest = [...new Set(entry.candidates)].sort((a, b) => (easyOrder[classifyWordDifficulty(a)] ?? 2) - (easyOrder[classifyWordDifficulty(b)] ?? 2));
  const targetPattern = currentPattern;
  for (const reading of easiest) {
    const selected = await chooseDisplayFormWithMeaning(reading, dictionary?.[reading] || []);
    if (targetPattern !== currentPattern) return;
    if (!selected.selectedMeaning) continue;
    const label = selected.selectedForm || reading;
    $('answer-message').textContent = `例：${label} — ${selected.selectedMeaning}`;
    return;
  }
}
function nextQuestion(message, reason = 'パス') {
  if (gameEnded) return;
  recordUnanswered(reason);
  const entry = gameHistory[gameHistory.length - 1];
  $('answer-message').textContent = message;
  buildQuestion();
  if (entry?.unanswered) showUnansweredExample(entry);
}
function startDemo() {
  disconnectOnline(); stopTimers(); config = readConfig(); position = 3; gameEnded = false; inOvertime = false;
  usedQuestionWords = new Set(); usedAnswerWords = new Set();
  $('answer').disabled = false; $('pass-button').disabled = false;
  currentAnswer = ''; currentPattern = ''; questionRecorded = false;
  matchRemaining = config.matchTime; questionRemaining = config.questionTime; gameHistory = [];
  $('end-overlay').classList.add('hidden'); $('match-room-label').textContent = 'LOCAL PREVIEW'; clearSuccessDisplay();
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
  clearSuccessDisplay();
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
function clearSocketTimers() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (heartbeatWatchdog) clearTimeout(heartbeatWatchdog);
  heartbeatTimer = heartbeatWatchdog = null;
}
function scheduleOnlineReconnect(code, token) {
  if (!online || gameEnded || reconnectTimer) return;
  if (reconnectAttempts >= 12) {
    setRoomMessage('接続が回復しません。部屋IDを使って再接続してください。');
    return;
  }
  const delay = Math.min(15000, 1000 * (2 ** Math.min(reconnectAttempts, 4)));
  reconnectAttempts++;
  setRoomMessage(`接続が切れました。${Math.ceil(delay / 1000)}秒後に再接続します…（${reconnectAttempts}/12）`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (online && !gameEnded && !socket) connectOnline(code, token, true);
  }, delay);
}
function startSocketHeartbeat(ws, code, token) {
  clearSocketTimers();
  heartbeatTimer = setInterval(() => {
    if (socket !== ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ type: 'ping', at: Date.now() }));
      if (heartbeatWatchdog) clearTimeout(heartbeatWatchdog);
      heartbeatWatchdog = setTimeout(() => {
        if (socket === ws) {
          console.warn('[egoism] WebSocket heartbeat timed out', { room: code });
          try { ws.close(4000, 'heartbeat-timeout'); } catch {}
        }
      }, 50000);
    } catch (error) {
      console.warn('[egoism] WebSocket heartbeat send failed', error);
      try { ws.close(4000, 'heartbeat-send-failed'); } catch {}
    }
  }, 20000);
}
function connectOnline(code, token, isReconnect = false) {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  clearSocketTimers();
  if (socket) { const previous = socket; socket = null; try { previous.close(1000, 'replaced'); } catch {} }
  online = true;
  if (!isReconnect) { reconnectAttempts = 0; gameEnded = false; lastQuestionId = 0; lastSuccessKey = ''; stopTimers(); clearSuccessDisplay(); }
  let ws;
  try { ws = new WebSocket(websocketUrl(code, token)); }
  catch (error) { console.error('[egoism] WebSocket construction failed', error); scheduleOnlineReconnect(code, token); return; }
  socket = ws;
  ws.addEventListener('open', () => {
    if (socket !== ws) return;
    reconnectAttempts = 0;
    setRoomMessage(isReconnect ? 'サーバーに再接続しました。対戦状態を確認しています…' : '接続しました。相手の参加を待っています…');
    console.info('[egoism] WebSocket connected', { room: code, reconnect: isReconnect });
    startSocketHeartbeat(ws, code, token);
  });
  ws.addEventListener('message', event => {
    if (socket !== ws) return;
    let msg; try { msg = JSON.parse(event.data); } catch (error) { console.warn('[egoism] Invalid WebSocket message', error); return; }
    if (msg.type === 'pong') {
      if (heartbeatWatchdog) clearTimeout(heartbeatWatchdog);
      heartbeatWatchdog = null;
      return;
    }
    if (msg.type === 'error') {
      answerSubmissionPending = false;
      if ($('battle').classList.contains('active')) { $('answer-message').textContent = msg.message || '接続エラー'; if (/読みが問題|すでに使われた言葉|ひらがなで入力/.test(msg.message || '')) animateInvalidAnswer(); }
      else setRoomMessage(msg.message || '接続エラー');
      if (msg.fatal) disconnectOnline();
      return;
    }
    if (msg.type === 'state') applyServerState(msg.state);
    if (msg.type === 'room-full') { setRoomMessage('この部屋は満員です。'); disconnectOnline(); }
  });
  ws.addEventListener('close', event => {
    console.warn('[egoism] WebSocket closed', { room: code, code: event.code, reason: event.reason, wasClean: event.wasClean });
    if (socket !== ws) return;
    socket = null; clearSocketTimers();
    if (online && !gameEnded && event.reason !== 'room-cleaned' && event.reason !== 'room-expired') scheduleOnlineReconnect(code, token);
    else if (online && !gameEnded) setRoomMessage('部屋が終了しました。');
  });
  ws.addEventListener('error', event => {
    if (socket !== ws) return;
    console.error('[egoism] WebSocket error', { room: code, readyState: ws.readyState, event });
    setRoomMessage('通信エラーが発生しました。再接続を試みます…');
  });
}
function disconnectOnline() {
  online = false;
  if (reconnectTimer) clearTimeout(reconnectTimer); reconnectTimer = null;
  clearSocketTimers(); reconnectAttempts = 0;
  if (socket) { const ws = socket; socket = null; try { ws.close(1000, 'client-disconnect'); } catch {} }
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
      $('countdown-overlay').classList.add('hidden');
      countdownRunning = false;
      countdownTimer = null;
      $('answer').disabled = false;
      return;
    }
    glyph.textContent = sequence[index++];
    glyph.getAnimations().forEach(animation => animation.cancel());
    glyph.animate(
      [{ opacity: 0, transform: 'scale(.45)' }, { opacity: 1, transform: 'scale(1.08)', offset: .68 }, { opacity: 0, transform: 'scale(1.42)' }],
      { duration: 900, easing: 'cubic-bezier(.2,.75,.25,1)', fill: 'forwards' }
    );
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
    clearSuccessDisplay();
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
  if (state.questionId !== lastQuestionId) { lastQuestionId = state.questionId; animateQuestionText(); $('answer').value = ''; answerSubmissionPending = false; }
  updateBoard(oldVisualPosition, oldVisualPosition !== position);
  if (state.lastSuccess) {
    const key = `${state.lastSuccess.reading}:${state.lastSuccess.questionId}`;
    if (key !== lastSuccessKey) { lastSuccessKey = key; showSuccess(state.lastSuccess.reading, state.lastSuccess.forms); }
  }
  const previousHistoryLength = gameHistory.length;
  gameHistory = state.history || [];
  const newestUnanswered = gameHistory.length > previousHistoryLength ? [...gameHistory].reverse().find(entry => entry?.unanswered) : null;
  if (state.passed?.length) $('answer-message').textContent = state.passed.includes(playerRole) ? 'パス済みです。相手のパスを待っています。' : '相手がパスしました。パスするか、回答してください。';
  else $('answer-message').textContent = inOvertime ? '延長戦！ 次の正解で決着します。' : '表示された文字に合う読みを入力してください。';
  if (newestUnanswered) showUnansweredExample(newestUnanswered);
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

$('create-room').addEventListener('click', createOnlineRoom);
$('copy-room').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('room-code').textContent); setRoomMessage('部屋IDをコピーしました。'); } catch { setRoomMessage('部屋ID：' + $('room-code').textContent); } });
$('join-room').addEventListener('click', joinOnlineRoom);
$('preview-battle').addEventListener('click', startDemo);
$('answer').addEventListener('compositionstart', () => { answerComposing = true; });
$('answer').addEventListener('compositionend', e => {
  answerComposing = false;
  lastCompositionEnd = Date.now();
  const el = e.target, start = el.selectionStart, cleaned = normalizeInput(el.value);
  if (cleaned !== el.value) { el.value = cleaned; try { el.setSelectionRange(Math.min(start, cleaned.length), Math.min(start, cleaned.length)); } catch {} }
});
$('answer').addEventListener('input', e => {
  if (answerComposing || e.isComposing) return;
  const el = e.target, start = el.selectionStart, cleaned = normalizeInput(el.value);
  if (cleaned !== el.value) { el.value = cleaned; try { el.setSelectionRange(Math.min(start, cleaned.length), Math.min(start, cleaned.length)); } catch {} }
});
$('answer').addEventListener('keydown', e => {
  if (e.key === 'Enter' && (answerComposing || e.isComposing || e.keyCode === 229)) {
    e.preventDefault(); e.stopPropagation();
  }
});
$('answer-form').addEventListener('submit', e => {
  e.preventDefault();
  if (answerComposing || $('answer').matches(':disabled')) return;
  const input = $('answer'), answer = normalizeInput(input.value.trim(), true);
  if (!answer || answerSubmissionPending) return;
  if (online) {
    if (sendOnline('answer', { word: answer, questionId: lastServerState?.questionId })) answerSubmissionPending = true;
    // Keep the text until the server confirms a new question; invalid answers remain editable.
  } else {
    acceptAnswer(answer, 'red');
    if (currentPattern === '') input.value = '';
  }
});
$('pass-button').addEventListener('click', () => {
  if (online) sendOnline('pass', { questionId: lastServerState?.questionId });
  else { nextQuestion('パスしました。次の問題です。', 'パス'); }
  $('answer').focus({ preventScroll: true });
});
$('opponent-test').addEventListener('click', () => { if (!online) acceptAnswer(currentAnswer, 'blue'); if (!gameEnded) $('answer').focus({ preventScroll: true }); });
$('rematch').addEventListener('click', () => { if (online) { if (lastServerState?.ended) { sendOnline('rematch'); $('rematch').disabled = true; $('rematch').textContent = '再戦を待っています…'; $('end-detail').textContent = '再戦を申し込みました。相手が押すのを待っています。'; } } else startDemo(); });
$('answer').addEventListener('blur', () => {
  // Do not steal focus during IME candidate selection or mobile keyboard transitions.
});
