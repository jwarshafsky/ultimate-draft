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
  boardSearch: "",       // interactive Board: filter remaining players by name
  boardNeedsOnly: false, // interactive Board: only positions you still need
  reviewMock: null,      // id of a saved mock being reviewed on the start screen
};

function renderMock() {
  const root = document.getElementById("view-root");
  if (!getValues().length) {
    root.innerHTML = '<div class="empty"><p>Mock requires projections.</p><p class="small">Import a FanGraphs CSV on the Data tab.</p></div>';
    return;
  }

  // Preserve text-field focus + caret across re-renders (the live mock re-renders
  // on every AI bump and every timer tick — without this, typing in the custom-bid
  // / search / nominate fields would be interrupted once a second).
  const ae = document.activeElement;
  const focusId = ae && /^(im-custom-bid|im-nominate-name|im-nominate-open|mock-board-search|im-proxy)$/.test(ae.id) ? ae.id : null;
  const focusCaret = focusId ? ae.selectionStart : null;
  const focusVal = focusId ? ae.value : null;

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

  // Restore focus + caret to whichever text field had it.
  if (focusId) {
    const el = document.getElementById(focusId);
    if (el) {
      if (focusVal != null && el.value !== focusVal) el.value = focusVal;
      el.focus();
      try { el.setSelectionRange(focusCaret, focusCaret); } catch (_) {}
    }
  }
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
    html += '<div class="grid cols-2" style="margin-top:16px; gap:10px; max-width:520px;">';
    // Bid speed
    html += '<label style="font-size:13px;" title="How fast the AI bids and the draft advances. Realistic = watch the price climb; Instant = jumps straight to the result."><div class="muted small">Bid speed</div><select id="im-bidspeed" style="width:100%;">';
    for (const [v, lbl] of [["realistic", "Realistic (staggered)"], ["fast", "Fast"], ["instant", "Instant"]]) html += '<option value="' + v + '"' + (s.bidSpeed === v ? ' selected' : '') + '>' + lbl + '</option>';
    html += '</select></label>';
    // Draft-day clock length
    html += '<label style="font-size:13px;" title="A clock runs when it\'s your turn to act; time out = auto-pass."><div class="muted small">Draft-day clock</div><select id="im-clock" style="width:100%;">';
    for (const [v, lbl] of [["off", "Off"], ["8", "8 sec"], ["12", "12 sec"], ["20", "20 sec"]]) {
      const sel = (v === "off" ? !s.useTimer : (s.useTimer && String(s.timerSecs) === v));
      html += '<option value="' + v + '"' + (sel ? ' selected' : '') + '>' + lbl + '</option>';
    }
    html += '</select></label>';
    // Your nomination seat
    html += '<label style="font-size:13px;" title="Where you sit in the nomination order each run."><div class="muted small">Your nomination seat</div><select id="im-nomslot" style="width:100%;">';
    let seatOpts = '<option value="random"' + (s.nomSlot === "random" ? " selected" : "") + '>Random</option><option value="first"' + (s.nomSlot === "first" ? " selected" : "") + '>First</option><option value="last"' + (s.nomSlot === "last" ? " selected" : "") + '>Last</option>';
    for (let i = 0; i < 12; i++) seatOpts += '<option value="' + i + '"' + (String(s.nomSlot) === String(i) ? " selected" : "") + '>Seat ' + (i + 1) + '</option>';
    html += seatOpts + '</select></label>';
    // Market heat
    html += '<label style="font-size:13px;" title="Simulate a hot vs cold room. Hot = everyone reaches higher (early stars clear hot, late players go cheap)."><div class="muted small">Market heat</div><select id="im-heat" style="width:100%;">';
    for (const [v, lbl] of [["cold", "Cold (bargains)"], ["normal", "Normal"], ["hot", "Hot (overpay)"]]) html += '<option value="' + v + '"' + (s.heat === v ? ' selected' : '') + '>' + lbl + '</option>';
    html += '</select></label>';
    html += '</div>';
    html += '</div>';
    html += renderSavedMocks();   // review past mocks
    return html;
  }

  // Active session
  const me = getMyTeam();
  const myState = s.states[me?.id];
  const nominatorId = s.nominationOrder[s.currentNominator % s.nominationOrder.length];
  const nominator = s.states[nominatorId];

  // Status header
  html += '<div class="card" style="border-color: rgba(79,142,247,.4);">';
  html += '<div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">';
  html += '<h2 style="margin: 0;">Live Mock <span class="muted small">· ' + s.picks.length + ' picks done</span></h2>';
  html += '<div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">';
  html += '<label style="display:flex; align-items:center; gap:5px; font-size:12px;" class="muted" title="Pacing of AI bids / draft advance">speed <select id="im-bidspeed">';
  for (const [v, lbl] of [["realistic", "Realistic"], ["fast", "Fast"], ["instant", "Instant"]]) {
    html += '<option value="' + v + '"' + (s.bidSpeed === v ? ' selected' : '') + '>' + lbl + '</option>';
  }
  html += '</select></label>';
  html += '<label style="display:flex; align-items:center; gap:5px; font-size:12px;" class="muted" title="Draft-day clock on your turns">clock <select id="im-clock">';
  for (const [v, lbl] of [["off", "Off"], ["8", "8s"], ["12", "12s"], ["20", "20s"]]) {
    const sel = (v === "off" ? !s.useTimer : (s.useTimer && String(s.timerSecs) === v));
    html += '<option value="' + v + '"' + (sel ? ' selected' : '') + '>' + lbl + '</option>';
  }
  html += '</select></label>';
  html += '<label style="display:flex; align-items:center; gap:5px; font-size:12px;" class="muted" title="Hot vs cold room">heat <select id="im-heat">';
  for (const [v, lbl] of [["cold", "Cold"], ["normal", "Normal"], ["hot", "Hot"]]) html += '<option value="' + v + '"' + (s.heat === v ? ' selected' : '') + '>' + lbl + '</option>';
  html += '</select></label>';
  html += '<button class="btn ghost danger" id="interactive-stop">End Mock</button>';
  html += '</div></div></div>';

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
    // FIXED-STRUCTURE action panel: every control keeps the SAME position for the
    // whole lot. Controls only enable/disable (a disabled button ignores clicks)
    // — they are never added/removed/reordered, so nothing moves under your cursor
    // and an accidental click can't fire. Status row has a reserved height so the
    // timer bar appearing/disappearing never shifts the buttons.
    const pricedOut = myMax <= s.currentBid;
    const canAct = !isMyBid && !iHavePassed && !pricedOut;
    const parVal = Math.round(inflV);
    // --- status row (reserved height) ---
    html += '<div class="otc-status">';
    if (isMyBid) {
      html += '<span class="good small">✓ You\'re the high bidder — AI responding…</span>';
    } else if (iHavePassed) {
      html += '<span class="muted small">You passed on this lot.</span>';
    } else if (pricedOut) {
      html += '<span class="bad small">Priced out (max $' + myMax + ') — passing.</span>';
    } else if (s.useTimer && s.secondsLeft > 0) {
      const pct = Math.max(0, Math.min(100, (s.secondsLeft / s.timerSecs) * 100));
      const urgent = s.secondsLeft <= 4;
      html += '<div style="width:100%;"><div style="display:flex; justify-content:space-between; font-size:11px;" class="muted"><span>Your turn</span><span style="color:' + (urgent ? 'var(--bad)' : 'var(--muted)') + '; font-weight:600;">' + s.secondsLeft + 's</span></div>';
      html += '<div style="height:4px; background:rgba(255,255,255,.08); border-radius:3px; overflow:hidden; margin-top:2px;"><div style="height:100%; width:' + pct + '%; background:' + (urgent ? 'var(--bad)' : 'var(--accent)') + '; transition:width .9s linear;"></div></div></div>';
    } else {
      html += '<span class="muted small">Your turn — bid or pass.</span>';
    }
    html += '</div>';
    // --- quick-bid row (always +$1 +$2 +$5 + jump-to-par; disabled when N/A) ---
    html += '<div class="otc-row">';
    for (const inc of [1, 2, 5]) {
      const en = canAct && (s.currentBid + inc) <= myMax;
      html += '<button class="btn primary im-bid" data-inc="' + inc + '"' + (en ? '' : ' disabled') + ' style="width:auto; padding:6px 12px; min-width:46px;">+$' + inc + '</button>';
    }
    const parEn = canAct && parVal > s.currentBid && parVal <= myMax;
    html += '<button class="btn im-bid" data-to="' + parVal + '"' + (parEn ? '' : ' disabled') + ' style="width:auto; padding:6px 10px; min-width:56px;" title="Bid to par/fair value">→ $' + parVal + '</button>';
    html += '</div>';
    // --- custom-bid row ---
    html += '<div class="otc-row">';
    html += '<input id="im-custom-bid" type="number" min="' + (s.currentBid + 1) + '" placeholder="$" style="width:72px;"' + (canAct ? '' : ' disabled') + '>';
    html += '<button class="btn im-bid-custom" style="width:auto; padding:6px 10px;"' + (canAct ? '' : ' disabled') + '>Bid</button>';
    html += '</div>';
    // --- pass row ---
    const passEn = !isMyBid && !iHavePassed;
    html += '<div class="otc-row">';
    html += '<button class="btn ghost" id="im-pass"' + (passEn ? '' : ' disabled') + '>Pass</button>';
    html += '<span class="muted" style="font-size:10px;">Enter = bid · P/Esc = pass</span>';
    html += '</div>';
    // Proxy / max-bid: let the engine bid for you up to a cap (set it anytime you
    // haven't passed — works while you're leading too, so you don't babysit a target).
    if (!iHavePassed) {
      if (s.proxyMax != null) {
        html += '<div class="small" style="margin-top:8px; display:flex; align-items:center; gap:8px;"><span class="good">Auto-bidding up to <strong>$' + s.proxyMax + '</strong></span><button class="btn ghost" id="im-proxy-cancel" style="width:auto; padding:2px 10px; font-size:11px;">Cancel</button></div>';
      } else {
        html += '<div class="small" style="margin-top:8px; display:flex; align-items:center; gap:6px;"><span class="muted">Auto-bid up to</span><input id="im-proxy" type="number" min="' + (s.currentBid + 1) + '" placeholder="$max" style="width:70px;"><button class="btn im-proxy-set" style="width:auto; padding:4px 10px; font-size:11px;">Set</button></div>';
      }
    }
    html += '</div></div>';
    // Escalation ticker — the live "who bid what" feed for this lot.
    if (s.bidLog && s.bidLog.length > 1) {
      const recent = s.bidLog.slice(-7);
      html += '<div class="mock-ticker" style="margin-top:8px; display:flex; gap:6px; flex-wrap:wrap; align-items:center;">';
      html += '<span class="muted small">Bids:</span>';
      recent.forEach((b, i) => {
        const isLast = i === recent.length - 1;
        html += '<span class="kbd" style="font-size:11px;' + (b.mine ? 'color:var(--accent);' : '') + (isLast ? 'font-weight:700;' : 'opacity:.7;') + '">' + esc(b.owner) + ' $' + b.bid + '</span>';
        if (!isLast) html += '<span class="muted" style="font-size:10px;">→</span>';
      });
      html += '</div>';
    }
    html += '</div>';
  }

  // === Phase: sold — prominent SOLD banner (win/lose + your surplus) ===
  if (s.phase === "sold" && s.lastSale) {
    const ls = s.lastSale;
    const surp = (ls.value || 0) - ls.price;
    const tone = ls.mine ? "rgba(40,180,99,.45)" : "rgba(255,255,255,.12)";
    const bg = ls.mine ? "rgba(40,180,99,.10)" : "transparent";
    html += '<div class="card sold-banner" style="border-color:' + tone + '; background:' + bg + '; text-align:center; padding:14px;">';
    html += '<div style="font-size:13px; letter-spacing:2px; font-weight:700; color:var(--good);">SOLD</div>';
    html += '<div style="font-size:20px; font-weight:700; margin:2px 0;">' + esc(ls.player) + ' <span class="muted" style="font-size:13px;">' + esc(ls.pos === "UTIL" ? "DH/UT" : ls.pos) + '</span></div>';
    html += '<div style="font-size:15px;">$' + ls.price + ' → <strong>' + esc(ls.mine ? "You" : ls.owner) + '</strong>';
    if (ls.mine) html += ' <span class="' + (surp >= 0 ? 'good' : 'bad') + '" style="font-size:13px;">(' + (surp >= 0 ? '+' : '') + '$' + surp.toFixed(0) + ' vs value)</span>';
    html += '</div>';
    if (s.bidSpeed !== "instant") html += '<div class="muted small" style="margin-top:6px;">Next nomination in a moment…</div>';
    html += '</div>';
  }

  // Live roto-category pace read (light on power/saves?) — drives bid priorities.
  html += renderMockCategoryRead(myState);

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
      html += '<div class="card"><h2>Mock Complete</h2><p class="muted small">All rosters filled. Save it below to review later, or End Mock to reset.</p></div>';
    }
    // Scorecard — grade + projected standings — shown for any finished draft.
    if (s.picks.length) html += renderMockScorecard(s);
  }

  return html;
}

// Live roto-category read of your in-progress mock roster (keepers + drafted),
// pace-aware: counting cats are compared to a pro-rated mid-pack target so the
// signal means "ahead/behind pace," not "you haven't finished your roster."
// Surfaces "you're light on power/saves" the way a commercial tool would.
function renderMockCategoryRead(myState) {
  if (!myState || typeof aggregateCats !== "function" || typeof CAT_TARGETS === "undefined") return '';
  const names = [];
  if (myState.kept) for (const k of myState.kept) names.push(k.name);
  for (const d of myState.drafted) names.push(d.name);
  if (names.length < 2) return '';   // too early to be meaningful
  const totals = aggregateCats(names);
  const filled = names.length;
  const total = filled + (myState.slotsRemaining || 0);
  const frac = total > 0 ? Math.max(0.08, filled / total) : 0.08;

  const cats = ["R", "HR", "RBI", "SB", "OBP", "QS", "K", "SV_HLD", "ERA", "WHIP"];
  const labels = { R: "R", HR: "HR", RBI: "RBI", SB: "SB", OBP: "OBP", QS: "QS", K: "K", SV_HLD: "SV+HLD", ERA: "ERA", WHIP: "WHIP" };
  const counting = { R: 1, HR: 1, RBI: 1, SB: 1, QS: 1, K: 1, SV_HLD: 1 };
  const score = {};   // >1 ahead of mid-pack pace, <1 behind, null if no data yet
  for (const c of cats) {
    const t = CAT_TARGETS[c]; if (!t) { score[c] = null; continue; }
    if (counting[c]) {
      const val = c === "SV_HLD" ? totals.SV_HLD : (totals[c] || 0);
      score[c] = val / Math.max(1, t.p6 * frac);
    } else if (c === "OBP") {
      score[c] = totals.OBP > 0 ? totals.OBP / t.p6 : null;
    } else { // ERA / WHIP — lower is better
      const v = c === "ERA" ? totals.ERA : totals.WHIP;
      score[c] = v > 0 ? t.p6 / v : null;
    }
  }
  const col = (sc) => sc == null ? "var(--muted)" : sc >= 1.08 ? "var(--good)" : sc <= 0.85 ? "var(--bad)" : "var(--text)";
  const weak = cats.filter(c => counting[c] && score[c] != null && score[c] < 0.9).sort((a, b) => score[a] - score[b]).slice(0, 3).map(c => labels[c]);
  const strong = cats.filter(c => counting[c] && score[c] != null && score[c] >= 1.15).sort((a, b) => score[b] - score[a]).slice(0, 2).map(c => labels[c]);

  let html = '<div class="card" style="padding:10px;"><h3 style="margin:0 0 6px;">Category Pace <span class="muted small">· ' + filled + '/' + total + ' filled</span></h3>';
  html += '<div style="display:flex; gap:5px; flex-wrap:wrap;">';
  for (const c of cats) {
    const sc = score[c];
    const pct = sc == null ? "—" : Math.round(sc * 100) + "%";
    html += '<span class="kbd" style="font-size:10px; color:' + col(sc) + '; border-color:' + col(sc) + ';" title="' + (counting[c] ? "vs pro-rated mid-pack pace" : "vs mid-pack target") + '">' + labels[c] + ' ' + pct + '</span>';
  }
  html += '</div>';
  if (weak.length || strong.length) {
    html += '<div class="small" style="margin-top:6px;">';
    if (weak.length) html += '<span class="bad">Light on: ' + weak.join(", ") + '</span>';
    if (weak.length && strong.length) html += ' · ';
    if (strong.length) html += '<span class="good">Strong: ' + strong.join(", ") + '</span>';
    html += '</div>';
  }
  html += '</div>';
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
  let positions = ["C", "1B", "2B", "3B", "SS", "OF", "UTIL", "SP", "RP"];
  const myTurn = s.phase === "nominating" && getCurrentNominatorId() === getMyTeam()?.id;
  const infMult = s.inflation && s.inflation.multiplier ? s.inflation.multiplier.toFixed(2) : "1.00";
  const perCol = expanded ? Infinity : 8;

  // Needs-only: restrict to positions you still have an open hard slot for
  // (flex slots MI/CI/UTIL count toward their component positions).
  const myState = s.states[getMyTeam()?.id];
  const os = (myState && myState.openSlots) || {};
  const needPos = new Set();
  if (myState) {
    const has = (k) => (os[k] || 0) > 0;
    if (has("C")) needPos.add("C");
    if (has("1B") || has("CI")) needPos.add("1B");
    if (has("3B") || has("CI")) needPos.add("3B");
    if (has("2B") || has("MI")) needPos.add("2B");
    if (has("SS") || has("MI")) needPos.add("SS");
    if (has("OF")) needPos.add("OF");
    if (has("SP")) needPos.add("SP");
    if (has("RP")) needPos.add("RP");
    // UTIL / BENCH take anyone — if either is open, all positions qualify.
    if (has("UTIL") || (os.BENCH || 0) > 0) positions.forEach(p => needPos.add(p));
  }
  const needsOnly = _mockState.boardNeedsOnly && myState;
  if (needsOnly) positions = positions.filter(p => needPos.has(p) || p === "UTIL" && needPos.has("UTIL"));

  const q = (_mockState.boardSearch || "").trim().toLowerCase();
  const matchSearch = (p) => !q || p.name.toLowerCase().includes(q);

  let html = '<div class="card">';
  html += '<div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;"><h3 style="margin:0;">Board — available (' + s.pool.length + ')</h3>';
  html += '<button class="btn ghost" id="mock-board-toggle" style="width:auto; padding:2px 10px; font-size:12px;">' + (expanded ? "▴ Collapse" : "▾ Expand full board") + '</button></div>';
  html += '<div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin:6px 0;">';
  html += '<input id="mock-board-search" type="search" placeholder="Filter players…" value="' + esc(_mockState.boardSearch || "") + '" style="flex:1; min-width:160px; font-size:13px;">';
  html += '<label style="display:flex; align-items:center; gap:5px; font-size:12px;" title="Only show positions you still have an open slot for"><input type="checkbox" id="mock-board-needs"' + (_mockState.boardNeedsOnly ? ' checked' : '') + '> My needs only</label>';
  html += '</div>';
  html += '<p class="muted small" style="margin-top:0;">$ = inflated at ' + infMult + '×.' + (myTurn ? ' Click a name to nominate.' : '') + (expanded ? ' Scroll each column for the full list.' : '') + ' <span style="opacity:.7;">— line = tier cliff</span></p>';
  html += '<div class="grid ' + (expanded ? 'cols-5' : 'cols-3') + '">';
  let shown = 0;
  for (const pos of positions) {
    const all = s.pool.filter(p => p.posKey === pos && matchSearch(p));
    if (!all.length) continue;
    const list = perCol === Infinity ? all : all.slice(0, perCol);
    const needBadge = needPos.has(pos) ? ' <span class="kbd" style="font-size:8px; color:var(--accent);" title="open slot">need</span>' : '';
    html += '<div><h4 style="margin:4px 0;">' + (pos === "UTIL" ? "DH/UT" : pos) + ' <span class="muted small">' + all.length + '</span>' + needBadge + '</h4>';
    html += '<div style="' + (expanded ? 'max-height:340px; overflow-y:auto;' : '') + '"><table style="font-size:11px; width:100%;"><tbody>';
    let prevTier = null;
    for (const p of list) {
      shown++;
      const inf = inflatedValue(p, s.inflation);
      const tier = (typeof tierForValue === "function") ? tierForValue(p.value) : "T3";
      const color = (typeof TIER_COLORS !== "undefined" && TIER_COLORS[tier]) ? TIER_COLORS[tier] : "var(--text)";
      // Tier cliff: a thin divider where the talent tier steps down within a column.
      if (prevTier && tier !== prevTier) {
        html += '<tr class="tier-cliff"><td colspan="2" style="border-top:1px dashed rgba(255,255,255,.18); height:0; padding:0; line-height:0;"></td></tr>';
      }
      prevTier = tier;
      const nameCell = myTurn
        ? '<a href="#" class="mock-nom" data-name="' + esc(p.name) + '">' + esc(p.name) + '</a>'
        : esc(p.name);
      html += '<tr><td><span style="color:' + color + '; font-size:9px;">' + tier + '</span> ' + nameCell + '</td><td class="num">$' + inf.toFixed(0) + '</td></tr>';
    }
    html += '</tbody></table></div></div>';
  }
  html += '</div>';
  if (!shown) html += '<p class="muted small">No available players match' + (q ? ' "' + esc(q) + '"' : '') + (needsOnly ? ' your open positions' : '') + '.</p>';
  html += '</div>';
  return html;
}

// ===== End-of-draft scorecard: projected standings + grade =====

function _mockValueMap() {
  const m = {}; const nk = (typeof normalizePlayerName === "function") ? normalizePlayerName : (x => String(x || "").toLowerCase());
  (getValues() || []).forEach(p => { m[nk(p.name)] = p.value; });
  return m;
}

// Projects every team's roster into roto standings: relative category ranking
// across the league (best in a cat = N points, worst = 1), summed to roto points.
// Falls back to roster-$ ordering when stat projections aren't loaded.
function computeMockStandings(states) {
  const cats = ["R", "HR", "RBI", "SB", "OBP", "QS", "K", "SV_HLD", "ERA", "WHIP"];
  const nk = (typeof normalizePlayerName === "function") ? normalizePlayerName : (x => String(x || "").toLowerCase());
  const vmap = _mockValueMap();
  const teams = Object.values(states).map(t => {
    const names = [...(t.kept || []).map(k => k.name), ...t.drafted.map(d => d.name)];
    const totals = (typeof aggregateCats === "function") ? aggregateCats(names) : {};
    const rosterValue = names.reduce((a, n) => a + (vmap[nk(n)] || 0), 0);
    const spent = t.drafted.reduce((a, d) => a + (d.price || 0), 0);
    const surplus = t.drafted.reduce((a, d) => a + ((d.value || vmap[nk(d.name)] || 0) - (d.price || 0)), 0);
    return { teamId: t.teamId, owner: t.ownerName, isMe: !!t.isMe, totals, rosterValue, spent, surplus, catPoints: {}, rotoPoints: 0 };
  });
  const N = teams.length;
  const valOf = (t, c) => {
    if (c === "SV_HLD") return t.totals.SV_HLD || 0;
    const v = t.totals[c] || 0;
    if ((c === "ERA" || c === "WHIP") && (!t.totals.IP || v <= 0)) return Infinity; // no pitching = worst, not "0.00 best"
    return v;
  };
  let anyData = false;
  for (const c of cats) {
    if (teams.some(t => { const v = valOf(t, c); return isFinite(v) && v > 0; })) anyData = true;
    const lower = (c === "ERA" || c === "WHIP");
    const order = teams.slice().sort((a, b) => lower ? valOf(a, c) - valOf(b, c) : valOf(b, c) - valOf(a, c));
    let i = 0;
    while (i < N) {
      let j = i; while (j + 1 < N && valOf(order[j + 1], c) === valOf(order[i], c)) j++;
      let sum = 0; for (let r = i; r <= j; r++) sum += (N - r);
      const avg = sum / (j - i + 1);
      for (let r = i; r <= j; r++) { order[r].catPoints[c] = avg; order[r].rotoPoints += avg; }
      i = j + 1;
    }
  }
  teams.sort((a, b) => anyData ? (b.rotoPoints - a.rotoPoints) : (b.rosterValue - a.rosterValue));
  teams.forEach((t, i) => t.rank = i + 1);
  return { teams, anyData, cats, N };
}

function _mockGrade(rank, N) {
  const pct = N > 1 ? (N - rank) / (N - 1) : 1;
  return pct >= 0.92 ? "A+" : pct >= 0.83 ? "A" : pct >= 0.75 ? "A-" : pct >= 0.66 ? "B+"
       : pct >= 0.55 ? "B" : pct >= 0.45 ? "B-" : pct >= 0.36 ? "C+" : pct >= 0.27 ? "C"
       : pct >= 0.18 ? "C-" : pct >= 0.09 ? "D" : "F";
}
function _ord(n) { const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
function _gradeColor(g) { return ["A+", "A", "A-"].includes(g) ? "var(--good)" : ["D", "F"].includes(g) ? "var(--bad)" : "var(--text)"; }

const CAT_LABELS = { R: "R", HR: "HR", RBI: "RBI", SB: "SB", OBP: "OBP", QS: "QS", K: "K", SV_HLD: "SV+HLD", ERA: "ERA", WHIP: "WHIP" };

// The end-of-draft scorecard (grade + projected standings), rendered live from
// the finished mock states. `standingsData`/`grade` can be passed for a saved review.
function renderMockScorecard(s) {
  const st = computeMockStandings(s.states);
  const mine = st.teams.find(t => t.isMe);
  if (!mine) return '';
  const grade = _mockGrade(mine.rank, st.N);
  let html = '<div class="card">';
  html += '<h2 style="margin:0 0 10px;">Draft Scorecard</h2>';
  html += '<div style="display:flex; align-items:center; gap:18px; flex-wrap:wrap;">';
  html += '<div style="font-size:54px; font-weight:800; line-height:1; color:' + _gradeColor(grade) + ';">' + grade + '</div>';
  html += '<div><div style="font-size:18px; font-weight:700;">Projected finish: ' + _ord(mine.rank) + ' of ' + st.N + '</div>';
  html += '<div class="muted small">' + (st.anyData ? (Math.round(mine.rotoPoints * 10) / 10) + ' projected roto pts · ' : 'by roster $ (load stat projections for category standings) · ')
        + 'spent $' + mine.spent + ' · surplus ' + (mine.surplus >= 0 ? '+' : '') + '$' + Math.round(mine.surplus) + '</div></div>';
  html += '</div>';
  if (st.anyData) {
    const sorted = st.cats.slice().sort((a, b) => (mine.catPoints[b] || 0) - (mine.catPoints[a] || 0));
    const strong = sorted.slice(0, 3).map(c => CAT_LABELS[c]);
    const weak = sorted.slice(-3).reverse().map(c => CAT_LABELS[c]);
    html += '<div class="small" style="margin-top:10px;"><span class="good">Strengths: ' + strong.join(", ") + '</span> · <span class="bad">Needs: ' + weak.join(", ") + '</span></div>';
  }
  html += '<table style="margin-top:12px; font-size:12px;"><thead><tr><th class="num">#</th><th>Owner</th>'
        + (st.anyData ? '<th class="num">Roto</th>' : '') + '<th class="num">Roster $</th><th class="num">Spent</th></tr></thead><tbody>';
  for (const t of st.teams) {
    html += '<tr' + (t.isMe ? ' style="background:rgba(79,142,247,.10);"' : '') + '>';
    html += '<td class="num dim">' + t.rank + '</td><td>' + esc(t.owner) + (t.isMe ? ' <span class="kbd">you</span>' : '') + '</td>';
    if (st.anyData) html += '<td class="num">' + (Math.round(t.rotoPoints * 10) / 10) + '</td>';
    html += '<td class="num">$' + Math.round(t.rosterValue) + '</td><td class="num">$' + t.spent + '</td></tr>';
  }
  html += '</tbody></table>';
  html += '<div style="margin-top:12px; display:flex; gap:8px; flex-wrap:wrap;"><button class="btn primary" id="im-save-mock" style="width:auto; padding:8px 16px;">Save this mock</button><span id="im-save-msg" class="good small" style="align-self:center;"></span></div>';
  html += '</div>';
  return html;
}

// ===== Saved mocks (localStorage) =====
const SAVED_MOCKS_KEY = "ud_saved_mocks_v1";
function getSavedMocks() { try { return JSON.parse(localStorage.getItem(SAVED_MOCKS_KEY) || "[]") || []; } catch (_) { return []; } }
function _writeSavedMocks(l) { localStorage.setItem(SAVED_MOCKS_KEY, JSON.stringify(l)); }
function saveCurrentMock(label) {
  const s = getInteractiveState();
  const st = computeMockStandings(s.states);
  const mine = st.teams.find(t => t.isMe);
  const tm = Object.values(s.states).find(x => x.isMe);
  const rec = {
    id: "m" + Date.now(), ts: Date.now(),
    label: label || ("Mock — " + new Date().toLocaleDateString() + " " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })),
    anyData: st.anyData, grade: mine ? _mockGrade(mine.rank, st.N) : "—", myRank: mine ? mine.rank : null, n: st.N,
    picks: s.picks.length,
    standings: st.teams.map(t => ({ owner: t.owner, isMe: t.isMe, rank: t.rank, rotoPoints: Math.round(t.rotoPoints * 10) / 10, rosterValue: Math.round(t.rosterValue), spent: t.spent })),
    myRoster: tm ? [...(tm.kept || []).map(k => ({ name: k.name, pos: k.pos, price: k.price, kept: true })), ...tm.drafted.map(d => ({ name: d.name, pos: d.pos, price: d.price, value: d.value }))] : [],
  };
  const l = getSavedMocks(); l.unshift(rec); while (l.length > 20) l.pop(); _writeSavedMocks(l);
  return rec.id;
}
function deleteSavedMock(id) { _writeSavedMocks(getSavedMocks().filter(m => m.id !== id)); }

function renderSavedMocks() {
  const list = getSavedMocks();
  if (!list.length) return '';
  let html = '<div class="card"><h3 style="margin:0 0 8px;">Saved mocks (' + list.length + ')</h3>';
  html += '<table style="font-size:12px;"><tbody>';
  for (const m of list) {
    html += '<tr><td><strong>' + esc(m.label) + '</strong></td>';
    html += '<td class="num" style="color:' + _gradeColor(m.grade) + ';">' + esc(m.grade) + '</td>';
    html += '<td class="num dim">' + (m.myRank ? _ord(m.myRank) + '/' + m.n : '—') + '</td>';
    html += '<td><button class="btn ghost mock-review" data-id="' + m.id + '" style="width:auto; padding:2px 10px; font-size:11px;">Review</button> ';
    html += '<button class="btn ghost mock-del" data-id="' + m.id + '" style="width:auto; padding:2px 8px; font-size:11px; color:var(--bad);">✕</button></td></tr>';
  }
  html += '</tbody></table>';
  if (_mockState.reviewMock) {
    const rec = list.find(m => m.id === _mockState.reviewMock);
    if (rec) html += renderSavedReview(rec);
  }
  html += '</div>';
  return html;
}

function renderSavedReview(rec) {
  let html = '<div class="card" style="margin-top:10px; border-color: rgba(79,142,247,.35);">';
  html += '<div style="display:flex; align-items:center; gap:14px; flex-wrap:wrap;">';
  html += '<div style="font-size:38px; font-weight:800; color:' + _gradeColor(rec.grade) + ';">' + esc(rec.grade) + '</div>';
  html += '<div><div style="font-weight:700;">' + esc(rec.label) + '</div>';
  html += '<div class="muted small">Projected finish ' + (rec.myRank ? _ord(rec.myRank) + ' of ' + rec.n : '—') + ' · ' + rec.picks + ' picks' + (rec.anyData ? '' : ' · roster-$ basis') + '</div></div>';
  html += '<button class="btn ghost" id="im-review-close" style="width:auto; padding:2px 10px; margin-left:auto;">Close</button></div>';
  // projected standings
  html += '<table style="margin-top:10px; font-size:12px;"><thead><tr><th class="num">#</th><th>Owner</th>' + (rec.anyData ? '<th class="num">Roto</th>' : '') + '<th class="num">Roster $</th><th class="num">Spent</th></tr></thead><tbody>';
  for (const t of rec.standings) {
    html += '<tr' + (t.isMe ? ' style="background:rgba(79,142,247,.10);"' : '') + '><td class="num dim">' + t.rank + '</td><td>' + esc(t.owner) + (t.isMe ? ' <span class="kbd">you</span>' : '') + '</td>';
    if (rec.anyData) html += '<td class="num">' + t.rotoPoints + '</td>';
    html += '<td class="num">$' + t.rosterValue + '</td><td class="num">$' + t.spent + '</td></tr>';
  }
  html += '</tbody></table>';
  // my roster
  if (rec.myRoster && rec.myRoster.length) {
    html += '<div class="muted small" style="margin-top:10px;">Your roster</div><table style="font-size:12px;"><tbody>';
    for (const p of rec.myRoster) {
      html += '<tr><td>' + esc(p.name) + (p.kept ? ' <span class="kbd" style="color:var(--keeper);">K</span>' : '') + '</td><td class="dim">' + esc(p.pos) + '</td><td class="num">$' + p.price + '</td></tr>';
    }
    html += '</tbody></table>';
  }
  html += '</div>';
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
  const submitCustom = () => {
    const v = parseInt(document.getElementById("im-custom-bid").value, 10);
    if (!v) return;
    const r = userBid(v);
    if (!r.ok) alert(r.error);
  };
  document.querySelector(".im-bid-custom")?.addEventListener("click", submitCustom);
  document.getElementById("im-custom-bid")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); submitCustom(); }
  });
  document.getElementById("im-pass")?.addEventListener("click", () => userPass());
  document.getElementById("im-timer-toggle")?.addEventListener("change", (e) => {
    if (typeof setMockTimerEnabled === "function") setMockTimerEnabled(e.target.checked);
    renderMock();
  });
  document.getElementById("im-bidspeed")?.addEventListener("change", (e) => {
    if (typeof setMockBidSpeed === "function") setMockBidSpeed(e.target.value);
    renderMock();
  });
  document.getElementById("im-clock")?.addEventListener("change", (e) => {
    if (typeof setMockClock === "function") setMockClock(e.target.value);
    renderMock();
  });
  document.getElementById("im-nomslot")?.addEventListener("change", (e) => {
    if (typeof setMockNomSlot === "function") setMockNomSlot(e.target.value);
  });
  document.getElementById("im-heat")?.addEventListener("change", (e) => {
    if (typeof setMockHeat === "function") setMockHeat(e.target.value);
    renderMock();
  });
  const setProxy = () => {
    const v = parseInt(document.getElementById("im-proxy")?.value, 10);
    if (typeof setProxyMax === "function") setProxyMax(v);
  };
  document.querySelector(".im-proxy-set")?.addEventListener("click", setProxy);
  document.getElementById("im-proxy")?.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); setProxy(); } });
  document.getElementById("im-proxy-cancel")?.addEventListener("click", () => { if (typeof setProxyMax === "function") setProxyMax(null); });
  // Scorecard: save / review / delete
  document.getElementById("im-save-mock")?.addEventListener("click", () => {
    const id = saveCurrentMock();
    const msg = document.getElementById("im-save-msg");
    if (msg) msg.textContent = "Saved ✓ — review it from the start screen.";
    document.getElementById("im-save-mock").disabled = true;
  });
  document.querySelectorAll(".mock-review").forEach(b => b.addEventListener("click", () => {
    _mockState.reviewMock = (_mockState.reviewMock === b.dataset.id) ? null : b.dataset.id;
    renderMock();
  }));
  document.querySelectorAll(".mock-del").forEach(b => b.addEventListener("click", () => {
    deleteSavedMock(b.dataset.id);
    if (_mockState.reviewMock === b.dataset.id) _mockState.reviewMock = null;
    renderMock();
  }));
  document.getElementById("im-review-close")?.addEventListener("click", () => { _mockState.reviewMock = null; renderMock(); });
  document.getElementById("mock-board-toggle")?.addEventListener("click", () => {
    _mockState.boardExpanded = !_mockState.boardExpanded;
    renderMock();
  });
  // Board filters — re-render on input (focus is preserved by renderMock).
  document.getElementById("mock-board-search")?.addEventListener("input", (e) => {
    _mockState.boardSearch = e.target.value;
    renderMock();
  });
  document.getElementById("mock-board-needs")?.addEventListener("change", (e) => {
    _mockState.boardNeedsOnly = e.target.checked;
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

// Quick keyboard pass during a live mock: "p" or Esc when it's your turn to act.
// Registered once (not per-render). Ignored while typing in a field.
if (!window._mockKeysWired) {
  window._mockKeysWired = true;
  document.addEventListener("keydown", (e) => {
    if (currentView !== "mock" || _mockState.mode !== "interactive") return;
    const t = e.target;
    if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return;   // don't hijack typing
    if (e.key !== "p" && e.key !== "P" && e.key !== "Escape") return;
    const s = (typeof getInteractiveState === "function") ? getInteractiveState() : null;
    const me = (typeof getMyTeam === "function") ? getMyTeam() : null;
    if (!s || s.phase !== "bidding" || !me) return;
    const isMyBid = s.currentWinner === me.id;
    const passed = s.passedTeams && s.passedTeams.has(me.id);
    if (!isMyBid && !passed) { e.preventDefault(); userPass(); }
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
