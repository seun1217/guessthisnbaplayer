// 통합 테스트: 서버를 임시 포트에 띄우고 게임 전체 흐름을 검증한다.
// GTNP_TEST=1 이면 라운드 응답에 debugAnswer(정답 플레이어 id)가 포함된다.

process.env.GTNP_TEST = '1';
process.env.GTNP_DATA_DIR = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'gtnp-test-')
);

const assert = require('assert');
const { createServer, HINT_SCORES, ROUNDS_PER_GAME } = require('./server');
const { PLAYERS } = require('./data/players');

const playerById = new Map(PLAYERS.map((p) => [p.id, p]));

let base;

async function api(path, options) {
  const res = await fetch(base + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json();
  return { status: res.status, data };
}

async function run() {
  // --- 데이터 무결성 ---
  assert.ok(PLAYERS.length >= 200, '선수는 200명 이상이어야 함');
  for (const p of PLAYERS) {
    assert.strictEqual(p.hints.length, 5, `${p.id}: 힌트 5개`);
    assert.ok(p.ko && p.name, `${p.id}: 이름 필수`);
  }
  console.log(`✓ 선수 데이터 ${PLAYERS.length}명 무결성 확인`);

  // --- 선수 목록 API ---
  const players = await api('/api/players');
  assert.strictEqual(players.status, 200);
  assert.strictEqual(players.data.length, PLAYERS.length);
  assert.ok(!('hints' in players.data[0]), '목록에 힌트가 노출되면 안 됨');
  console.log('✓ GET /api/players');

  // --- 게임 시작 ---
  const start = await api('/api/game', { method: 'POST' });
  assert.strictEqual(start.status, 200);
  const gameId = start.data.gameId;
  let round = start.data.round;
  assert.strictEqual(round.hintsRevealed, 1);
  assert.strictEqual(round.hints.length, 1);
  assert.strictEqual(round.potentialScore, 100);
  assert.ok(round.debugAnswer, '테스트 모드에서 debugAnswer 포함');
  console.log('✓ POST /api/game — 첫 힌트 1개, 잠재 점수 100');

  // --- 라운드 1: 오답 → 힌트 자동 공개 ---
  const wrong = await api(`/api/game/${gameId}/guess`, {
    method: 'POST',
    body: JSON.stringify({ guess: '존재하지 않는 선수' }),
  });
  assert.strictEqual(wrong.data.correct, false);
  assert.strictEqual(wrong.data.round.hintsRevealed, 2);
  assert.strictEqual(wrong.data.round.potentialScore, 80);
  console.log('✓ 오답 시 다음 힌트 자동 공개 (100 → 80)');

  // --- 라운드 1: 힌트 요청 ---
  const hint = await api(`/api/game/${gameId}/hint`, { method: 'POST' });
  assert.strictEqual(hint.data.round.hintsRevealed, 3);
  assert.strictEqual(hint.data.round.potentialScore, 60);
  console.log('✓ 힌트 요청 (80 → 60)');

  // --- 라운드 1: 한글 이름으로 정답 (힌트 3개 = 60점) ---
  round = hint.data.round;
  const answer1 = playerById.get(round.debugAnswer);
  const correct1 = await api(`/api/game/${gameId}/guess`, {
    method: 'POST',
    body: JSON.stringify({ guess: ` ${answer1.ko} ` }), // 공백 포함해도 인정
  });
  assert.strictEqual(correct1.data.correct, true);
  assert.strictEqual(correct1.data.roundScore, 60);
  assert.strictEqual(correct1.data.totalScore, 60);
  assert.ok(correct1.data.nextRound, '다음 라운드 정보 포함');
  console.log('✓ 한글 이름 정답 인정, 60점 획득');

  // --- 라운드 2: 영문 이름(대문자)으로 즉시 정답 (100점) ---
  round = correct1.data.nextRound;
  const answer2 = playerById.get(round.debugAnswer);
  const correct2 = await api(`/api/game/${gameId}/guess`, {
    method: 'POST',
    body: JSON.stringify({ guess: answer2.name.toUpperCase() }),
  });
  assert.strictEqual(correct2.data.correct, true);
  assert.strictEqual(correct2.data.roundScore, 100);
  assert.strictEqual(correct2.data.totalScore, 160);
  console.log('✓ 영문 대문자 정답 인정, 첫 힌트 100점');

  // --- 라운드 3: 포기 ---
  const giveup = await api(`/api/game/${gameId}/giveup`, { method: 'POST' });
  assert.strictEqual(giveup.data.roundScore, 0);
  assert.ok(giveup.data.player.ko, '포기 시 정답 공개');
  console.log('✓ 포기 시 0점 + 정답 공개');

  // --- 라운드 4: 5번째 힌트까지 소진 후 오답 → 라운드 실패 ---
  round = giveup.data.nextRound;
  for (let i = round.hintsRevealed; i < 5; i++) {
    const h = await api(`/api/game/${gameId}/hint`, { method: 'POST' });
    round = h.data.round;
  }
  assert.strictEqual(round.potentialScore, 20);
  const noMoreHints = await api(`/api/game/${gameId}/hint`, { method: 'POST' });
  assert.strictEqual(noMoreHints.status, 400, '6번째 힌트는 거부');
  const failGuess = await api(`/api/game/${gameId}/guess`, {
    method: 'POST',
    body: JSON.stringify({ guess: '오답입니다' }),
  });
  assert.strictEqual(failGuess.data.roundFailed, true);
  assert.strictEqual(failGuess.data.roundScore, 0);
  console.log('✓ 마지막 힌트에서 오답 → 라운드 실패 0점');

  // --- 라운드 5: 별칭(alias)으로 정답, 마지막 힌트 20점 ---
  round = failGuess.data.nextRound;
  for (let i = round.hintsRevealed; i < 5; i++) {
    const h = await api(`/api/game/${gameId}/hint`, { method: 'POST' });
    round = h.data.round;
  }
  const answer5 = playerById.get(round.debugAnswer);
  const alias = (answer5.aliases && answer5.aliases[0]) || answer5.ko;
  const correct5 = await api(`/api/game/${gameId}/guess`, {
    method: 'POST',
    body: JSON.stringify({ guess: alias }),
  });
  assert.strictEqual(correct5.data.correct, true);
  assert.strictEqual(correct5.data.roundScore, 20);
  assert.ok(correct5.data.gameOver, '5라운드 후 게임 종료');
  const over = correct5.data.gameOver;
  assert.strictEqual(over.totalScore, 180); // 60 + 100 + 0 + 0 + 20
  assert.strictEqual(over.correctRounds, 3);
  assert.strictEqual(over.rounds.length, ROUNDS_PER_GAME);
  console.log(`✓ 별칭("${alias}") 정답 인정, 최종 점수 180점`);

  // --- 종료 전 게임에 추가 액션 거부 ---
  const afterOver = await api(`/api/game/${gameId}/guess`, {
    method: 'POST',
    body: JSON.stringify({ guess: 'x' }),
  });
  assert.strictEqual(afterOver.status, 400);

  // --- 리더보드 등록 ---
  const submit = await api(`/api/game/${gameId}/submit`, {
    method: 'POST',
    body: JSON.stringify({ name: '테스트왕' }),
  });
  assert.strictEqual(submit.status, 200);
  assert.strictEqual(submit.data.rank, 1);
  assert.strictEqual(submit.data.entries[0].name, '테스트왕');
  assert.strictEqual(submit.data.entries[0].score, 180);
  console.log('✓ 리더보드 등록, 1위 확인');

  // --- 중복 등록 거부 ---
  const dupe = await api(`/api/game/${gameId}/submit`, {
    method: 'POST',
    body: JSON.stringify({ name: '중복' }),
  });
  assert.strictEqual(dupe.status, 400);
  console.log('✓ 중복 등록 거부');

  // --- 리더보드 조회 및 정렬 (두 번째 게임으로 더 높은 점수 등록) ---
  const g2 = await api('/api/game', { method: 'POST' });
  let r2 = g2.data.round;
  let total2 = 0;
  for (let i = 0; i < ROUNDS_PER_GAME; i++) {
    const ans = playerById.get(r2.debugAnswer);
    const res = await api(`/api/game/${g2.data.gameId}/guess`, {
      method: 'POST',
      body: JSON.stringify({ guess: ans.name }),
    });
    assert.strictEqual(res.data.correct, true, `게임2 라운드${i + 1} 정답`);
    total2 = res.data.totalScore;
    if (res.data.nextRound) r2 = res.data.nextRound;
  }
  assert.strictEqual(total2, 500, '전 라운드 첫 힌트 정답 = 만점 500');
  const submit2 = await api(`/api/game/${g2.data.gameId}/submit`, {
    method: 'POST',
    body: JSON.stringify({ name: '만점자' }),
  });
  assert.strictEqual(submit2.data.rank, 1, '만점자가 1위로 등극');
  const lb = await api('/api/leaderboard');
  assert.strictEqual(lb.data.entries[0].name, '만점자');
  assert.strictEqual(lb.data.entries[1].name, '테스트왕');
  console.log('✓ 만점(500점) 게임 및 리더보드 정렬 확인');

  // --- 잘못된 게임 ID ---
  const notFound = await api('/api/game/00000000-0000-0000-0000-000000000000/guess', {
    method: 'POST',
    body: JSON.stringify({ guess: 'x' }),
  });
  assert.strictEqual(notFound.status, 404);
  console.log('✓ 존재하지 않는 게임 ID 404');

  console.log('\n모든 테스트 통과! 🏀');
}

const server = createServer();
server.listen(0, async () => {
  base = `http://localhost:${server.address().port}`;
  try {
    await run();
    process.exit(0);
  } catch (err) {
    console.error('\n테스트 실패:', err);
    process.exit(1);
  }
});
