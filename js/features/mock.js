// Mock draft view — run an AI-driven auction sim and see the results. Supports
// single-run, Monte Carlo, and a "constrain my team" mode (TBD next).

const _mockState = {
  lastRun: null,        // { picks, states }
  lastMonteCarlo: null, // [{ name, pos, mean, median, ... }]
  running: false,
  view: "single",       // "single" | "mc"
};

function renderMock() {
  const root = document.getElementById("view-root");
  if (!getValues().length) {
    root.innerHTML = '<div class="empty"><p>Mock requires projections.</p><p class="small">Import a FanGraphs CSV on the Data tab.</p></div>';
    return;
  }

  let html = '';

  // Controls
  html += '<div class="card">';
  html += '<h2>Mock Draft Simulator</h2>';
  html += '<p class="muted small">Runs a full auction with AI bidders using current keepers and budgets. Results show every pick, surplus captured, and per-team summaries.</p>';
  html += '<div style="display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 10px;">';
  html += '<button class="btn primary" style="width:auto; padding: 8px 16px;" id="mock-run">Run 1 Mock</button>';
  html += '<button class="btn" id="mock-mc">Run 25 Mocks (Monte Carlo)</button>';
  html += '<button class="btn" id="mock-mc-100">Run 100 Mocks</button>';
  if (_mockState.lastRun || _mockState.lastMonteCarlo) {
    html += '<span class="muted small" style="margin-left: 12px;">View:</span>';
    html += '<button class="btn ' + (_mockState.view === "single" ? "primary" : "") + '" id="mock-view-single" style="padding: 6px 12px; width: auto;">Last Run</button>';
    html += '<button class="btn ' + (_mockState.view === "mc" ? "primary" : "") + '" id="mock-view-mc" style="padding: 6px 12px; width: auto;">Monte Carlo</button>';
  }
  html += '</div>';
  if (_mockState.running) html += '<p class="small muted" style="margin-top: 10px;">Running…</p>';
  html += '</div>';

  if (_mockState.view === "mc" && _mockState.lastMonteCarlo) {
    html += renderMockMonteCarlo();
  } else if (_mockState.lastRun) {
    html += renderMockSingle();
  } else {
    html += '<div class="empty"><p>Click "Run 1 Mock" to simulate the draft.</p></div>';
  }

  root.innerHTML = html;

  // Wire buttons
  document.getElementById("mock-run")?.addEventListener("click", () => {
    _mockState.running = true; renderMock();
    setTimeout(() => {
      _mockState.lastRun = runMockDraft();
      _mockState.view = "single";
      _mockState.running = false;
      renderMock();
    }, 30);
  });
  document.getElementById("mock-mc")?.addEventListener("click", () => runMC(25));
  document.getElementById("mock-mc-100")?.addEventListener("click", () => runMC(100));
  document.getElementById("mock-view-single")?.addEventListener("click", () => { _mockState.view = "single"; renderMock(); });
  document.getElementById("mock-view-mc")?.addEventListener("click", () => { _mockState.view = "mc"; renderMock(); });
}

function runMC(n) {
  _mockState.running = true; renderMock();
  // Let UI paint the "running" state before blocking
  setTimeout(() => {
    _mockState.lastMonteCarlo = runMockDraftMonteCarlo(n);
    _mockState.view = "mc";
    _mockState.running = false;
    renderMock();
  }, 30);
}

function renderMockSingle() {
  const { picks, states } = _mockState.lastRun;
  const myId = getMyTeam()?.id;
  const me = myId ? states[myId] : null;

  let html = '';

  // Per-team summaries
  html += '<div class="card"><h2>Team Results</h2><table><thead><tr>';
  html += '<th>Team</th><th>Owner</th><th class="num">Spent</th><th class="num">Leftover</th><th class="num">Players</th><th class="num">Avg Surplus</th></tr></thead><tbody>';
  const teamRows = Object.values(states).map(s => {
    const spent = s.drafted.reduce((x, d) => x + d.price, 0);
    const surplus = s.drafted.reduce((x, d) => x + ((d.value || 0) - d.price), 0);
    const leftover = s.budget;
    return { ...s, spent, surplus, leftover };
  });
  // Sort: me first, then by surplus desc
  teamRows.sort((a, b) => {
    if (a.isMe !== b.isMe) return a.isMe ? -1 : 1;
    return b.surplus - a.surplus;
  });
  for (const t of teamRows) {
    html += '<tr' + (t.isMe ? ' style="background: rgba(79,142,247,.08);"' : '') + '>';
    html += '<td>' + esc(t.teamName) + (t.isMe ? ' <span class="kbd">you</span>' : '') + '</td>';
    html += '<td>' + esc(t.ownerName) + '</td>';
    html += '<td class="num">$' + t.spent + '</td>';
    html += '<td class="num ' + (t.leftover < 0 ? 'bad' : '') + '">$' + t.leftover + '</td>';
    html += '<td class="num">' + t.drafted.length + '</td>';
    html += '<td class="num ' + (t.surplus > 0 ? 'good' : 'bad') + '">' + (t.surplus > 0 ? '+' : '') + '$' + t.surplus.toFixed(0) + '</td>';
    html += '</tr>';
  }
  html += '</tbody></table></div>';

  // My team detail (if exists)
  if (me) {
    html += '<div class="card"><h2>Hold the Mayo — Detail</h2>';
    if (me.drafted.length === 0) {
      html += '<p class="muted">No picks made.</p>';
    } else {
      html += '<table><thead><tr><th>Player</th><th>Pos</th><th class="num">Value</th><th class="num">Price</th><th class="num">Surplus</th></tr></thead><tbody>';
      for (const d of me.drafted) {
        html += '<tr><td>' + esc(d.name) + '</td>';
        html += '<td>' + esc(d.pos) + '</td>';
        html += '<td class="num">$' + d.value.toFixed(0) + '</td>';
        html += '<td class="num">$' + d.price + '</td>';
        const drSurp = (d.value || 0) - d.price;
        html += '<td class="num ' + (drSurp > 0 ? 'good' : 'bad') + '">' + (drSurp > 0 ? '+' : '') + '$' + drSurp.toFixed(0) + '</td></tr>';
      }
      html += '</tbody></table></div>';
    }
  }

  // All picks
  html += '<div class="card"><h2>All Picks (' + picks.length + ')</h2>';
  html += '<table><thead><tr><th class="num">#</th><th>Player</th><th>Pos</th><th>Winner</th><th class="num">Value</th><th class="num">Price</th><th class="num">Surplus</th></tr></thead><tbody>';
  for (const p of picks) {
    const isMyPick = p.winnerTeamId === myId;
    html += '<tr' + (isMyPick ? ' style="background: rgba(79,142,247,.05);"' : '') + '>';
    html += '<td class="num dim">' + p.idx + '</td>';
    html += '<td>' + esc(p.player) + '</td>';
    html += '<td>' + esc(p.pos) + '</td>';
    html += '<td>' + esc(p.winnerOwner) + (isMyPick ? ' <span class="kbd">you</span>' : '') + '</td>';
    html += '<td class="num">$' + p.baseValue.toFixed(0) + '</td>';
    html += '<td class="num">$' + p.price + '</td>';
    html += '<td class="num ' + (p.surplus > 0 ? 'good' : 'bad') + '">' + (p.surplus > 0 ? '+' : '') + '$' + p.surplus.toFixed(0) + '</td>';
    html += '</tr>';
  }
  html += '</tbody></table></div>';

  return html;
}

function renderMockMonteCarlo() {
  const data = _mockState.lastMonteCarlo;
  let html = '<div class="card"><h2>Monte Carlo Price Distribution</h2>';
  html += '<p class="muted small">Across ' + (data[0]?.n || 0) + ' simulated drafts. p10/p90 = 10th and 90th percentile prices, showing the range of plausible auction outcomes.</p>';
  html += '<table><thead><tr><th>Player</th><th>Pos</th><th class="num">Proj Value</th><th class="num">Mean $</th><th class="num">Median</th><th class="num">p10</th><th class="num">p90</th><th>Most Likely Owner</th></tr></thead><tbody>';
  for (const r of data.slice(0, 200)) {
    const meanDelta = r.mean - r.value;
    html += '<tr>';
    html += '<td>' + esc(r.name) + '</td>';
    html += '<td>' + esc(r.pos) + '</td>';
    html += '<td class="num">$' + r.value.toFixed(0) + '</td>';
    html += '<td class="num ' + (meanDelta > 0 ? 'bad' : 'good') + '">$' + r.mean.toFixed(1) + '</td>';
    html += '<td class="num">$' + r.median + '</td>';
    html += '<td class="num">$' + r.p10 + '</td>';
    html += '<td class="num">$' + r.p90 + '</td>';
    html += '<td>' + esc(r.topTeam) + ' <span class="muted small">' + Math.round(r.topTeamShare * 100) + '%</span></td>';
    html += '</tr>';
  }
  html += '</tbody></table>';
  if (data.length > 200) html += '<p class="muted small" style="margin-top: 8px;">Showing top 200 of ' + data.length + '.</p>';
  html += '</div>';
  return html;
}
