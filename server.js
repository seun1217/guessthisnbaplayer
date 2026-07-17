// Guess This NBA Player — 의존성 없는 Node.js 서버
// 정답과 점수 계산은 전부 서버에서만 처리해 클라이언트 치팅을 방지한다.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PLAYERS } = require('./data/players');

const PORT = Number(process.env.PORT) || 3000;
const ROUNDS_PER_GAME = 5;
const MAX_HINTS = 5;
const HINT_SCORES = [100, 80, 60, 40, 20]; // 공개된 힌트 개수(1~5)에 따른 획득 점수
const MAX_NAME_LENGTH = 16;
const LEADERBOARD_KEEP = 100;
const LEADERBOARD_SHOW = 20;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

const DATA_DIR = process.env.GTNP_DATA_DIR || path.join(__dirname, 'data');
const LEADERBOARD_FILE = path.join(DATA_DIR, 'leaderboard.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const TEST_MODE = !!process.env.GTNP_TEST;

// ---------- 정답 판정 ----------

function normalizeAnswer(s) {
  return String(s || '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\s.\-'’‘"“”·,]/g, '');
}

const answerIndex = new Map(); // 정규화된 표기 -> player id
const seenIds = new Set();
for (const p of PLAYERS) {
  if (seenIds.has(p.id)) throw new Error(`선수 id 중복: ${p.id}`);
  seenIds.add(p.id);
  if (p.hints.length !== MAX_HINTS) {
    throw new Error(`${p.id}: 힌트는 정확히 ${MAX_HINTS}개여야 합니다`);
  }
  for (const label of [p.name, p.ko, ...(p.aliases || [])]) {
    const key = normalizeAnswer(label);
    if (!key) continue;
    const existing = answerIndex.get(key);
    if (existing && existing !== p.id) {
      throw new Error(`정답 표기 충돌: "${label}" (${existing} vs ${p.id})`);
    }
    answerIndex.set(key, p.id);
  }
}

const playerById = new Map(PLAYERS.map((p) => [p.id, p]));

// ---------- 리더보드 (JSON 파일 영속화) ----------

let leaderboard = [];

function loadLeaderboard() {
  try {
    const raw = fs.readFileSync(LEADERBOARD_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) leaderboard = parsed;
  } catch {
    leaderboard = [];
  }
}

function saveLeaderboard() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = LEADERBOARD_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(leaderboard, null, 2));
  fs.renameSync(tmp, LEADERBOARD_FILE);
}

function addLeaderboardEntry(entry) {
  leaderboard.push(entry);
  leaderboard.sort((a, b) => b.score - a.score || a.date.localeCompare(b.date));
  if (leaderboard.length > LEADERBOARD_KEEP) leaderboard.length = LEADERBOARD_KEEP;
  saveLeaderboard();
  const rank = leaderboard.indexOf(entry) + 1;
  return rank === 0 ? null : rank; // 상위권 밖으로 밀려났으면 null
}

// ---------- 게임 세션 (메모리) ----------

const sessions = new Map();

function pickRandomPlayers(count) {
  const pool = [...PLAYERS];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count).map((p) => p.id);
}

function createGame() {
  const id = crypto.randomUUID();
  const game = {
    id,
    playerIds: pickRandomPlayers(ROUNDS_PER_GAME),
    currentRound: 0,
    rounds: [], // {playerId, hintsRevealed, done, correct, score}
    finished: false,
    submitted: false,
    createdAt: Date.now(),
  };
  game.rounds.push(newRound(game.playerIds[0]));
  sessions.set(id, game);
  return game;
}

function newRound(playerId) {
  return { playerId, hintsRevealed: 1, done: false, correct: false, score: 0 };
}

function totalScore(game) {
  return game.rounds.reduce((sum, r) => sum + r.score, 0);
}

function roundView(game) {
  const round = game.rounds[game.currentRound];
  const player = playerById.get(round.playerId);
  const view = {
    roundIndex: game.currentRound,
    totalRounds: ROUNDS_PER_GAME,
    hints: player.hints.slice(0, round.hintsRevealed),
    hintsRevealed: round.hintsRevealed,
    maxHints: MAX_HINTS,
    potentialScore: HINT_SCORES[round.hintsRevealed - 1],
    totalScore: totalScore(game),
  };
  if (TEST_MODE) view.debugAnswer = round.playerId;
  return view;
}

function revealPlayer(playerId) {
  const p = playerById.get(playerId);
  return { name: p.name, ko: p.ko, hints: p.hints };
}

// 라운드 종료 처리 후, 다음 라운드 또는 게임 종료 정보를 담아 반환
function advance(game) {
  const result = {};
  if (game.currentRound + 1 < ROUNDS_PER_GAME) {
    game.currentRound += 1;
    game.rounds.push(newRound(game.playerIds[game.currentRound]));
    result.nextRound = roundView(game);
  } else {
    game.finished = true;
    result.gameOver = {
      totalScore: totalScore(game),
      correctRounds: game.rounds.filter((r) => r.correct).length,
      rounds: game.rounds.map((r) => ({
        player: revealPlayer(r.playerId).ko,
        correct: r.correct,
        score: r.score,
        hintsUsed: r.hintsRevealed,
      })),
    };
  }
  return result;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, game] of sessions) {
    if (now - game.createdAt > SESSION_TTL_MS) sessions.delete(id);
  }
}, 10 * 60 * 1000).unref();

// ---------- HTTP 유틸 ----------

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 16 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, urlPath) {
  const safePath = path.normalize(urlPath === '/' ? '/index.html' : urlPath);
  const filePath = path.join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    return sendJson(res, 403, { error: 'forbidden' });
  }
  fs.readFile(filePath, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'not found' });
    const type = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
}

// ---------- API 라우팅 ----------

async function handleApi(req, res, urlPath) {
  // GET /api/players — 자동완성용 이름 목록 (정답 유추에 쓰일 힌트 정보는 제외)
  if (req.method === 'GET' && urlPath === '/api/players') {
    return sendJson(res, 200, PLAYERS.map((p) => ({ name: p.name, ko: p.ko })));
  }

  // GET /api/leaderboard — 상위 랭킹
  if (req.method === 'GET' && urlPath === '/api/leaderboard') {
    return sendJson(res, 200, {
      entries: leaderboard.slice(0, LEADERBOARD_SHOW),
      total: leaderboard.length,
    });
  }

  // POST /api/game — 새 게임 시작
  if (req.method === 'POST' && urlPath === '/api/game') {
    const game = createGame();
    return sendJson(res, 200, { gameId: game.id, round: roundView(game) });
  }

  // POST /api/game/:id/(hint|guess|giveup|submit)
  const match = urlPath.match(/^\/api\/game\/([0-9a-f-]{36})\/(hint|guess|giveup|submit)$/);
  if (match && req.method === 'POST') {
    const game = sessions.get(match[1]);
    if (!game) return sendJson(res, 404, { error: '게임 세션을 찾을 수 없습니다. 새 게임을 시작해 주세요.' });
    const action = match[2];

    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: '잘못된 요청입니다.' });
    }

    if (action === 'submit') {
      if (!game.finished) return sendJson(res, 400, { error: '게임이 아직 끝나지 않았습니다.' });
      if (game.submitted) return sendJson(res, 400, { error: '이미 리더보드에 등록된 게임입니다.' });
      const name = String(body.name || '').trim().slice(0, MAX_NAME_LENGTH);
      if (!name) return sendJson(res, 400, { error: '닉네임을 입력해 주세요.' });
      game.submitted = true;
      const entry = {
        name,
        score: totalScore(game),
        correct: game.rounds.filter((r) => r.correct).length,
        date: new Date().toISOString(),
      };
      const rank = addLeaderboardEntry(entry);
      return sendJson(res, 200, {
        rank,
        entries: leaderboard.slice(0, LEADERBOARD_SHOW),
        total: leaderboard.length,
      });
    }

    if (game.finished) return sendJson(res, 400, { error: '이미 끝난 게임입니다.' });
    const round = game.rounds[game.currentRound];

    if (action === 'hint') {
      if (round.hintsRevealed >= MAX_HINTS) {
        return sendJson(res, 400, { error: '더 이상 힌트가 없습니다.' });
      }
      round.hintsRevealed += 1;
      return sendJson(res, 200, { round: roundView(game) });
    }

    if (action === 'giveup') {
      round.done = true;
      const result = {
        correct: false,
        gaveUp: true,
        player: revealPlayer(round.playerId),
        roundScore: 0,
        totalScore: totalScore(game),
        ...advance(game),
      };
      return sendJson(res, 200, result);
    }

    if (action === 'guess') {
      const guess = normalizeAnswer(body.guess);
      if (!guess) return sendJson(res, 400, { error: '선수 이름을 입력해 주세요.' });

      const guessedId = answerIndex.get(guess);
      if (guessedId === round.playerId) {
        round.done = true;
        round.correct = true;
        round.score = HINT_SCORES[round.hintsRevealed - 1];
        return sendJson(res, 200, {
          correct: true,
          player: revealPlayer(round.playerId),
          roundScore: round.score,
          hintsUsed: round.hintsRevealed,
          totalScore: totalScore(game),
          ...advance(game),
        });
      }

      // 오답: 남은 힌트가 있으면 자동 공개, 마지막 기회였다면 라운드 실패
      if (round.hintsRevealed < MAX_HINTS) {
        round.hintsRevealed += 1;
        return sendJson(res, 200, { correct: false, round: roundView(game) });
      }
      round.done = true;
      return sendJson(res, 200, {
        correct: false,
        roundFailed: true,
        player: revealPlayer(round.playerId),
        roundScore: 0,
        totalScore: totalScore(game),
        ...advance(game),
      });
    }
  }

  return sendJson(res, 404, { error: 'not found' });
}

// ---------- 서버 ----------

function createServer() {
  loadLeaderboard();
  return http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (urlPath.startsWith('/api/')) {
      handleApi(req, res, urlPath).catch(() => sendJson(res, 500, { error: 'server error' }));
    } else if (req.method === 'GET') {
      serveStatic(req, res, urlPath);
    } else {
      sendJson(res, 405, { error: 'method not allowed' });
    }
  });
}

if (require.main === module) {
  createServer().listen(PORT, () => {
    console.log(`🏀 Guess This NBA Player — http://localhost:${PORT}`);
  });
}

module.exports = { createServer, normalizeAnswer, HINT_SCORES, ROUNDS_PER_GAME };
