// Guess This NBA Player — 클라이언트 로직

const $ = (sel) => document.querySelector(sel);

const state = {
  gameId: null,
  round: null,       // 서버가 내려주는 현재 라운드 뷰
  pending: null,     // 라운드 종료 모달 이후 적용할 nextRound / gameOver
  players: [],       // 자동완성용 [{name, ko}]
  acIndex: -1,       // 자동완성 키보드 선택 인덱스
};

function normalize(s) {
  return String(s || '').normalize('NFC').toLowerCase().replace(/[\s.\-'’‘"“”·,]/g, '');
}

async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '요청에 실패했습니다.');
  return data;
}

// ---------- 화면 전환 ----------

function showView(id) {
  for (const v of document.querySelectorAll('.view')) v.classList.add('hidden');
  $(id).classList.remove('hidden');
}

// ---------- 리더보드 ----------

function renderLeaderboard(container, entries, myRank) {
  if (!entries || entries.length === 0) {
    container.innerHTML = '<p class="muted">아직 등록된 기록이 없습니다. 첫 번째 주인공이 되어보세요!</p>';
    return;
  }
  const rows = entries.map((e, i) => {
    const rank = i + 1;
    const cls = ['top1', 'top2', 'top3'][i] || '';
    const medal = ['🥇', '🥈', '🥉'][i] || rank;
    const date = new Date(e.date).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
    const highlight = myRank === rank ? ' style="background: rgba(249,115,22,0.08)"' : '';
    return `<tr class="${cls}"${highlight}>
      <td class="rank">${medal}</td>
      <td>${escapeHtml(e.name)}</td>
      <td class="score">${e.score}점</td>
      <td class="date">${date}</td>
    </tr>`;
  }).join('');
  container.innerHTML = `<table class="lb-table">
    <thead><tr><th>순위</th><th>닉네임</th><th style="text-align:right">점수</th><th style="text-align:right">날짜</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function loadHomeLeaderboard() {
  try {
    const data = await api('/api/leaderboard');
    renderLeaderboard($('#home-leaderboard'), data.entries);
  } catch {
    $('#home-leaderboard').innerHTML = '<p class="muted">리더보드를 불러오지 못했습니다.</p>';
  }
}

// ---------- 게임 진행 ----------

function renderRound() {
  const r = state.round;
  $('#round-label').textContent = `라운드 ${r.roundIndex + 1} / ${r.totalRounds}`;
  $('#score-label').textContent = `총점 ${r.totalScore}`;
  $('#potential-score').textContent = `+${r.potentialScore}점`;

  $('#hint-dots').innerHTML = Array.from({ length: r.maxHints }, (_, i) =>
    `<span class="${i < r.hintsRevealed ? 'on' : ''}"></span>`).join('');

  $('#hint-list').innerHTML = r.hints.map((h, i) =>
    `<li><span class="hint-no">힌트 ${i + 1}</span>${escapeHtml(h)}</li>`).join('');

  $('#btn-hint').disabled = r.hintsRevealed >= r.maxHints;
  $('#btn-hint').textContent = r.hintsRevealed >= r.maxHints
    ? '힌트를 모두 확인했습니다'
    : `다음 힌트 보기 (+${r.maxHints - r.hintsRevealed}개 남음)`;
}

function setFeedback(msg, kind) {
  const el = $('#feedback');
  if (!msg) { el.classList.add('hidden'); return; }
  el.textContent = msg;
  el.className = `feedback ${kind}`;
}

async function startGame() {
  const btn = $('#btn-start');
  btn.disabled = true;
  try {
    const data = await api('/api/game', { method: 'POST' });
    state.gameId = data.gameId;
    state.round = data.round;
    state.pending = null;
    setFeedback(null);
    $('#guess-input').value = '';
    renderRound();
    showView('#view-game');
    $('#guess-input').focus();
  } catch (e) {
    alert(e.message);
  } finally {
    btn.disabled = false;
  }
}

async function requestHint() {
  try {
    const data = await api(`/api/game/${state.gameId}/hint`, { method: 'POST' });
    state.round = data.round;
    setFeedback('힌트가 추가로 공개됐습니다. 획득 가능 점수가 낮아집니다!', 'info');
    renderRound();
  } catch (e) {
    setFeedback(e.message, 'wrong');
  }
}

async function submitGuess() {
  const input = $('#guess-input');
  const guess = input.value.trim();
  if (!guess) { input.focus(); return; }
  hideAutocomplete();

  try {
    const data = await api(`/api/game/${state.gameId}/guess`, {
      method: 'POST',
      body: JSON.stringify({ guess }),
    });

    if (data.correct) {
      input.value = '';
      showRoundModal({
        emoji: '🎉',
        title: `정답! +${data.roundScore}점`,
        player: data.player,
        detail: `힌트 ${data.hintsUsed}개 만에 맞췄습니다. (총점 ${data.totalScore}점)`,
        data,
      });
    } else if (data.roundFailed) {
      input.value = '';
      showRoundModal({
        emoji: '😢',
        title: '라운드 실패...',
        player: data.player,
        detail: `정답을 맞추지 못했습니다. (총점 ${data.totalScore}점)`,
        data,
      });
    } else {
      // 오답 → 다음 힌트 자동 공개
      state.round = data.round;
      input.value = '';
      setFeedback('오답! 다음 힌트가 공개됩니다.', 'wrong');
      renderRound();
      input.focus();
    }
  } catch (e) {
    setFeedback(e.message, 'wrong');
  }
}

async function giveUp() {
  if (!confirm('이 라운드를 포기할까요? 0점 처리됩니다.')) return;
  try {
    const data = await api(`/api/game/${state.gameId}/giveup`, { method: 'POST' });
    showRoundModal({
      emoji: '🏳️',
      title: '라운드 포기',
      player: data.player,
      detail: `정답이 공개됐습니다. (총점 ${data.totalScore}점)`,
      data,
    });
  } catch (e) {
    setFeedback(e.message, 'wrong');
  }
}

// ---------- 라운드 결과 모달 ----------

function showRoundModal({ emoji, title, player, detail, data }) {
  $('#round-result-emoji').textContent = emoji;
  $('#round-result-title').textContent = title;
  $('#round-result-player').textContent = `${player.ko} (${player.name})`;
  $('#round-result-detail').textContent = detail;
  $('#round-result-hints').innerHTML = player.hints.map((h, i) =>
    `<li><span class="hint-no">힌트 ${i + 1}</span>${escapeHtml(h)}</li>`).join('');
  $('#round-result-hints-wrap').open = false;

  state.pending = data;
  $('#btn-next-round').textContent = data.gameOver ? '최종 결과 보기' : '다음 라운드';
  $('#round-modal').classList.remove('hidden');
  $('#btn-next-round').focus();
}

function proceedFromModal() {
  $('#round-modal').classList.add('hidden');
  const data = state.pending;
  state.pending = null;

  if (data.gameOver) {
    showGameOver(data.gameOver);
  } else {
    state.round = data.nextRound;
    setFeedback(null);
    renderRound();
    showView('#view-game');
    $('#guess-input').focus();
  }
}

// ---------- 게임 종료 ----------

function showGameOver(over) {
  $('#final-score').textContent = over.totalScore;
  $('#final-summary').textContent = `5라운드 중 ${over.correctRounds}라운드 정답`;

  $('#round-summary-body').innerHTML = over.rounds.map((r, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${escapeHtml(r.player)}</td>
      <td class="${r.correct ? 'ok' : 'fail'}">${r.correct ? `정답 (힌트 ${r.hintsUsed}개)` : '실패'}</td>
      <td>${r.score}점</td>
    </tr>`).join('');

  $('#submit-block').classList.remove('hidden');
  $('#submit-result').classList.add('hidden');
  $('#submit-feedback').classList.add('hidden');
  $('#nickname-input').value = localStorage.getItem('gtnp-nickname') || '';
  $('#over-leaderboard').innerHTML = '';
  showView('#view-over');
}

async function submitScore() {
  const name = $('#nickname-input').value.trim();
  const fb = $('#submit-feedback');
  if (!name) {
    fb.textContent = '닉네임을 입력해 주세요.';
    fb.className = 'feedback wrong';
    return;
  }
  localStorage.setItem('gtnp-nickname', name);
  $('#btn-submit-score').disabled = true;
  try {
    const data = await api(`/api/game/${state.gameId}/submit`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    $('#submit-block').classList.add('hidden');
    const result = $('#submit-result');
    result.textContent = data.rank
      ? `🏆 글로벌 ${data.rank}위에 등록됐습니다!`
      : `기록이 등록됐습니다. (상위 ${data.total}명 안에는 들지 못했어요)`;
    result.classList.remove('hidden');
    renderLeaderboard($('#over-leaderboard'), data.entries, data.rank);
  } catch (e) {
    fb.textContent = e.message;
    fb.className = 'feedback wrong';
  } finally {
    $('#btn-submit-score').disabled = false;
  }
}

// ---------- 자동완성 ----------

async function loadPlayers() {
  try {
    state.players = await api('/api/players');
  } catch {
    state.players = [];
  }
}

function updateAutocomplete() {
  const q = normalize($('#guess-input').value);
  const box = $('#autocomplete');
  if (!q) { hideAutocomplete(); return; }

  const matches = state.players
    .filter((p) => normalize(p.ko).includes(q) || normalize(p.name).includes(q))
    .slice(0, 8);

  if (matches.length === 0) { hideAutocomplete(); return; }

  box.innerHTML = matches.map((p) =>
    `<li data-name="${escapeHtml(p.ko)}"><span>${escapeHtml(p.ko)}</span><span class="en">${escapeHtml(p.name)}</span></li>`).join('');
  box.classList.remove('hidden');
  state.acIndex = -1;

  for (const li of box.querySelectorAll('li')) {
    li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      $('#guess-input').value = li.dataset.name;
      hideAutocomplete();
      $('#guess-input').focus();
    });
  }
}

function hideAutocomplete() {
  $('#autocomplete').classList.add('hidden');
  state.acIndex = -1;
}

function handleAutocompleteKeys(e) {
  const box = $('#autocomplete');
  const items = box.querySelectorAll('li');
  const open = !box.classList.contains('hidden') && items.length > 0;

  if (e.key === 'Enter') {
    if (open && state.acIndex >= 0) {
      e.preventDefault();
      $('#guess-input').value = items[state.acIndex].dataset.name;
      hideAutocomplete();
    } else {
      e.preventDefault();
      submitGuess();
    }
    return;
  }
  if (!open) return;

  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const dir = e.key === 'ArrowDown' ? 1 : -1;
    state.acIndex = (state.acIndex + dir + items.length) % items.length;
    items.forEach((li, i) => li.classList.toggle('active', i === state.acIndex));
  } else if (e.key === 'Escape') {
    hideAutocomplete();
  }
}

// ---------- 이벤트 바인딩 ----------

$('#btn-start').addEventListener('click', startGame);
$('#btn-guess').addEventListener('click', submitGuess);
$('#btn-hint').addEventListener('click', requestHint);
$('#btn-giveup').addEventListener('click', giveUp);
$('#btn-next-round').addEventListener('click', proceedFromModal);
$('#btn-submit-score').addEventListener('click', submitScore);
$('#btn-restart').addEventListener('click', () => {
  showView('#view-home');
  loadHomeLeaderboard();
});

$('#guess-input').addEventListener('input', updateAutocomplete);
$('#guess-input').addEventListener('keydown', handleAutocompleteKeys);
$('#guess-input').addEventListener('blur', () => setTimeout(hideAutocomplete, 150));
$('#nickname-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitScore();
});

// 초기화
loadPlayers();
loadHomeLeaderboard();
