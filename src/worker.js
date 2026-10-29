const ROOM_ID_RE = /^[A-Z0-9]{4,8}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/health') {
      return json({
        ok: true, service: 'egoism-room-server',
        bindings: { rooms: Boolean(env.ROOMS), assets: Boolean(env.ASSETS) },
        version: 'room-api-v6'
      });
    }

    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      let input;
      try { input = await request.json(); } catch { return json({ error: '設定データを読み取れません。' }, 400); }
      try {
        if (!env.ROOMS) return json({ error: 'CloudflareのROOMSバインディングが見つかりません。wrangler.jsoncのDurable Objects設定を確認してください。', code: 'ROOMS_BINDING_MISSING' }, 503);
        const config = normalizeConfig(input);
        const code = randomCode();
        const token = crypto.randomUUID();
        const id = env.ROOMS.idFromName(code);
        const stub = env.ROOMS.get(id);
        const init = await stub.fetch('https://room.internal/init', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config, hostToken: token })
        });
        if (!init.ok) {
          const detail = (await init.text()).slice(0, 300);
          console.error('Room initialization failed', init.status, detail);
          return json({ error: '部屋の初期化に失敗しました。CloudflareのDurable Object設定を確認してください。', code: 'ROOM_INIT_FAILED', status: init.status }, 500);
        }
        return json({ code, token });
      } catch (error) {
        console.error('Room creation failed', error);
        return json({
          error: '部屋を作成できませんでした。CloudflareのWorkerログを確認してください。',
          code: error?.name || 'ROOM_CREATE_FAILED',
          detail: String(error?.message || error).slice(0, 240)
        }, 500);
      }
    }

    const cleanupMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{4,8})\/cleanup$/);
    if (cleanupMatch && request.method === 'POST') {
      if (!env.ROOMS) return json({ error: 'ROOMS binding missing' }, 503);
      let input;
      try { input = await request.json(); } catch { return json({ error: 'Invalid cleanup request' }, 400); }
      const id = env.ROOMS.idFromName(cleanupMatch[1]);
      return env.ROOMS.get(id).fetch('https://room.internal/cleanup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: input.token })
      });
    }

    const match = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{4,8})\/ws$/);
    if (match && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const code = match[1];
      if (!ROOM_ID_RE.test(code)) return json({ error: '部屋IDが不正です。' }, 400);
      const id = env.ROOMS.idFromName(code);
      const roomUrl = new URL(request.url); roomUrl.pathname = '/ws';
      return env.ROOMS.get(id).fetch(new Request(roomUrl.toString(), request));
    }

    return env.ASSETS.fetch(request);
  }
};

export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.room = null;
    this.wordIndex = null;
  }

  async loadRoom() {
    if (!this.room) this.room = await this.ctx.storage.get('room');
    return this.room;
  }
  async saveRoom() {
    await this.ctx.storage.put('room', this.room);
    await this.scheduleAlarm();
  }
  async loadWordIndex() {
    if (this.wordIndex) return this.wordIndex;
    const response = await this.env.ASSETS.fetch('https://egoism-assets/data/word-index.json');
    if (!response.ok) throw new Error(`語句索引を読み込めません（HTTP ${response.status}）。`);
    const index = await response.json();
    const levels = ['beginner', 'intermediate', 'advanced'];
    if (!index || typeof index !== 'object' || levels.some(level => !index[level] || typeof index[level] !== 'object')) {
      throw new Error('語句索引が空か、形式が不正です。');
    }
    this.wordIndex = index;
    return this.wordIndex;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/cleanup' && request.method === 'POST') {
      const room = await this.loadRoom();
      if (!room) return json({ ok: true, alreadyClean: true });
      let input;
      try { input = await request.json(); } catch { return json({ error: 'Invalid cleanup request' }, 400); }
      const token = input.token;
      const authorized = token && (token === room.players?.red?.token || token === room.players?.blue?.token);
      if (!authorized) return json({ error: '部屋を削除する権限がありません。' }, 403);
      if (!room.ended) return json({ error: '対戦終了前の部屋は削除できません。' }, 409);
      for (const ws of this.ctx.getWebSockets()) { try { ws.close(1000, 'room-cleaned'); } catch {} }
      await this.ctx.storage.deleteAll();
      this.room = null; this.wordIndex = null;
      return json({ ok: true });
    }

    if (url.pathname === '/init' && request.method === 'POST') {
      const input = await request.json();
      this.room = {
        config: normalizeConfig(input.config), hostToken: input.hostToken,
        players: { red: { token: input.hostToken, connected: false }, blue: { token: null, connected: false } },
        started: false, ended: false, inOvertime: false, position: 3,
        pattern: '', answer: '', questionId: 0, history: [], lastSuccess: null, passed: [],
        matchDeadline: 0, questionDeadline: 0, result: null, usedWords: [], usedAnswers: [], rematchVotes: { red: false, blue: false }
      };
      await this.ctx.storage.put('room', this.room);
      return json({ ok: true });
    }
    if (url.pathname !== '/ws' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return json({ error: 'Not found' }, 404);
    }
    const room = await this.loadRoom();
    if (!room) return json({ error: '部屋が見つかりません。' }, 404);
    const token = url.searchParams.get('token');
    if (!token) return json({ error: '接続トークンがありません。' }, 400);
    let role;
    if (token === room.players.red.token) role = 'red';
    else if (room.players.blue.token === token) role = 'blue';
    else if (!room.players.blue.token) { role = 'blue'; room.players.blue.token = token; }
    else return json({ type: 'room-full', error: 'この部屋は満員です。' }, 409);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment({ role, token });
    this.ctx.acceptWebSocket(server);
    room.players[role].connected = true;
    const shouldStartMatch = room.players.red.connected && room.players.blue.connected && !room.started && !room.ended;
    // Persist and acknowledge the WebSocket before loading the compact word index.
    // Initialization happens after HTTP 101 so a slower asset fetch does not fail the handshake.
    await this.saveRoom();
    await this.broadcast();
    if (shouldStartMatch) {
      this.ctx.waitUntil((async () => {
        try {
          await this.startMatch();
          await this.broadcast();
        } catch (error) {
          console.error('Match initialization failed after WebSocket connection', error);
          const message = error?.message || '対戦の初期化に失敗しました。';
          for (const ws of this.ctx.getWebSockets()) {
            this.send(ws, { type: 'error', message: `対戦を開始できませんでした: ${message}` });
          }
        }
      })());
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async startMatch() {
    await this.loadRoom();
    if (!this.room || this.room.started) return;
    const words = await this.loadWordIndex();
    this.room.started = true;
    const startAt = Date.now() + 3500;
    this.room.matchDeadline = this.room.config.matchTime > 0 ? startAt + this.room.config.matchTime * 1000 : 0;
    if (!this.makeQuestion(words)) this.endForWordExhaustion();
    this.room.questionDeadline = this.room.ended ? 0 : this.room.config.questionTime > 0 ? startAt + this.room.config.questionTime * 1000 : 0;
    await this.saveRoom();
  }

  makeQuestion(index) {
    const room = this.room;
    const used = new Set([...(room.usedWords || []), ...(room.usedAnswers || [])]);
    const levels = room.config.difficulty === 'unlimited'
      ? ['beginner', 'intermediate', 'advanced']
      : [room.config.difficulty];
    const pools = [];
    let total = 0;
    for (const level of levels) {
      for (let length = room.config.lengthMin; length <= room.config.lengthMax; length++) {
        const pool = index[level]?.[String(length)] || [];
        if (pool.length) { pools.push({ words: pool, start: total, end: total + pool.length }); total += pool.length; }
      }
    }
    if (!total) return false;
    // Pick uniformly from pre-grouped pools without scanning nearly one million readings per turn.
    let answer = '';
    const attempts = Math.min(100, total);
    for (let attempt = 0; attempt < attempts; attempt++) {
      const offset = Math.floor(Math.random() * total);
      const pool = pools.find(item => offset >= item.start && offset < item.end);
      const candidate = pool.words[offset - pool.start];
      if (!used.has(candidate)) { answer = candidate; break; }
    }
    // Only scan as a fallback when random attempts collide with previously used words.
    if (!answer) {
      outer: for (const pool of pools) {
        for (const candidate of pool.words) {
          if (!used.has(candidate)) { answer = candidate; break outer; }
        }
      }
    }
    if (!answer) return false;
    room.answer = answer;
    room.usedWords.push(answer);
    const answerChars = [...answer];
    const revealLow = Math.min(room.config.revealedMin, room.config.revealedMax);
    const revealHigh = Math.max(room.config.revealedMin, room.config.revealedMax);
    const count = Math.min(answerChars.length, revealLow + Math.floor(Math.random() * (revealHigh - revealLow + 1)));
    const indexes = answerChars.map((_, i) => i).sort(() => Math.random() - 0.5).slice(0, count);
    const pattern = [...'〇'.repeat(answerChars.length)];
    indexes.forEach(i => pattern[i] = answerChars[i]);
    room.pattern = pattern.join('');
    room.questionId += 1;
    room.passed = [];
    room.questionDeadline = room.config.questionTime > 0 ? Date.now() + room.config.questionTime * 1000 : 0;
    return true;
  }

  endForWordExhaustion() {
    this.room.ended = true;
    this.room.answer = '';
    this.room.pattern = '';
    this.room.matchDeadline = 0;
    this.room.questionDeadline = 0;
    this.room.result = { winner: null, detail: 'この試合で使える言葉がなくなりました。' };
  }

  async webSocketMessage(ws, message) {
    const attachment = ws.deserializeAttachment() || {};
    const role = attachment.role;
    let payload;
    try { payload = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message)); }
    catch { this.send(ws, { type: 'error', message: 'メッセージを読み取れません。' }); return; }
    const room = await this.loadRoom();
    if (!room) return;
    if (!['red', 'blue'].includes(role) || room.players[role].token !== attachment.token) return;
    try {
      if (payload.type === 'rematch') {
        if (!room.ended) return;
        if (!room.players.red.connected || !room.players.blue.connected) { this.send(ws, { type: 'error', message: '相手が部屋を退出しました。新しい部屋を作成してください。' }); return; }
        room.rematchVotes = room.rematchVotes || { red: false, blue: false };
        room.rematchVotes[role] = true;
        if (room.rematchVotes.red && room.rematchVotes.blue) {
          room.started = false; room.ended = false; room.inOvertime = false; room.position = 3;
          room.pattern = ''; room.answer = ''; room.questionId = 0; room.history = []; room.lastSuccess = null; room.passed = [];
          room.matchDeadline = 0; room.questionDeadline = 0; room.result = null; room.usedWords = []; room.usedAnswers = [];
          room.rematchVotes = { red: false, blue: false };
          await this.startMatch(); await this.broadcast();
        } else { await this.saveRoom(); await this.broadcast(); }
        return;
      }
      if (!room.started || room.ended) return;
      if (payload.questionId && Number(payload.questionId) !== room.questionId) { this.sendRole(role, { type: 'error', message: '問題が切り替わりました。新しい問題に回答してください。' }); return; }
      if (payload.type === 'answer') await this.handleAnswer(role, String(payload.word || ''));
      else if (payload.type === 'pass') await this.handlePass(role);
    } catch (error) {
      this.send(ws, { type: 'error', message: error.message || '操作を処理できませんでした。' });
    }
  }

  async handleAnswer(role, word) {
    const room = this.room;
    const words = await this.loadWordIndex();
    if (!/^[ぁ-ゖー]+$/.test(word)) { this.sendRole(role, { type: 'error', message: 'ひらがなで入力してください。' }); return; }
    if (!hasWordInIndex(words, word) || !matchesPattern(word, room.pattern)) { this.sendRole(role, { type: 'error', message: '読みが問題の条件に合いません。' }); return; }
    room.usedAnswers = room.usedAnswers || [];
    if (room.usedAnswers.includes(word) || (room.usedWords.includes(word) && word !== room.answer)) { this.sendRole(role, { type: 'error', message: 'この試合ですでに使われた言葉です。別の言葉を試してください。' }); return; }
    room.usedAnswers.push(word);
    // The client already has the full dictionary locally; keep the server state compact.
    // Empty forms tell the client to use its local reading -> forms mapping.
    const forms = [];
    room.history.push({ word, who: role, forms });
    room.lastSuccess = { reading: word, forms, questionId: room.questionId };
    room.passed = [];
    if (room.inOvertime) {
      room.ended = true;
      room.result = { winner: role, detail: '延長戦で先に正解しました。' };
    } else {
      room.position = Math.max(0, Math.min(6, room.position + (role === 'red' ? 1 : -1)));
      if (room.position === 6) { room.ended = true; room.result = { winner: 'red', detail: '6マスすべてを赤に塗り替えました。' }; }
      else if (room.position === 0) { room.ended = true; room.result = { winner: 'blue', detail: '6マスすべてを青に塗り替えました。' }; }
      else if (!this.makeQuestion(await this.loadWordIndex())) this.endForWordExhaustion();
    }
    await this.saveRoom();
    await this.broadcast();
  }

  async handlePass(role) {
    const room = this.room;
    if (!room.passed.includes(role)) room.passed.push(role);
    if (room.passed.length >= 2) {
      await this.recordUnanswered('両者パス');
      if (!this.makeQuestion(await this.loadWordIndex())) this.endForWordExhaustion();
    }
    await this.saveRoom();
    await this.broadcast();
  }

  async recordUnanswered(reason) {
    const room = this.room;
    const index = await this.loadWordIndex();
    const length = [...room.pattern].length;
    const pools = ['beginner', 'intermediate', 'advanced'].map(level => index[level]?.[String(length)] || []);
    const candidates = [];
    const seen = new Set();
    // Random probing is sufficient for the small optional hint list and avoids scanning an entire length bucket.
    let total = pools.reduce((sum, pool) => sum + pool.length, 0);
    for (let attempt = 0; attempt < Math.min(6000, total * 2) && candidates.length < 5; attempt++) {
      const offset = Math.floor(Math.random() * total);
      let cursor = offset, word = '';
      for (const pool of pools) {
        if (cursor < pool.length) { word = pool[cursor]; break; }
        cursor -= pool.length;
      }
      if (word && !seen.has(word) && matchesPattern(word, room.pattern)) { candidates.push(word); seen.add(word); }
    }
    room.history.push({ unanswered: true, pattern: room.pattern, reason, candidates, who: 'none', word: '未回答の問題' });
  }

  async alarm() {
    const room = await this.loadRoom();
    if (!room) return;
    if (room.ended) {
      for (const ws of this.ctx.getWebSockets()) { try { ws.close(1000, 'room-expired'); } catch {} }
      await this.ctx.storage.deleteAll(); this.room = null; this.wordIndex = null;
      return;
    }
    if (!room.started) return;
    const now = Date.now();
    if (room.matchDeadline && now >= room.matchDeadline) {
      if (room.position === 3 && room.config.overtime === 'sudden') {
        room.inOvertime = true; room.matchDeadline = 0;
      } else {
        room.ended = true;
        room.result = room.position === 3 ? { winner: null, detail: '時間切れまでに差がつきませんでした。' } : { winner: room.position > 3 ? 'red' : 'blue', detail: '時間切れ。塗り替えたマスの数で勝敗が決まりました。' };
      }
    } else if (room.questionDeadline && now >= room.questionDeadline) {
      await this.recordUnanswered('制限時間終了');
      if (!this.makeQuestion(await this.loadWordIndex())) this.endForWordExhaustion();
    }
    await this.saveRoom();
    await this.broadcast();
  }

  async scheduleAlarm() {
    if (!this.room) { await this.ctx.storage.deleteAlarm(); return; }
    if (this.room.ended) { await this.ctx.storage.setAlarm(Date.now() + 30 * 60 * 1000); return; }
    if (!this.room.started) { await this.ctx.storage.deleteAlarm(); return; }
    const deadlines = [this.room.matchDeadline, this.room.questionDeadline].filter(n => n > 0);
    if (!deadlines.length) { await this.ctx.storage.deleteAlarm(); return; }
    await this.ctx.storage.setAlarm(Math.min(...deadlines));
  }

  stateForClient() {
    const r = this.room;
    return {
      config: r.config, players: { red: { connected: r.players.red.connected }, blue: { connected: r.players.blue.connected } },
      started: r.started, ended: r.ended, inOvertime: r.inOvertime, position: r.position, pattern: r.pattern,
      questionId: r.questionId, history: r.history, lastSuccess: r.lastSuccess, passed: r.passed,
      matchDeadline: r.matchDeadline, questionDeadline: r.questionDeadline, result: r.result, rematchVotes: r.rematchVotes || { red: false, blue: false }
    };
  }
  async broadcast() {
    await this.loadRoom(); if (!this.room) return;
    const message = JSON.stringify({ type: 'state', state: this.stateForClient() });
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(message); } catch {} }
  }
  send(ws, message) { try { ws.send(JSON.stringify(message)); } catch {} }
  sendRole(role, message) {
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() || {};
      if (a.role === role) this.send(ws, message);
    }
  }
  async webSocketClose(ws) {
    const a = ws.deserializeAttachment() || {};
    const room = await this.loadRoom();
    if (room && room.players[a.role] && room.players[a.role].token === a.token) {
      room.players[a.role].connected = false;
      await this.saveRoom(); await this.broadcast();
    }
  }
  async webSocketError(ws) { await this.webSocketClose(ws); }
}

function binarySearchWord(sortedWords, target) {
  let low = 0, high = sortedWords.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const value = sortedWords[mid];
    if (value === target) return true;
    if (value < target) low = mid + 1;
    else high = mid - 1;
  }
  return false;
}

function hasWordInIndex(index, word) {
  const length = String([...word].length);
  return ['beginner', 'intermediate', 'advanced'].some(level => binarySearchWord(index[level]?.[length] || [], word));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeConfig(input = {}) {
  const numberOr = (value, fallback) => Number.isFinite(Number(value)) && value !== null && value !== '' ? Number(value) : fallback;
  const lengthMin = clamp(numberOr(input.lengthMin, 4), 3, 10);
  const lengthMax = clamp(numberOr(input.lengthMax, 7), lengthMin, 10);
  const revealA = clamp(numberOr(input.revealedMin, 1), 0, 10);
  const revealB = clamp(numberOr(input.revealedMax, 2), 0, 10);
  return {
    lengthMin, lengthMax,
    revealedMin: Math.min(revealA, revealB),
    revealedMax: Math.max(revealA, revealB),
    matchTime: Math.max(0, numberOr(input.matchTime, 300)),
    questionTime: Math.max(0, numberOr(input.questionTime, 120)),
    overtime: input.overtime === 'draw' ? 'draw' : 'sudden',
    difficulty: ['beginner', 'intermediate', 'advanced', 'unlimited'].includes(input.difficulty) ? input.difficulty : 'intermediate'
  };
}
function matchesPattern(word, pattern) {
  const chars = [...word], mask = [...pattern];
  return chars.length === mask.length && mask.every((char, i) => char === '〇' || char === chars[i]);
}
function randomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(6); crypto.getRandomValues(bytes);
  return [...bytes].map(byte => alphabet[byte % alphabet.length]).join('');
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
