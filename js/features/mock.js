// Mock Draft view. Two modes:
//   - Auto (instant): runs a full sim with all AI agents, shows results.
//   - Interactive: you play as your team and bid against AI for every player.

const _mockState = {
  mode: "auto",        // "auto" | "interactive"
  lastRun: null,
  lastMonteCarlo: null,
  running: false,
  view: "single",
  lastBacktest: null,
  boardExpanded: false, // interactive Board: compact (top per pos) vs full
};

function renderMock() {
  const root = document.getElementById("view-root");
  if (!getValues().length) {
    root.innerHTML = '<div class="empty"><p>Mock requires projections.</p><p class="small">Import a FanGraphs CSV on the Data tab.</p></div>';
    return;
  }

  let html = '';
  html += '<div class="card"><h2>Mock Draft Simulator</h2>';
  html += '<p class="muted small">Auto: instant full-sim with AI bidders. Interactive: you bid against the AI for every player using each owner\'s history-derived tendencies.</p>';
  html += '<div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">';
  html += '<button class="btn ' + (_mockState.mode === "auto" ? "primary" : "") + '" id="mock-mode-auto" style="width:auto; padding:8px 14px;">Auto</button>';
  html += '<button class="btn ' + (_mockState.mode === "interactive" ? "primary" : "") + '" id="mock-mode-interactive" style="width:auto; padding:8px 14px;">Interactive</button>';
  html += '<span class="muted small" style="margin-left: 14px;">' + (_mockState.mode === "auto" ? "Click run to simulate." : "You bid live against the AI.") + '</span>';
  html += '</div></div>';

  if (_mockState.mode === "auto") {
    html += renderAutoMockControls();
    if (_mockState.view === "backtest" && _mockState.lastBacktest) html += renderMockBacktest();
    else if (_mockState.view === "mc" && _mockState.lastMonteCarlo) html += renderMockMonteCarlo();
    else if (_mockState.lastRun) html += renderMockSingle();
    else html += '<div class="empty"><p>Click "Run 1 Mock" to simulate the draft.</p></div>';
  } else {
    html += renderInteractiveMock();
  }

  root.innerHTML = html;
  wireMockControls();
}

function renderAutoMockControls() {
  let html = '<div class="card"><div style="display: flex; gap: 8px; flex-wrap: wrap; align-items: center;">';
  html += '<button class="btn primary" style="width:auto; padding: 8px 16px;" id="mock-run">Run 1 Mock</button>';
  html += '<button class="btn" id="mock-mc">Run 25 Mocks (Monte Carlo)</button>';
  html += '<button class="btn" id="mock-mc-100">Run 100 Mocks</button>';
  html += '<button class="btn" id="mock-backtest" title="Score the AI\'s simulated behavior against each owner\'s real draft history">Validate vs History</button>';
  if (_mockState.lastRun || _mockState.lastMonteCarlo) {
    html += '<span class="muted small" style="margin-left: 12px;">View:</span>';
    html += '<button class="btn ' + (_mockState.view === "single" ? "primary" : "") + '" id="mock-view-single" style="padding: 6px 12px; width: auto;">Last Run</button>';
    html += '<button class="btn ' + (_mockState.view === "mc" ? "primary" : "") + '" id="mock-view-mc" style="padding: 6px 12px; width: auto;">Monte Carlo</button>';
    if (_mockState.lastBacktest) html += '<button class="btn ' + (_mockState.view === "backtest" ? "primary" : "") + '" id="mock-view-backtest" style="padding: 6px 12px; width: auto;">Validation</button>';
  }
  if (_mockState.running) html += '<span class="small muted" style="margin-left: 10px;">Running…</span>';
  html += '</div></div>';
  return html;
}

// Backtest report: how closely the AI's simulated behavior matches each
// owner's real draft-history profile. Lower error = the profiles are shaping
// the sim. Owners are sorted by historical stars+scrubs tendency.
function renderMockBacktest() {
  const bt = _mockState.lastBacktest;
  if (!bt) return '';
  if (bt.error) return '<div class="card"><h3>Validation vs History</h3><p class="muted small">' + esc(bt.error) + '</p></div>';
  const pct = x => (x * 100).toFixed(0) + '%';
  const d1 = x => (x == null ? '—' : x.toFixed(1));
  let html = '<div class="card"><h3>Validation vs History <span class="muted small">' + bt.n + ' sims</span></h3>';
  html += '<p class="muted small">Simulated owner behavior vs their real draft-history profile. Close columns mean the AI is drafting like the actual owner. Big gaps flag where to tune. (Current keepers/projections differ from past years, so expect some spread — watch the <em>ordering</em> and systematic bias.)</p>';
  html += '<div style="overflow-x:auto"><table class="data-table"><thead><tr>' +
    '<th>Owner</th>' +
    '<th>Top-3 $ share<br><span class="muted small">sim / real</span></th>' +
    '<th>Big bids ≥$25<br><span class="muted small">sim / real</span></th>' +
    '<th>Max bid<br><span class="muted small">sim / real</span></th>' +
    '</tr></thead><tbody>';
  for (const r of bt.rows) {
    html += '<tr>' +
      '<td>' + esc(r.owner) + '</td>' +
      '<td>' + pct(r.sim.top3Share) + ' / ' + (r.hist.top3Share != null ? pct(r.hist.top3Share) : '—') + '</td>' +
      '<td>' + d1(r.sim.bigBids) + ' / ' + d1(r.hist.bigBids) + '</td>' +
      '<td>$' + d1(r.sim.maxBid) + ' / $' + d1(r.hist.maxBid) + '</td>' +
      '</tr>';
  }
  html += '</tbody></table></div>';
  html += '<div class="muted small" style="margin-top:10px">Mean abs. error — top-3 share: ' + pct(bt.mae.top3Share) +
    ' · big bids: ' + bt.mae.bigBids.toFixed(2) + ' · max bid: $' + bt.mae.maxBid.toFixed(1) +
    '. Lower is better; re-run after tuning to see it drop.</div>';
  html += '</div>';
  return html;
}

function renderInteractiveMock() {
  const s = getInteractiveState();
  let html = '';

  if (!s.active) {
    html += '<div class="card"><h3>Start a Live Mock</h3>';
    html += '<p class="muted small">You\'ll nominate when it\'s your turn (random order). For other teams, the AI uses each owner\'s historical tendency profile to bid. Press start when ready.</p>';
    html += '<button class="btn primary" id="interactive-start" style="width:auto; padding: 10px 22px;">Start Interactive Mock</button>';
    html += '</div>';
    return html;
  }

  // Active session
  const me = getMyTeam();
  const myState = s.states[me?.id];
  const nominatorId = s.nominationOrder[s.currentNominator % s.nominationOrder.length];
  const nominator = s.states[nominatorId];

  // Status header
  html += '<div class="card" style="border-color: rgba(79,142,247,.4);">';
  html += '<div style="display: flex; justify-content: space-between; align-items: center;">';
  html += '<h2 style="margin: 0;">Live Mock <span class="muted small">· ' + s.picks.length + ' picks done</span></h2>';
  html += '<button class="btn ghost danger" id="interactive-stop">End Mock</button>';
  html += '</div></div>';

  // === Phase: nominating ===
  if (s.phase === "nominating") {
    if (nominatorId === me?.id) {
      // User's turn to nominate
      html += '<div class="card on-the-clock">';
      html += '<div class="otc-label">Your turn to nominate</div>';
      html += '<div style="display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px;">';
      html += '<input id="im-nominate-name" placeholder="Player name…" style="flex: 1; min-width: 240px; font-size: 16px;" list="im-pool-list">';
      html += '<datalist id="im-pool-list">';
      for (const p of s.pool.slice(0, 200)) {
        html += '<option value="' + esc(p.name) + '">' + esc(p.posKey) + ' · $' + p.value.toFixed(0) + '</option>';
      }
      html += '</datalist>';
      html += '<input id="im-nominate-open" type="number" placeholder="Opening $" value="1" style="width: 110px; font-size: 16px;">';
      html += '<button class="btn primary" id="im-nominate" style="width:auto; padding: 10px 18px;">Nominate</button>';
      html += '</div>';
      const maxBid = myState.budget - Math.max(0, myState.slotsRemaining - 1);
      html += '<div class="muted small" style="margin-top: 8px;">Your max bid right now: $' + maxBid + ' · ' + myState.slotsRemaining + ' slots left, $' + myState.budget + ' budget</div>';
      html += '</div>';
    } else {
      html += '<div class="card"><p>' + esc(nominator.ownerName) + ' is nominating…</p></div>';
    }
  }

  // === Phase: bidding ===
  if (s.phase === "bidding" && s.current) {
    const nfbc = (typeof getNfbc === "function") ? getNfbc(s.current.name) : null;
    const sc = (typeof getStatcast === "function") ? getStatcast(s.current.name) : null;
    const inflV = inflatedValue(s.current, s.inflation);
    const isMyBid = s.currentWinner === me?.id;
    const iHavePassed = s.passedTeams && s.passedTeams.has(me?.id);
    const winnerTeam = s.states[s.currentWinner];

    html += '<div class="card on-the-clock">';
    html += '<div class="otc-grid">';
    html += '<div class="otc-main">';
    html += '<div class="otc-label">On the Clock · nominated by ' + esc(nominator.ownerName) + '</div>';
    html += '<div class="otc-player">' + esc(s.current.name) + '</div>';
    html += '<div class="otc-meta">';
    html += '<span class="kbd">' + esc(s.current.posKey) + '</span>';
    if (s.current.team) html += ' <span class="muted">' + esc(s.current.team) + '</span>';
    html += ' · <span class="muted">value</span> $' + s.current.value.toFixed(0);
    html += ' · <span class="muted">inflated</span> $' + inflV.toFixed(0);
    if (nfbc?.avg) html += ' · <span class="muted">NFBC</span> $' + nfbc.avg.toFixed(0);
    if (sc?.xwOBA) html += ' · <span class="muted">xwOBA</span> ' + sc.xwOBA.toFixed(3);
    html += '</div>';
    html += '</div>';
    // Value verdict vs the current bid — the price-discipline signal.
    const myMax = myState ? Math.max(0, myState.budget - Math.max(0, myState.slotsRemaining - 1)) : 0;
    let verdict = "";
    if (s.currentBid <= inflV * 0.85) verdict = '<div class="otc-signal buy">VALUE · $' + Math.round(inflV - s.currentBid) + ' under par</div>';
    else if (s.currentBid >= inflV * 1.10) verdict = '<div class="otc-signal sell">OVERPAY · $' + Math.round(s.currentBid - inflV) + ' over par</div>';
    else verdict = '<div class="otc-signal" style="opacity:.8;">FAIR · ~par ($' + inflV.toFixed(0) + ')</div>';

    html += '<div class="otc-bid">';
    html += '<div class="otc-bid-label">Current bid · ' + esc(winnerTeam.ownerName) + (isMyBid ? ' (you)' : '') + '</div>';
    html += '<div class="otc-bid-amt">$' + s.currentBid + '</div>';
    html += verdict;
    html += '<div class="muted small" style="margin-top:4px;">Your max bid: $' + myMax + (myMax < inflV ? ' <span style="color:var(--bad);">(can\'t reach par)</span>' : '') + '</div>';
    if (!isMyBid && !iHavePassed) {
      html += '<div class="otc-bid-controls" style="margin-top: 6px;">';
      for (const inc of [1, 2, 5]) {
        html += '<button class="btn primary im-bid" data-inc="' + inc + '" style="width:auto; padding: 6px 12px;">+$' + inc + '</button>';
      }
      // Jump straight to par (fair value) — one click on a star.
      if (Math.round(inflV) > s.currentBid && Math.round(inflV) <= myMax) {
        html += '<button class="btn im-bid" data-to="' + Math.round(inflV) + '" style="width:auto; padding: 6px 10px;" title="Bid to par/fair value">→ $' + Math.round(inflV) + '</button>';
      }
      html += '<input id="im-custom-bid" type="number" min="' + (s.currentBid + 1) + '" placeholder="$" style="width: 70px;">';
      html += '<button class="btn im-bid-custom" style="width:auto; padding: 6px 10px;">Bid</button>';
      html += '</div>';
      html += '<div style="margin-top: 6px;"><button class="btn ghost" id="im-pass">Pass</button></div>';
    } else if (isMyBid) {
      html += '<p class="small good" style="margin-top: 8px;">Highest bidder. AI is responding…</p>';
    } else {
      html += '<p class="small muted" style="margin-top: 8px;">You passed on this auction.</p>';
    }
    html += '</div></div>';
    html += '</div>';
  }

  // === Phase: sold (transient) ===
  if (s.phase === "sold" && s.picks.length) {
    const last = s.picks[s.picks.length - 1];
    html += '<div class="card"><p>SOLD: <strong>' + esc(last.player) + '</strong> to <strong>' + esc(last.winnerOwner) + '</strong> for <strong>$' + last.price + '</strong></p></div>';
  }

  // Your roster + a live Board of remaining players, for bid decisions.
  if (_mockState.boardExpanded) {
    html += renderMockRoster(myState);
    html += renderMockBoard(s, true);   // full-width board
  } else {
    html += '<div class="grid cols-2">';
    html += renderMockRoster(myState);
    html += renderMockBoard(s, false);
    html += '</div>';
  }

  // Team strip (compact)
  html += '<div class="card" style="padding: 8px;">';
  html += '<h3 style="margin: 0 0 6px;">Teams</h3>';
  html += '<div class="team-strip">';
  for (const teamId of Object.keys(s.states)) {
    const ts = s.states[teamId];
    const perSlot = ts.slotsRemaining > 0 ? (ts.budget / ts.slotsRemaining).toFixed(1) : "—";
    const maxBid = Math.max(0, ts.budget - Math.max(0, ts.slotsRemaining - 1));
    html += '<div class="team-strip-card' + (ts.isMe ? " me" : "") + (ts.slotsRemaining === 0 ? " done" : "") + '">';
    html += '<div class="ts-name">' + esc(ts.ownerName) + '</div>';
    html += '<div class="ts-row"><span class="ts-label">$</span><span class="ts-val">' + ts.budget + '</span></div>';
    html += '<div class="ts-row"><span class="ts-label">slots</span><span class="ts-val">' + ts.slotsRemaining + '</span></div>';
    html += '<div class="ts-row"><span class="ts-label">max</span><span class="ts-val">' + maxBid + '</span></div>';
    html += '<div class="ts-row"><span class="ts-label">$/sl</span><span class="ts-val">' + perSlot + '</span></div>';
    html += '</div>';
  }
  html += '</div></div>';

  // Recent picks
  if (s.picks.length) {
    html += '<div class="card"><h3>Recent picks</h3>';
    html += '<table style="font-size: 12px;"><thead><tr><th class="num">#</th><th>Player</th><th>Pos</th><th>Winner</th><th class="num">Val</th><th class="num">Price</th><th class="num">Surplus</th></tr></thead><tbody>';
    const myId = me?.id;
    const recent = s.picks.slice(-15).reverse();
    for (const p of recent) {
      const isMine = p.winnerTeamId === myId;
      html += '<tr' + (isMine ? ' style="background: rgba(79,142,247,.06);"' : '') + '>';
      html += '<td class="num dim">' + p.idx + '</td>';
      html += '<td>' + esc(p.player) + '</td>';
      html += '<td>' + esc(p.pos) + '</td>';
      html += '<td>' + esc(p.winnerOwner) + (isMine ? ' <span class="kbd">you</span>' : '') + '</td>';
      html += '<td class="num">$' + p.baseValue.toFixed(0) + '</td>';
      html += '<td class="num">$' + p.price + '</td>';
      html += '<td class="num ' + (p.surplus > 0 ? 'good' : 'bad') + '">' + (p.surplus > 0 ? "+" : "") + '$' + p.surplus.toFixed(0) + '</td>';
      html += '</tr>';
    }
    html += '</tbody></table></div>';
  }

  if (s.phase === "done") {
    const openLeft = Object.values(s.states).reduce((n, t) => n + Math.max(0, t.slotsRemaining), 0);
    if (s.pool.length === 0 && openLeft > 0) {
      html += '<div class="card"><h2>Pool Exhausted</h2><p class="muted">Ran out of valued players with <b>' + openLeft + '</b> roster slot' + (openLeft === 1 ? '' : 's') + ' still open. Load more projections / Dollar Values (Data tab) for a complete draft. Switch to Auto mode for batch sims, or End Mock to reset.</p></div>';
    } else {
      html += '<div class="card"><h2>Mock Complete</h2><p>All rosters filled. Switch to Auto mode for batch sims, or End Mock to reset.</p></div>';
    }
  }

  return html;
}

// Your roster during the mock: keepers + everything you've drafted so far.
function renderMockRoster(myState) {
  if (!myState) return '<div class="card"><h3>Your Roster</h3><p class="muted small">—</p></div>';
  const maxBid = Math.max(0, myState.budget - Math.max(0, myState.slotsRemaining - 1));
  let html = '<div class="card"><h3>Your Roster <span class="muted small">· $' + myState.budget + ' left · ' + myState.slotsRemaining + ' open · max bid $' + maxBid + '</span></h3>';
  // Open slots / positional needs.
  const os = myState.openSlots || {};
  const needBits = [];
  for (const slot of ["C", "1B", "2B", "3B", "SS", "OF", "MI", "CI", "UTIL", "SP", "RP"]) {
    const n = os[slot] || 0; if (n > 0) needBits.push(slot + (n > 1 ? "×" + n : ""));
  }
  if ((os.BENCH || 0) > 0) needBits.push("BN×" + os.BENCH);
  html += '<div class="muted small" style="margin:2px 0 4px;">Needs: ' + (needBits.length ? needBits.join(", ") : "roster full") + '</div>';
  html += '<div class="muted small" style="margin-top:4px;">Keepers (' + (myState.kept ? myState.kept.length : 0) + ')</div>';
  if (myState.kept && myState.kept.length) {
    html += '<table style="font-size:12px;"><tbody>';
    for (const k of myState.kept) html += '<tr><td>' + esc(k.name) + '</td><td class="dim">' + esc(k.pos) + '</td><td class="num">$' + k.price + '</td></tr>';
    html += '</tbody></table>';
  } else html += '<div class="dim small">none</div>';
  html += '<div class="muted small" style="margin-top:8px;">Drafted (' + myState.drafted.length + ')</div>';
  if (myState.drafted.length) {
    html += '<table style="font-size:12px;"><tbody>';
    for (const d of myState.drafted) {
      const surp = (d.value || 0) - d.price;
      html += '<tr><td>' + esc(d.name) + '</td><td class="dim">' + esc(d.pos) + '</td><td class="num">$' + d.price +
        '</td><td class="num ' + (surp > 0 ? 'good' : 'bad') + '">' + (surp > 0 ? '+' : '') + '$' + surp.toFixed(0) + '</td></tr>';
    }
    html += '</tbody></table>';
  } else html += '<div class="dim small">none yet</div>';
  html += '</div>';
  return html;
}

// A Board of players still available, by position, priced at the current mock
// inflation — so you can judge scarcity before bidding. Compact (top per pos) or
// expanded (full, scrollable). Names are click-to-nominate when it's your turn.
function renderMockBoard(s, expanded) {
  const positions = ["C", "1B", "2B", "3B", "SS", "OF", "UTIL", "SP", "RP"];
  const myTurn = s.phase === "nominating" && getCurrentNominatorId() === getMyTeam()?.id;
  const infMult = s.inflation && s.inflation.multiplier ? s.inflation.multiplier.toFixed(2) : "1.00";
  const perCol = expanded ? Infinity : 8;
  let html = '<div class="card">';
  html += '<div style="display:flex; align-items:center; gap:8px;"><h3 style="margin:0;">Board — available (' + s.pool.length + ')</h3>';
  html += '<button class="btn ghost" id="mock-board-toggle" style="width:auto; padding:2px 10px; font-size:12px;">' + (expanded ? "▴ Collapse" : "▾ Expand full board") + '</button></div>';
  html += '<p class="muted small">$ = inflated at ' + infMult + '×.' + (myTurn ? ' Click a name to nominate.' : '') + (expanded ? ' Scroll each column for the full list.' : '') + '</p>';
  html += '<div class="grid ' + (expanded ? 'cols-5' : 'cols-3') + '">';
  for (const pos of positions) {
    const all = s.pool.filter(p => p.posKey === pos);
    if (!all.length) continue;
    const list = perCol === Infinity ? all : all.slice(0, perCol);
    html += '<div><h4 style="margin:4px 0;">' + (pos === "UTIL" ? "DH/UT" : pos) + ' <span class="muted small">' + all.length + '</span></h4>';
    html += '<div style="' + (expanded ? 'max-height:340px; overflow-y:auto;' : '') + '"><table style="font-size:11px; width:100%;"><tbody>';
    for (const p of list) {
      const inf = inflatedValue(p, s.inflation);
      const tier = (typeof tierForValue === "function") ? tierForValue(p.value) : "T3";
      const color = (typeof TIER_COLORS !== "undefined" && TIER_COLORS[tier]) ? TIER_COLORS[tier] : "var(--text)";
      const nameCell = myTurn
        ? '<a href="#" class="mock-nom" data-name="' + esc(p.name) + '">' + esc(p.name) + '</a>'
        : esc(p.name);
      html += '<tr><td><span style="color:' + color + '; font-size:9px;">' + tier + '</span> ' + nameCell + '</td><td class="num">$' + inf.toFixed(0) + '</td></tr>';
    }
    html += '</tbody></table></div></div>';
  }
  html += '</div></div>';
  return html;
}

function wireMockControls() {
  document.getElementById("mock-mode-auto")?.addEventListener("click", () => {
    _mockState.mode = "auto"; renderMock();
  });
  document.getElementById("mock-mode-interactive")?.addEventListener("click", () => {
    _mockState.mode = "interactive"; renderMock();
  });

  // Auto controls
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
  document.getElementById("mock-backtest")?.addEventListener("click", () => {
    _mockState.running = true; renderMock();
    setTimeout(() => {
      _mockState.lastBacktest = runMockBacktest(40);
      _mockState.view = "backtest";
      _mockState.running = false;
      renderMock();
    }, 30);
  });
  document.getElementById("mock-view-single")?.addEventListener("click", () => { _mockState.view = "single"; renderMock(); });
  document.getElementById("mock-view-mc")?.addEventListener("click", () => { _mockState.view = "mc"; renderMock(); });
  document.getElementById("mock-view-backtest")?.addEventListener("click", () => { _mockState.view = "backtest"; renderMock(); });

  // Interactive controls
  document.getElementById("interactive-start")?.addEventListener("click", () => {
    startInteractiveMock();
    renderMock();
  });
  document.getElementById("interactive-stop")?.addEventListener("click", () => {
    stopInteractiveMock();
    renderMock();
  });
  document.getElementById("im-nominate")?.addEventListener("click", () => {
    const name = document.getElementById("im-nominate-name").value.trim();
    const open = parseInt(document.getElementById("im-nominate-open").value, 10) || 1;
    const r = userNominate(name, open);
    if (!r.ok) alert(r.error);
  });
  document.getElementById("im-nominate-name")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("im-nominate")?.click();
  });
  document.querySelectorAll(".im-bid").forEach(b => {
    b.addEventListener("click", () => {
      // Resolve against the LIVE current bid at click time (the rendered value
      // may be stale after an AI bump), so a valid click is never rejected.
      const cur = (typeof getInteractiveState === "function") ? getInteractiveState().currentBid : 0;
      const target = b.dataset.to ? parseInt(b.dataset.to, 10) : cur + (parseInt(b.dataset.inc, 10) || 1);
      const r = userBid(Math.max(cur + 1, target));
      if (!r.ok) alert(r.error);
    });
  });
  document.querySelector(".im-bid-custom")?.addEventListener("click", () => {
    const v = parseInt(document.getElementById("im-custom-bid").value, 10);
    if (!v) return;
    const r = userBid(v);
    if (!r.ok) alert(r.error);
  });
  document.getElementById("im-pass")?.addEventListener("click", () => userPass());
  document.getElementById("mock-board-toggle")?.addEventListener("click", () => {
    _mockState.boardExpanded = !_mockState.boardExpanded;
    renderMock();
  });
  // Click a board player to nominate (when it's your turn).
  document.querySelectorAll(".mock-nom").forEach(a => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const r = userNominate(a.dataset.name, 1);
      if (!r.ok) alert(r.error);
    });
  });
}

function runMC(n) {
  _mockState.running = true; renderMock();
  setTimeout(() => {
    _mockState.lastMonteCarlo = runMockDraftMonteCarlo(n);
    _mockState.view = "mc";
    _mockState.running = false;
    renderMock();
  }, 30);
}

// Wire interactive state changes to re-render
if (typeof onInteractiveChange === "function") {
  onInteractiveChange(() => {
    if (currentView === "mock" && _mockState.mode === "interactive") renderMock();
  });
}

// === Auto-mode results (single & monte carlo) ===

function renderMockSingle() {
  const { picks, states } = _mockState.lastRun;
  const myId = getMyTeam()?.id;
  const me = myId ? states[myId] : null;
  let html = '';
  html += '<div class="card"><h2>Team Results</h2><table><thead><tr>';
  html += '<th>Team</th><th>Owner</th><th class="num">Spent</th><th class="num">Leftover</th><th class="num">Players</th><th class="num">Avg Surplus</th></tr></thead><tbody>';
  const teamRows = Object.values(states).map(s => {
    const spent = s.drafted.reduce((x, d) => x + d.price, 0);
    const surplus = s.drafted.reduce((x, d) => x + ((d.value || 0) - d.price), 0);
    const leftover = s.budget;
    return { ...s, spent, surplus, leftover };
  });
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
  if (me) {
    html += '<div class="card"><h2>' + esc(me.teamName) + ' — Detail</h2>';
    if (me.drafted.length === 0) html += '<p class="muted">No picks made.</p>';
    else {
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
  html += '<p class="muted small">Across ' + (data[0]?.n || 0) + ' simulated drafts. p10/p90 = 10th and 90th percentile prices.</p>';
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
