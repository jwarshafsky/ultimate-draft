// Live Draft view, ESPN auction style. Layout:
//
//   ┌─────────────────────────────────────────────────────────────────┐
//   │  Player On The Clock | Bid: $X  Bidder: Owner  | Bid +1 +2 +5  │
//   │  Pos · Team · Value $Y · NFBC $Z · xwOBA d        | Record/Pass │
//   ├──────────────────────────┬─────────────────────────────────────┤
//   │ Team Strip (all 12)      │ Player pool (sortable, filterable)  │
//   ├──────────────────────────┼─────────────────────────────────────┤
//   │ Endgame Assistant        │ Your roster + cat projection        │
//   ├──────────────────────────┼─────────────────────────────────────┤
//   │ Nominations + AI         │ Recent picks                        │
//   └──────────────────────────┴─────────────────────────────────────┘

const _liveDraft = {
  picks: [],            // [{ player, pos, team, price, ts, espnPlayerId, espnSeq }]
  deleted: {},          // espnPlayerId -> espnSeq (or true) — tombstones for manually-deleted
                        // feed picks (commissioner undos), so the feed can't re-add them.
                        // A later RE-SALE of the same player (different seq) clears the tombstone.
  current: null,        // { player, posKey, value } currently up for auction
  highBid: 0,
  highBidder: null,
  poolFilter: { pos: "ALL", search: "" },
  showAllPicks: false,
};

function getMyLiveDraftPicks() {
  const me = (typeof getMyDraftTeam === "function") ? getMyDraftTeam() : getMyTeam();
  if (!me) return [];
  return _liveDraft.picks.filter(p => p.team === me.id).map(p => p.player);
}

// Names of every player already drafted in the live draft (taken).
function getDraftedNames() {
  return new Set(_liveDraft.picks.map(p => p.player));
}

// Off-the-board set for the auction: predicted keepers + stashed minor
// leaguers (anyone on a MiL roster is not available unless called up).
function _draftOffBoard(_nk) {
  if (typeof draftExcludedNames === "function") return draftExcludedNames();
  return new Set(collectKeepers().map(k => _nk(k.name)));
}

// Players still nominate-able: in the value pool, not drafted, not kept.
// Sorted by value so the typeahead surfaces the best names first.
function availableDraftPool() {
  const _nk = (typeof normalizePlayerName === "function") ? normalizePlayerName : (s => String(s || "").toLowerCase());
  const drafted = new Set(_liveDraft.picks.map(p => _nk(p.player)));
  const kept = _draftOffBoard(_nk);
  return getValues()
    .filter(p => !drafted.has(_nk(p.name)) && !kept.has(_nk(p.name)))
    .slice()
    .sort((a, b) => b.value - a.value);
}

// Small edit distance for typo suggestions ("Wander Franc" → "Wander Franco").
function _nomEditDistance(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// Resolve a typed nomination against the projection pool. A pick recorded
// under a name that isn't in the pool is a "ghost": its price counts as money
// spent but no player value leaves the pool, so live inflation drifts wrong.
// Returns { status: "ok"|"drafted"|"kept", name } or
//         { status: "nomatch", suggestions: [player, ...] }.
function _nomResolveName(typed) {
  const _nk = (typeof normalizePlayerName === "function") ? normalizePlayerName : (s => String(s || "").toLowerCase());
  const q = _nk(typed);
  const values = getValues();
  const drafted = new Set(_liveDraft.picks.map(p => _nk(p.player)));
  const kept = _draftOffBoard(_nk);

  let match = values.find(p => _nk(p.name) === q);
  if (!match && typeof coreNameKey === "function") {
    const cq = coreNameKey(typed);
    if (cq) match = values.find(p => coreNameKey(p.name) === cq);
  }
  if (match) {
    if (drafted.has(_nk(match.name))) return { status: "drafted", name: match.name };
    if (kept.has(_nk(match.name))) return { status: "kept", name: match.name };
    return { status: "ok", name: match.name };
  }

  const avail = values.filter(p => !drafted.has(_nk(p.name)) && !kept.has(_nk(p.name)));
  // Substring hits first (covers last-name-only entry), best value first.
  let sugg = avail.filter(p => _nk(p.name).includes(q)).sort((a, b) => b.value - a.value);
  if (!sugg.length) {
    const maxD = q.length <= 5 ? 2 : 3;
    sugg = avail
      .map(p => ({ p, d: _nomEditDistance(q, _nk(p.name)) }))
      .filter(x => x.d <= maxD)
      .sort((a, b) => a.d - b.d)
      .map(x => x.p);
  }
  return { status: "nomatch", suggestions: sugg.slice(0, 6) };
}

// Live inflation accounting for picks made so far.
function computeLiveInflation() {
  const flat = computeFlatInflation();
  if (!flat) return null;
  const _nk = (typeof normalizePlayerName === "function") ? normalizePlayerName : (s => String(s || "").toLowerCase());
  const draftedNames = new Set(_liveDraft.picks.map(p => _nk(p.player)));
  const spent = _liveDraft.picks.reduce((s, p) => s + p.price, 0);
  const values = getValues();
  let remainingValue = 0;
  const keptNames = _draftOffBoard(_nk);
  for (const p of values) {
    if (p.value <= 0) continue;
    if (keptNames.has(_nk(p.name)) || draftedNames.has(_nk(p.name))) continue;
    remainingValue += p.value;
  }
  const remaining = Math.max(0, flat.leagueRemaining - spent);
  // Normalize against the no-keeper baseline so values start at face (×1) and
  // inflate only from keepers + draft spending (matches computeFlatInflation).
  const base = flat.baselineMultiplier || 1;
  const mult = remainingValue > 0 ? (remaining / remainingValue) / base : 1;
  return {
    ...flat,
    mode: "live",
    multiplier: mult,
    hitMultiplier: mult,
    pitMultiplier: mult,
    tierMult: { T1: mult * 1.15, T2: mult * 1.08, T3: mult, T4: mult * 0.9, T5: mult * 0.7 },
    leagueRemaining: remaining,
    remainingValue,
    pickCount: _liveDraft.picks.length,
  };
}

function renderDraft() {
  const root = document.getElementById("view-root");
  const hasValues = getValues().length > 0;

  const inflation = hasValues ? computeLiveInflation() : null;
  const badge = document.getElementById("inflation-badge");
  if (inflation) {
    badge.textContent = "live infl " + inflation.multiplier.toFixed(2) + "×";
    badge.title = "Live auction inflation — remaining budget vs. remaining player value, recomputed from the picks recorded so far.";
    badge.className = "badge " + (inflation.multiplier > 1.2 ? "hot" : inflation.multiplier < 1.0 ? "cold" : "");
  }
  setStatus("draft", _liveDraft.picks.length + " picks", _liveDraft.picks.length > 0 ? "ok" : "");
  if (typeof ensureRotowireNews === "function") ensureRotowireNews();   // player news, best-effort

  // Fullscreen Draft Mode (draft-mode.js) — the draft-day cockpit.
  if (typeof _draftModeOn === "function" && _draftModeOn() && hasValues) {
    renderDraftMode(root, inflation);
    return;
  }
  document.body.classList.remove("draft-mode");

  // Default tab view = the pre-draft setup lobby (config, strategy, budgets,
  // saved setups). The classic pick-by-pick layout below survives as the
  // manual-entry fallback (_liveDraft.manualView).
  if (!_liveDraft.manualView && typeof renderDraftSetup === "function") {
    renderDraftSetup(root);
    return;
  }
  if (!hasValues) {
    root.innerHTML = '<div class="empty"><p>Live Draft requires projections.</p><p class="small">Import a FanGraphs CSV on the Data tab.</p></div>';
    return;
  }

  let html = '';

  // === Draft controls (reset / undo) ===
  html += renderDraftControls();

  // === Live pick feed (Keeper Edge extension) ===
  html += renderDraftFeedPanel();

  // === ON THE CLOCK panel ===
  html += renderOnTheClockPanel();

  // === Team strip across the top ===
  html += '<div class="card" style="padding: 8px;">';
  html += '<h3 style="margin: 0 0 6px;">Teams</h3>';
  html += renderTeamStrip();
  html += '</div>';

  // === Endgame assistant (full-width if active) ===
  if (isEndgame()) {
    html += renderEndgamePanel();
  }

  // === Inflation curve + Spending pace ===
  if (_liveDraft.picks.length >= 2) {
    html += '<div class="grid cols-2">';
    if (typeof renderInflationCurve === "function") html += renderInflationCurve();
    if (typeof renderSpendingPace === "function") html += renderSpendingPace();
    html += '</div>';
  }

  // === Main two-column body ===
  html += '<div class="grid cols-2">';

  // Left col: Player pool + Pick recorder
  html += '<div>';
  html += renderPickRecorder();
  html += renderPlayerPool(inflation);
  html += '</div>';

  // Right col: Category dashboard + Nominations + AI + Recent picks
  html += '<div>';
  html += renderCategoryDashboard();
  html += '<div class="card"><h2>Nominations</h2>' + renderNominationsPanel() + '</div>';
  html += renderAiAssistantPanel();
  html += renderRecentPicks();
  html += '</div>';

  html += '</div>';

  // Call-ups (collapsed) — flip a stashed minor leaguer onto an ML roster

  // ESPN proxy + live controls — moved to bottom (less frequently changed)
  html += renderLiveSourcesPanel();

  root.innerHTML = html;
  wireDraftHandlers();
}

// Prominent reset / undo bar. The draft always starts from the current keeper
// baseline (keepers are excluded from the pool and budgets), so "Reset draft"
// returns to that keepers-only state.
function renderDraftControls() {
  const n = _liveDraft.picks.length;
  let html = '';
  // Loud TEST MODE banner — Live Draft's team strip / bidder list / budgets are
  // hardwired to The League's 12 owners; test mode only repoints which league's
  // pick feed is polled. So the scaffold shows your real owners; the Recent Picks
  // log is what confirms the feed is streaming.
  if (typeof leagueOverrideActive === "function" && leagueOverrideActive()) {
    html += '<div class="card" style="border-color: var(--warn); background: rgba(210,153,34,.08); padding:10px 12px;">' +
      '<b style="color: var(--warn);">⚠ TEST MODE — polling league ' + esc(String(ESPN.leagueId)) + '</b>' +
      '<div class="small muted" style="margin-top:4px;">The Teams strip, bidder dropdown, and budgets below are <b>your real league\'s</b> slots — test mode only changes which league\'s pick feed is read. Watch <b>Recent Picks</b> (bottom right): each auto-pick appearing there as "Team N — Player — $" confirms the live feed works. Clear the Test league ID in Settings when done.</div></div>';
  }
  html += '<div class="card" style="display:flex; align-items:center; gap:10px; flex-wrap:wrap; padding:10px 12px;">';
  html += '<b>Manual Entry</b> <span class="muted small">' + n + ' pick' + (n === 1 ? '' : 's') + ' recorded · keepers excluded · fallback view</span>';
  html += '<button class="btn ghost" id="draft-back-setup" style="padding:3px 10px;">← Draft setup</button>';
  html += '<span style="flex:1;"></span>';
  html += '<button class="btn primary" id="draft-mode-enter" title="Fullscreen draft-day cockpit (Esc exits)">⛶ Draft Mode</button>';
  html += '<button class="btn ghost" id="draft-debrief"' + (n ? '' : ' disabled') + ' title="Post-draft recap">📋 Debrief</button>';
  html += '<button class="btn ghost" id="draft-undo"' + (n ? '' : ' disabled') + '>↶ Undo last pick</button>';
  html += '<button class="btn ghost danger" id="draft-reset"' + (n ? '' : ' disabled') + '>↺ Reset draft</button>';
  html += '</div>';
  return html;
}

// Revert to the state BEFORE pick #(index+1): drop that pick and all later ones.
function revertToPick(index) {
  if (index < 0 || index >= _liveDraft.picks.length) return;
  _liveDraft.picks = _liveDraft.picks.slice(0, index);
  _liveDraft.current = null; _liveDraft.highBid = 0; _liveDraft.highBidder = null;
  saveLiveDraft();
  renderDraft();
}

function renderOnTheClockPanel() {
  const c = _liveDraft.current;
  let html = '<div class="card on-the-clock">';
  if (c) {
    const val = getPlayerValue(c.player);
    const nfbc = getNfbc(c.player);
    const sc = getStatcast(c.player);
    const sig = statcastBuySell(c.player);
    html += '<div class="otc-grid">';
    html += '<div class="otc-main">';
    html += '<div class="otc-label">On the Clock</div>';
    const _otcInj = (typeof espnInjuryLabel === "function") ? espnInjuryLabel(c.player) : null;
    html += '<div class="otc-player">' + esc(c.player) +
      (_otcInj ? ' <span class="small" style="color:var(--bad); border:1px solid var(--bad); border-radius:4px; padding:1px 6px; vertical-align:middle;">🚑 ' + esc(_otcInj) + '</span>' : '') + '</div>';
    html += '<div class="otc-meta">';
    html += '<span class="kbd">' + esc(val?.posKey || "?") + '</span>';
    if (val?.team) html += ' <span class="muted">' + esc(val.team) + '</span>';
    html += ' · <span class="muted">value</span> $' + (val ? val.value.toFixed(0) : "?");
    if (nfbc?.avg) html += ' · <span class="muted">NFBC avg</span> $' + nfbc.avg.toFixed(0) + (nfbc.min && nfbc.max ? ' <span class="muted small">[' + nfbc.min + '-' + nfbc.max + ']</span>' : "");
    if (sc?.xwOBA) html += ' · <span class="muted">xwOBA</span> ' + sc.xwOBA.toFixed(3);
    if (sc?.xERA) html += ' · <span class="muted">xERA</span> ' + sc.xERA.toFixed(2);
    html += '</div>';
    if (sig) html += '<div class="otc-signal ' + sig.signal + '">' + (sig.signal === "buy" ? "📈 BUY signal" : "📉 SELL signal") + ': ' + esc(sig.reason) + '</div>';
    if (typeof renderPlayerNewsBlock === "function") html += renderPlayerNewsBlock(c.player);
    html += '</div>';
    html += '<div class="otc-bid">';
    html += '<div class="otc-bid-label">Current Bid</div>';
    html += '<div class="otc-bid-amt">$<input id="otc-price" type="number" value="' + _liveDraft.highBid + '" style="width: 90px; font-size: 28px; padding: 4px 8px; border: 1px solid var(--border); background: var(--bg-3); color: var(--text);"></div>';
    html += '<div class="otc-bid-controls">';
    html += '<button class="btn ghost" data-bid-add="1">+$1</button>';
    html += '<button class="btn ghost" data-bid-add="2">+$2</button>';
    html += '<button class="btn ghost" data-bid-add="5">+$5</button>';
    html += '</div>';
    html += '<select id="otc-team" style="margin-top: 6px;">';
    for (const t of (typeof draftTeams === "function" ? draftTeams() : LEAGUE.teams)) {
      html += '<option value="' + t.id + '"' + (t.id === _liveDraft.highBidder ? ' selected' : '') + '>' + esc(t.owner) + '</option>';
    }
    html += '</select>';
    html += '<div class="small" id="otc-maxbid-hint" style="margin-top: 4px;"></div>';
    html += '<div style="display: flex; gap: 6px; margin-top: 8px;">';
    html += '<button class="btn primary" id="otc-sold" style="width: auto; padding: 8px 14px;">SOLD</button>';
    html += '<button class="btn ghost" id="otc-cancel">Cancel</button>';
    html += '</div>';
    html += '</div>';
    html += '</div>';
  } else {
    html += '<div class="otc-empty">';
    html += '<div class="otc-label">Nominate Player</div>';
    html += '<div style="display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px;">';
    html += '<input id="otc-nominate-name" list="otc-nominate-list" placeholder="Player name…" autocomplete="off" style="flex: 1; min-width: 200px; font-size: 16px;">';
    html += '<input id="otc-nominate-open" type="number" placeholder="Opening $" value="1" style="width: 100px; font-size: 16px;">';
    html += '<button class="btn primary" id="otc-nominate" style="width: auto; padding: 10px 16px; font-size: 14px;">Nominate</button>';
    html += '</div>';
    // Typeahead options: available (undrafted, unkept) players, best first.
    html += '<datalist id="otc-nominate-list">';
    for (const p of availableDraftPool().slice(0, 600)) {
      html += '<option value="' + esc(p.name) + '">' + esc(p.posKey) + ' · $' + p.value.toFixed(0) + '</option>';
    }
    html += '</datalist>';
    html += '<div id="otc-nominate-suggest"></div>';
    html += '<div class="muted small" style="margin-top: 8px;">Or use the player pool below to start the auction with one click.</div>';
    html += '</div>';
  }
  html += '</div>';
  return html;
}

function renderPickRecorder() {
  return ''; // Pick recording is integrated into On The Clock now
}

function renderPlayerPool(inflation) {
  const _nk = (typeof normalizePlayerName === "function") ? normalizePlayerName : (s => String(s || "").toLowerCase());
  const draftedNames = new Set(_liveDraft.picks.map(p => _nk(p.player)));
  const keptNames = _draftOffBoard(_nk);
  let players = getValues().filter(p => !draftedNames.has(_nk(p.name)) && !keptNames.has(_nk(p.name)));
  if (_liveDraft.poolFilter.pos !== "ALL") {
    players = players.filter(p => p.posKey === _liveDraft.poolFilter.pos);
  }
  if (_liveDraft.poolFilter.search) {
    const q = _liveDraft.poolFilter.search.toLowerCase();
    players = players.filter(p => p.name.toLowerCase().includes(q));
  }
  players = players.slice(0, 200);

  let html = '<div class="card">';
  html += '<h2>Player Pool <span class="muted small">(' + players.length + ' shown)</span></h2>';
  html += '<div style="display: flex; gap: 8px; margin-bottom: 8px; flex-wrap: wrap;">';
  html += '<input id="pool-search" placeholder="Search…" value="' + esc(_liveDraft.poolFilter.search) + '" style="flex: 1; min-width: 160px;">';
  html += '<select id="pool-pos">';
  for (const p of ["ALL", "C", "1B", "2B", "SS", "3B", "OF", "UTIL", "SP", "RP"]) {
    html += '<option value="' + p + '"' + (_liveDraft.poolFilter.pos === p ? ' selected' : '') + '>' + p + '</option>';
  }
  html += '</select>';
  html += '</div>';

  html += '<table style="font-size: 12px;"><thead><tr>';
  html += '<th>Player</th><th>Pos</th><th class="num">$</th><th class="num">Infl</th><th class="num">NFBC</th><th class="num">xwOBA</th><th></th>';
  html += '</tr></thead><tbody>';
  for (const p of players) {
    const inf = inflatedValue(p, inflation);
    const nfbc = getNfbc(p.name);
    const sc = getStatcast(p.name);
    const sig = statcastBuySell(p.name);
    const targetClass = classifyPriceVsTargets(p.name, inf);
    html += '<tr' + (targetClass === "dream" ? ' style="background: rgba(63,185,80,.08);"' : targetClass === "overpay" ? ' style="background: rgba(248,81,73,.05);"' : '') + '>';
    html += '<td><span class="player-name" data-player="' + esc(p.name) + '" style="cursor: pointer;">' + esc(p.name) + '</span>' + (sig ? ' <span style="color: ' + (sig.signal === "buy" ? "var(--good)" : "var(--bad)") + '; font-size: 10px;">' + (sig.signal === "buy" ? "↑" : "↓") + '</span>' : '') + renderTagIcons(p.name) + renderTargetBadge(p.name, inf) + '</td>';
    html += '<td>' + esc(p.posKey) + '</td>';
    html += '<td class="num">$' + p.value.toFixed(0) + '</td>';
    html += '<td class="num">$' + inf.toFixed(0) + '</td>';
    html += '<td class="num ' + (nfbc?.avg ? '' : 'dim') + '">' + (nfbc?.avg ? '$' + nfbc.avg.toFixed(0) : '—') + '</td>';
    html += '<td class="num ' + (sc?.xwOBA ? '' : 'dim') + '">' + (sc?.xwOBA ? sc.xwOBA.toFixed(3) : sc?.xERA ? sc.xERA.toFixed(2) : '—') + '</td>';
    html += '<td><button class="btn ghost pool-nominate" data-name="' + esc(p.name) + '" title="Start auction" style="padding: 2px 8px; font-size: 11px;">▶</button></td>';
    html += '</tr>';
  }
  html += '</tbody></table>';
  html += '</div>';
  return html;
}

function renderRecentPicks() {
  if (!_liveDraft.picks.length) {
    return '<div class="card"><h3>Recent Picks</h3><p class="muted small">No picks recorded yet.</p></div>';
  }
  const showAll = _liveDraft.showAllPicks || _liveDraft.picks.length <= 12;
  let html = '<div class="card"><h3>Recent Picks ' +
    (showAll ? '<span class="muted small">(all ' + _liveDraft.picks.length + ')</span>' : '<span class="muted small">(last 12)</span>') + '</h3>';
  html += '<p class="muted small" style="margin:0 0 6px;">↶ reverts the draft to just before that pick · ✕ deletes only that pick (commissioner undo / mis-record).</p>';
  if (_liveDraft.picks.length > 12) {
    html += '<button class="btn ghost" id="picks-showall" style="margin-bottom:6px; padding:2px 10px; font-size:11px;">' +
      (showAll ? 'Show last 12' : 'Show all ' + _liveDraft.picks.length) + '</button>';
  }
  html += '<table style="font-size: 12px;"><thead><tr><th class="num">#</th><th>Player</th><th>Team</th><th class="num">$</th><th class="num">vs Val</th><th></th><th></th></tr></thead><tbody>';
  const recent = (showAll ? _liveDraft.picks.slice() : _liveDraft.picks.slice(-12)).reverse();
  const myId = getMyTeam()?.id;
  for (let i = 0; i < recent.length; i++) {
    const pk = recent[i];
    const origIndex = _liveDraft.picks.length - 1 - i;   // index in _liveDraft.picks
    const val = getPlayerValue(pk.player);
    const v = val ? val.value : 0;
    const surplus = v - pk.price;
    const testMode = draftTestMode();
    const isMine = !testMode && pk.team === myId;
    // In test mode the ESPN team IDs belong to the throwaway league, not The
    // League — label them generically instead of mislabeling them as real owners.
    const teamLabel = testMode
      ? ("Team " + (pk.espnTeamId != null ? pk.espnTeamId : "?"))
      : (getTeam(pk.team)?.owner || pk.team);
    html += '<tr' + (isMine ? ' style="background: rgba(79,142,247,.06);"' : '') + '>';
    html += '<td class="num dim">' + (origIndex + 1) + '</td>';
    html += '<td>' + esc(pk.player) + '</td>';
    html += '<td>' + esc(teamLabel) + '</td>';
    html += '<td class="num">$' + pk.price + '</td>';
    html += '<td class="num ' + (surplus > 0 ? 'good' : 'bad') + '">' + (val ? (surplus > 0 ? '+' : '') + '$' + surplus.toFixed(0) : '—') + '</td>';
    html += '<td><button class="btn ghost live-revert" data-idx="' + origIndex + '" title="Revert to before this pick" style="padding:1px 7px;">↶</button></td>';
    html += '<td><button class="btn ghost live-delete" data-idx="' + origIndex + '" title="Delete only this pick" style="padding:1px 7px; color:var(--bad);">✕</button></td>';
    html += '</tr>';
  }
  html += '</tbody></table></div>';
  return html;
}

function renderLiveSourcesPanel() {
  let html = '<div class="card">';
  html += '<h3>Live Sources</h3>';
  html += '<div style="display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 8px;">';
  html += '<label class="muted small" style="min-width: 90px;">Proxy URL:</label>';
  html += '<input id="proxy-url" type="url" placeholder="https://your-proxy.example.com" value="' + esc(ESPN.proxyUrl) + '" style="flex: 1; min-width: 300px;">';
  html += '<button class="btn" id="proxy-save">Save</button>';
  html += '</div>';
  html += '<div style="display: flex; gap: 8px; align-items: center;">';
  if (ESPN.polling) {
    html += '<button class="btn danger" id="espn-stop">⏹ Stop ESPN polling</button>';
  } else {
    html += '<button class="btn" id="espn-start"' + (ESPN.proxyUrl ? '' : ' disabled') + '>▶ Start ESPN polling</button>';
  }
  html += '<button class="btn ghost" id="live-undo">↶ Undo last</button>';
  html += '<button class="btn ghost danger" id="live-clear">🗑 Clear all</button>';
  html += '<span class="muted small" style="margin-left: auto;">' + (ESPN.proxyUrl ? "Proxy: " + esc(ESPN.proxyUrl) : "Set proxy URL to enable ESPN polling + AI") + '</span>';
  html += '</div>';
  html += '</div>';
  return html;
}

// === Event wiring ===

function wireDraftHandlers() {
  // Feed-panel buttons (mode, download, resync, clear, undo-suspects) are
  // wired once via document-level delegation near the top of this file.
  // Click player name to open note editor
  document.querySelectorAll("#view-root .player-name").forEach(el => {
    el.addEventListener("click", () => openNoteEditor(el.dataset.player));
  });
  // Pool filters
  document.getElementById("pool-search")?.addEventListener("input", (e) => {
    _liveDraft.poolFilter.search = e.target.value;
    const caret = e.target.selectionStart;
    renderDraft();                          // rebuilds the DOM (new input)
    const el = document.getElementById("pool-search");
    if (el) { el.focus(); try { el.setSelectionRange(caret, caret); } catch (_) {} }
  });
  document.getElementById("pool-pos")?.addEventListener("change", (e) => {
    _liveDraft.poolFilter.pos = e.target.value;
    renderDraft();
  });
  // Start auction from pool
  document.querySelectorAll(".pool-nominate").forEach(b => {
    b.addEventListener("click", () => {
      startAuction(b.dataset.name, 1);
    });
  });
  if (typeof wireNominationsPanel === "function") wireNominationsPanel(renderDraft);
  // Nominate via input — validated against the pool so a typo can't create a
  // ghost player (which would corrupt live inflation).
  document.getElementById("otc-nominate")?.addEventListener("click", () => {
    const name = document.getElementById("otc-nominate-name").value.trim();
    const open = parseFloat(document.getElementById("otc-nominate-open").value) || 1;
    if (!name) { alert("Enter a player name."); return; }
    const res = _nomResolveName(name);
    if (res.status === "ok") { startAuction(res.name, open); return; }
    if (res.status === "drafted") {
      const _nk = (typeof normalizePlayerName === "function") ? normalizePlayerName : (s => String(s || "").toLowerCase());
      const pk = _liveDraft.picks.find(p => _nk(p.player) === _nk(res.name));
      const who = pk ? ((typeof draftTeamLabel === "function" ? draftTeamLabel(pk.team) : null) || getTeam(pk.team)?.owner || pk.team) : "someone";
      alert(res.name + " was already drafted by " + who + (pk ? " for $" + pk.price : "") + ".");
      return;
    }
    if (res.status === "kept") { alert(res.name + " is a keeper — not in the draft pool."); return; }
    renderNominateSuggestions(name, res.suggestions);
  });
  // Clicks on suggestion buttons (injected after a failed match).
  document.getElementById("otc-nominate-suggest")?.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const open = parseFloat(document.getElementById("otc-nominate-open")?.value) || 1;
    if (btn.dataset.pick) { startAuction(btn.dataset.pick, open); return; }
    if (btn.dataset.force) {
      const typed = btn.dataset.force;
      if (confirm('"' + typed + '" is not in the player pool.\n\nRecording them anyway means their price counts as money spent but no projected value leaves the pool, so live inflation will read slightly low. Only do this for a real player who has no projection.\n\nNominate "' + typed + '" anyway?')) {
        startAuction(typed, open);
      }
    }
  });
  document.getElementById("otc-nominate-name")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("otc-nominate").click();
  });
  // Bid controls
  document.querySelectorAll("[data-bid-add]").forEach(b => {
    b.addEventListener("click", () => {
      const inc = parseInt(b.dataset.bidAdd, 10);
      _liveDraft.highBid = (_liveDraft.highBid || 0) + inc;
      document.getElementById("otc-price").value = _liveDraft.highBid;
      updateOtcMaxBidHint();
    });
  });
  document.getElementById("otc-price")?.addEventListener("input", (e) => {
    _liveDraft.highBid = parseInt(e.target.value, 10) || 0;
    updateOtcMaxBidHint();
  });
  document.getElementById("otc-team")?.addEventListener("change", (e) => {
    _liveDraft.highBidder = e.target.value;
    updateOtcMaxBidHint();
  });
  updateOtcMaxBidHint();
  // Prominent draft controls
  document.getElementById("draft-mode-enter")?.addEventListener("click", () => setDraftMode(true));
  document.getElementById("draft-back-setup")?.addEventListener("click", () => { _liveDraft.manualView = false; renderDraft(); });
  document.getElementById("draft-debrief")?.addEventListener("click", () => { if (typeof openDebrief === "function") openDebrief(); });
  document.getElementById("draft-undo")?.addEventListener("click", () => {
    if (_liveDraft.picks.length) { _liveDraft.picks.pop(); saveLiveDraft(); renderDraft(); }
  });
  document.getElementById("draft-reset")?.addEventListener("click", () => {
    const n = _liveDraft.picks.length;
    if (n && confirm("Reset the draft? Clears all " + n + " recorded picks and returns to the keeper baseline.")) {
      _liveDraft.picks = []; _liveDraft.current = null; _liveDraft.highBid = 0; _liveDraft.highBidder = null;
      saveLiveDraft(); renderDraft();
    }
  });
  document.querySelectorAll(".live-revert").forEach(b => b.addEventListener("click", () => {
    const idx = parseInt(b.dataset.idx, 10);
    const removed = _liveDraft.picks.length - idx;
    if (confirm("Revert to before pick #" + (idx + 1) + "? Removes " + removed + " pick" + (removed === 1 ? "" : "s") + ".")) {
      revertToPick(idx);
    }
  }));
  document.querySelectorAll(".live-delete").forEach(b => b.addEventListener("click", () => {
    const idx = parseInt(b.dataset.idx, 10);
    const pk = _liveDraft.picks[idx];
    if (!pk) return;
    if (confirm("Delete pick #" + (idx + 1) + " (" + pk.player + " — $" + pk.price + ")? Only this pick is removed; the live feed won't re-add it unless the player is genuinely re-auctioned.")) {
      deletePickAt(idx);
    }
  }));
  document.getElementById("picks-showall")?.addEventListener("click", () => {
    _liveDraft.showAllPicks = !_liveDraft.showAllPicks;
    renderDraft();
  });
  if (_liveDraft.current && typeof wirePlayerNewsBlock === "function") wirePlayerNewsBlock(_liveDraft.current.player);
  document.getElementById("otc-sold")?.addEventListener("click", soldCurrent);
  document.getElementById("otc-cancel")?.addEventListener("click", () => {
    _liveDraft.current = null;
    _liveDraft.highBid = 0;
    _liveDraft.highBidder = null;
    renderDraft();
  });
  // Sources panel
  document.getElementById("proxy-save")?.addEventListener("click", () => {
    setProxyUrl(document.getElementById("proxy-url").value);
    renderDraft();
  });
  document.getElementById("espn-start")?.addEventListener("click", () => { startEspnPolling(); renderDraft(); });
  document.getElementById("espn-stop")?.addEventListener("click", () => { stopEspnPolling(); renderDraft(); });
  document.getElementById("live-undo")?.addEventListener("click", () => {
    if (_liveDraft.picks.length && confirm("Undo last pick?")) {
      _liveDraft.picks.pop();
      saveLiveDraft();
      renderDraft();
    }
  });
  document.getElementById("live-clear")?.addEventListener("click", () => {
    if (confirm("Clear ALL recorded picks? This can't be undone.")) {
      _liveDraft.picks = [];
      saveLiveDraft();
      renderDraft();
    }
  });
  wireAiPanel();
}

// Injected under the nominate input when the typed name matched nothing.
function renderNominateSuggestions(typed, suggestions) {
  const box = document.getElementById("otc-nominate-suggest");
  if (!box) return;
  let html = '<div style="margin-top: 8px; padding: 8px 10px; border: 1px solid var(--warn); background: rgba(210,153,34,.08);">';
  html += '<b style="color: var(--warn);">No player named "' + esc(typed) + '" in the pool.</b>';
  if (suggestions.length) {
    html += '<div class="small muted" style="margin: 6px 0 4px;">Did you mean:</div>';
    html += '<div style="display: flex; gap: 6px; flex-wrap: wrap;">';
    for (const p of suggestions) {
      html += '<button class="btn ghost" data-pick="' + esc(p.name) + '" style="padding: 4px 10px;">' + esc(p.name) + ' <span class="muted small">' + esc(p.posKey) + ' · $' + p.value.toFixed(0) + '</span></button>';
    }
    html += '</div>';
  }
  html += '<div style="margin-top: 8px;"><button class="btn ghost" data-force="' + esc(typed) + '" style="padding: 3px 10px; font-size: 11px;">Nominate "' + esc(typed) + '" anyway (no projection)</button></div>';
  html += '</div>';
  box.innerHTML = html;
}

// Live "max bid" hint for the selected bidder, updated as the bid/team change.
function updateOtcMaxBidHint() {
  const el = document.getElementById("otc-maxbid-hint");
  if (!el || typeof computeLiveTeamStates !== "function") return;
  const team = document.getElementById("otc-team")?.value || _liveDraft.highBidder;
  const st = computeLiveTeamStates()[team];
  if (!st) { el.textContent = ""; return; }
  const bid = _liveDraft.highBid || 0;
  if (bid > st.maxBid) {
    el.innerHTML = '⚠ Over ' + esc(st.ownerName) + "'s max bid of $" + st.maxBid + ' ($' + st.budget + ' left, ' + st.slotsRemaining + ' slot' + (st.slotsRemaining === 1 ? '' : 's') + ' to fill)';
    el.style.color = "var(--bad)";
  } else {
    el.innerHTML = esc(st.ownerName) + ' max bid $' + st.maxBid + ' <span class="muted">($' + st.budget + ' · ' + st.slotsRemaining + ' slot' + (st.slotsRemaining === 1 ? '' : 's') + ')</span>';
    el.style.color = "";
  }
}

function startAuction(playerName, openBid) {
  const val = getPlayerValue(playerName);
  _liveDraft.current = { player: playerName, posKey: val?.posKey || null, value: val?.value || 0 };
  _liveDraft.highBid = openBid || 1;
  const _saTeams = (typeof draftTeams === "function") ? draftTeams() : LEAGUE.teams;
  _liveDraft.highBidder = (typeof getMyDraftTeam === "function" ? getMyDraftTeam() : getMyTeam())?.id || _saTeams[0].id;
  renderDraft();
}

function soldCurrent() {
  const c = _liveDraft.current;
  if (!c) return;
  const price = _liveDraft.highBid || 1;
  const team = _liveDraft.highBidder || getMyTeam()?.id;
  if (!team) { alert("Select a team."); return; }
  // Budget sanity check: warn (don't block) if this price is beyond what the
  // winning team can actually bid — budget minus $1 reserved per open slot.
  const st = (typeof computeLiveTeamStates === "function") ? computeLiveTeamStates()[team] : null;
  if (st && price > st.maxBid) {
    const owner = getTeam(team)?.owner || team;
    const msg = st.slotsRemaining <= 0
      ? owner + "'s roster is already full (keepers + picks = " + LEAGUE.rosterSize + " slots)."
      : owner + " can only bid up to $" + st.maxBid + " — they have $" + st.budget + " left and " + st.slotsRemaining + " slot" + (st.slotsRemaining === 1 ? "" : "s") + " to fill at $1 minimum.";
    if (!confirm(msg + "\n\nRecord " + c.player + " to " + owner + " for $" + price + " anyway?")) return;
  }
  _liveDraft.picks.push({
    player: c.player,
    pos: c.posKey,
    team,
    price,
    ts: Date.now(),
  });
  _liveDraft.current = null;
  _liveDraft.highBid = 0;
  _liveDraft.highBidder = null;
  saveLiveDraft();
  if (typeof recordInflationSnapshot === "function") recordInflationSnapshot();
  renderDraft();
}

// Pick persistence is layered (P2R1 chaos-1: quota exhaustion silently lost
// picks): main key → free the big event-log backup and retry → emergency
// fallback key. The pick list is the one thing that must survive anything.
function saveLiveDraft() {
  const payload = JSON.stringify({ v: 2, at: Date.now(), picks: _liveDraft.picks, deleted: _liveDraft.deleted, streamKey: _liveDraft.streamKey || null });
  try {
    localStorage.setItem("ud_live_draft_v1", payload);
    try { localStorage.removeItem("ud_live_draft_bk_v1"); } catch (e2) {}
    return;
  } catch (e) {}
  try { localStorage.removeItem(_DLOG_LS_KEY); } catch (e2) {}   // Supabase holds the full stream
  try { localStorage.setItem("ud_live_draft_v1", payload); _storageFail("events-backup dropped to save picks", {}); return; } catch (e) {}
  try { localStorage.setItem("ud_live_draft_bk_v1", payload); _storageFail("picks (main key failed; emergency key in use)", {}); return; } catch (e) { _storageFail("picks", e); }
}
function loadLiveDraft() {
  try {
    // The emergency key is only ever written when the main key failed, so
    // when both exist the newer one wins.
    let raw = localStorage.getItem("ud_live_draft_v1");
    const bk = localStorage.getItem("ud_live_draft_bk_v1");
    if (bk) {
      try {
        const a = JSON.parse(raw || "null"), b = JSON.parse(bk);
        if (!a || (b.at || 0) >= (a.at || 0)) raw = bk;
      } catch (e2) { raw = bk; }
    }
    const v = JSON.parse(raw || "[]");
    if (Array.isArray(v)) _liveDraft.picks = v;                      // legacy format (picks only)
    else if (v && Array.isArray(v.picks)) {
      _liveDraft.picks = v.picks;
      _liveDraft.deleted = v.deleted || {};
      _liveDraft.streamKey = v.streamKey || null;
    }
  } catch {}
}
loadLiveDraft();

// Delete ONE pick (commissioner undo, mis-record) without touching the rest.
// Feed-sourced picks get a tombstone so the extension feed can't re-add them;
// a genuine re-auction (same player, different ESPN lot seq) is still accepted.
function deletePickAt(index) {
  const pk = _liveDraft.picks[index];
  if (!pk) return;
  if (pk.espnPlayerId != null) _liveDraft.deleted[pk.espnPlayerId] = (pk.espnSeq != null ? pk.espnSeq : -Date.now());
  _liveDraft.picks.splice(index, 1);
  saveLiveDraft();
  renderDraft();
}

// ===========================================================================
// Live pick feed — Keeper Edge browser extension
// ---------------------------------------------------------------------------
// The Keeper Edge extension hooks ESPN's draft-room websocket in *your* draft
// tab and mirrors each completed pick to the app via chrome.storage (bridged by
// ud-bridge.js → window.postMessage). No server, no polling, no eviction. This
// block receives those picks and feeds them onto the Live Draft board.
//
// Mode (Live Draft page): off | test (any ESPN mock) | real (only league 1200).
// "real" ignores any stray mock feed so a practice run can't corrupt draft day.
// ===========================================================================

const FEED_MODE_KEY = "ud_feed_mode";
function getFeedMode() { return localStorage.getItem(FEED_MODE_KEY) || "off"; }
function setFeedMode(m) {
  const mode = (m === "test" || m === "real") ? m : "off";
  // Leaving Test mode must halt a running practice mock — otherwise its timers
  // keep emitting frames into a feed that now drops them, while the panel still
  // reads "● Running". (startMockFeed/_mfArm set mode 'test', so this never
  // stops the mock we're about to start.)
  if (mode !== "test" && typeof mockFeedActive === "function" && mockFeedActive() &&
      typeof stopMockFeed === "function") stopMockFeed({ silent: true });
  localStorage.setItem(FEED_MODE_KEY, mode);
  // "real" = your actual league (1200); clear any test-league override so
  // player-name lookups and team mapping use the real league.
  if (mode === "real" && typeof setLeagueOverride === "function") setLeagueOverride("");
  if (mode === "real") reconcileDraftContext();
}

// Real mode's guarantees are LOAD-TIME, not click-time (P2R2 aged-F1/F2,
// interact-F1): aged/synced state must never cold-start a contaminated or
// silently-mocked real context.
//   1. S-003: no test-league override may survive into Real mode (an aged
//      synced override otherwise turns the real draft into a generic mock —
//      Team N, $260, ZERO keeper exclusions — with no visual warning).
//   2. Mock-context picks must never survive into Real mode. The tell is the
//      picks THEMSELVES (recorded on generic "espn:N" teams in test mode) —
//      not the stream's league id, because a mock can run ON the home league
//      (ESPN's pre-draft mock lobby) and a league-prefix check would spare it.
//      Foreign-league streams are purged too. Manual real picks (real owner
//      ids, no espn: prefix) always survive. The mock's full record stays in
//      Supabase + extension storage.
// Called at app load (below), from setFeedMode('real'), and safe to call any
// time. Returns true if anything changed.
function reconcileDraftContext() {
  if (getFeedMode() !== "real") return false;
  let changed = false;
  // A practice mock seeds _espnIdToName with SYNTHETIC ids (900001+). That map is
  // session-lifetime, and _ensureEspnNames early-returns when it's non-null — so
  // a same-session REAL draft (dress rehearsal → go live, no reload) would never
  // fetch real names and would record every real pick as "Player <id>". Drop the
  // mock-seeded map when entering Real mode so the next pick fetches real names.
  if (typeof _espnNamesAreMock !== "undefined" && _espnNamesAreMock) {
    _espnIdToName = null;
    _espnNamesAreMock = false;
    changed = true;
    console.log("[draft] cleared mock-seeded ESPN name map (Real mode fetches real names)");
  }
  if (typeof leagueOverrideActive === "function" && leagueOverrideActive() &&
      typeof setLeagueOverride === "function") {
    setLeagueOverride("");
    changed = true;
    console.log("[draft] cleared an aged test-league override (Real mode is league " +
      (typeof UD_HOME_LEAGUE_ID !== "undefined" ? UD_HOME_LEAGUE_ID : 1200) + " only)");
  }
  const home = String(typeof UD_HOME_LEAGUE_ID !== "undefined" ? UD_HOME_LEAGUE_ID : 1200) + ":";
  const hasMockPicks = _liveDraft.picks.some(p => typeof p.team === "string" && p.team.indexOf("espn:") === 0);
  const foreignStream = !!(_liveDraft.streamKey && !_liveDraft.streamKey.startsWith(home));
  if (hasMockPicks || foreignStream) {
    const n = _liveDraft.picks.length;
    _liveDraft.picks = [];
    _liveDraft.deleted = {};
    _liveDraft.streamKey = null;
    // The mock's event log goes with its picks — leaving it produced 40 stale
    // "SOLD with no matching pick" invariant warnings at the worst possible
    // moment: right before the real draft (P2R2 dress rehearsal F2).
    if (typeof _dlog !== "undefined") {
      _dlog.events = []; _dlog.leagueId = null; _dlog.startedAt = 0;
      _dlog.lastEventAt = 0; _dlog.initState = null;
      try { localStorage.removeItem(_DLOG_LS_KEY); } catch (e) {}
    }
    saveLiveDraft();
    changed = true;
    console.log("[draft] purged " + n + " mock-context picks + event log (Real mode)");
  }
  return changed;
}
// A pick log shows generic "Team N" labels when this is a practice run — either
// the REST test-league override OR the extension feed set to test mode.
function draftTestMode() {
  return (typeof leagueOverrideActive === "function" && leagueOverrideActive()) || getFeedMode() === "test";
}

// ===========================================================================
// DRAFT CONTEXT — real league vs mock.
// In a mock (test mode) the room is 12 strangers: generic "Team N" teams from
// the ESPN team ids in the feed, $260 budgets, NO keepers, FULL player pool.
// Real-league names/budgets/keepers apply only when NOT in test mode. Five
// engine functions branch on this (draftExcludedNames, _inflationKeeperSelections,
// computeLiveTeamStates, teamOpenSlotProfile, processEspnPicks); everything
// else — owner interest, standings, nominations, AI, endgame — inherits.
// ===========================================================================

// Which ESPN team is ME in a mock (picked on the Draft Setup screen).
function getMyDraftEspnId() {
  const v = parseInt(localStorage.getItem("ud_test_my_team") || "", 10);
  return isFinite(v) && v > 0 ? v : null;
}
function setMyDraftEspnId(v) {
  const n = parseInt(v, 10);
  if (isFinite(n) && n > 0) localStorage.setItem("ud_test_my_team", String(n));
  else localStorage.removeItem("ud_test_my_team");
}

// Teams in the CURRENT draft context. Test mode: generic teams from the ESPN
// team ids observed in picks/events (default 1..12), $260, keeper-free.
let _draftTeamsCache = null, _draftTeamsKey = "";
function draftTeams() {
  if (!draftTestMode()) return LEAGUE.teams;
  const key = "t" + _liveDraft.picks.length + ":" + (typeof _dlog !== "undefined" ? _dlog.events.length : 0) + ":" + (getMyDraftEspnId() || 0);
  if (_draftTeamsCache && _draftTeamsKey === key) return _draftTeamsCache;
  const ids = new Set();
  for (const p of _liveDraft.picks) if (p.espnTeamId != null) ids.add(p.espnTeamId);
  if (typeof _dlog !== "undefined") {
    for (const e of _dlog.events) if (e.teamId != null && e.teamId >= 1 && e.teamId <= 20) ids.add(e.teamId);
  }
  if (!ids.size) for (let i = 1; i <= 12; i++) ids.add(i);
  const my = getMyDraftEspnId();
  if (my != null) ids.add(my);   // your seat exists even before it bids
  _draftTeamsCache = [...ids].sort((a, b) => a - b).map(n => ({
    id: "espn:" + n, espnTeamId: n, name: "Team " + n, owner: "Team " + n, isMe: n === my,
  }));
  _draftTeamsKey = key;
  return _draftTeamsCache;
}

// "Me" in the current draft context. In a mock this is null until the My-team
// selector on Draft Setup is set — me-specific panels degrade gracefully.
function getMyDraftTeam() {
  if (!draftTestMode()) return getMyTeam();
  return draftTeams().find(t => t.isMe) || null;
}

// Short label for a draft-context team id (handles "espn:N" ids).
function draftTeamLabel(teamId) {
  const t = draftTeams().find(x => x.id === teamId);
  if (t) return t.owner;
  return (typeof getTeam === "function" && getTeam(teamId)?.owner) || String(teamId || "?");
}

const _feed = { extPresent: false, extAt: 0, connected: false, leagueId: null, sport: null, count: 0, at: 0,
  tabAt: 0, tabLeagueId: null, tabSport: null, lastFrameAt: 0, staleInfo: null };

// The feed panel renders in three different views (setup lobby, Draft Mode's
// bottom zone, classic manual view). Its buttons are wired ONCE here via
// document-level delegation so they work everywhere and survive innerHTML
// rebuilds — per-view wiring kept missing one (the commissioner-undo button
// was dead outside the classic view).
document.addEventListener("click", (e) => {
  const t = e.target.closest("button, a");
  if (!t || !t.closest("#view-root, #debrief-overlay")) return;
  if (t.dataset && t.dataset.feedmode) {
    setFeedMode(t.dataset.feedmode);
    if (t.dataset.feedmode !== "off") _feedRequestSync();
    renderDraft();
  } else if (t.id === "feed-download-log") {
    downloadDraftLog();
  } else if (t.id === "feed-resync") {
    _feedRequestSync();
  } else if (t.id === "feed-clear-stale" || t.id === "feed-clear-stale-diag") {
    if (confirm("Clear the captured feed? Removes the old capture from the extension's storage and this app's event log. Your recorded picks are NOT touched (use Reset draft for that).")) {
      clearCapturedFeed();
    }
  } else if (t.id === "undo-remove-suspects") {
    const suspects = _undoSuspects();
    if (!suspects.length) return;
    const names = suspects.map(s => s.pk.player).join(", ");
    if (!confirm("Remove " + suspects.length + " pick" + (suspects.length === 1 ? "" : "s") + " (" + names + ")? ESPN's own draft state no longer includes them.")) return;
    for (const { pk, idx } of suspects.slice().sort((a, b) => b.idx - a.idx)) {
      if (pk.espnPlayerId != null) _liveDraft.deleted[pk.espnPlayerId] = (pk.espnSeq != null ? pk.espnSeq : -Date.now());
      _liveDraft.picks.splice(idx, 1);
    }
    saveLiveDraft();
    renderDraft();
  }
});

// Ask the extension (ud-bridge holds the chrome.storage keys) to wipe the
// captured feed; clear our own mirrors when it confirms.
function clearCapturedFeed() {
  try { window.postMessage({ source: "ud-app", type: "clearFeed" }, location.origin); } catch (e) {}
}
function _onFeedCleared() {
  _dlog.leagueId = null; _dlog.startedAt = 0; _dlog.events = []; _dlog.lastEventAt = 0; _dlog.initState = null;
  try { localStorage.removeItem(_DLOG_LS_KEY); } catch (e) {}
  _feed.connected = false; _feed.count = 0; _feed.leagueId = null; _feed.staleInfo = null; _feed.lastFrameAt = 0;
  if (currentView === "draft") renderDraft();
}
let _espnIdToName = null;
// True while _espnIdToName holds SYNTHETIC mock ids (seeded by the practice mock,
// mock-live-feed.js) rather than a real ESPN fetch — see reconcileDraftContext.
let _espnNamesAreMock = false;
// The practice mock seeds its synthetic id→name map here (keeps every _espnIdToName
// read site working) and flags it so Real mode can drop it. Called from
// mock-live-feed.js _mfSeedNames.
function _seedMockEspnNames(map) {
  if (!map) return;
  _espnIdToName = Object.assign(_espnIdToName || {}, map);
  _espnNamesAreMock = true;
}
let _draftTabStaleTimer = null;

// The full draft-room event stream (nominations, bids, passes, sales…) mirrored
// from the extension. Kept in memory + localStorage backup; uploaded to Supabase
// by draft-log.js. `initState` is ESPN's own pick list from the latest INIT
// frame, used to spot commissioner-undone picks.
const _dlog = { leagueId: null, sport: null, startedAt: 0, events: [], lastEventAt: 0, initState: null };
const _DLOG_LS_KEY = "ud_draft_events_v1";   // device-local backup (NOT synced — big + already mirrored to Supabase)

// localStorage failures (quota) must be VISIBLE — silently dropped writes cost
// picks on reload (P2R1 chaos-1). The events backup keeps a smaller slice than
// the in-memory cap: Supabase holds the full stream, and headroom protects the
// far-more-important pick list.
let _storageFailAt = 0;
function _storageFail(what, e) {
  _storageFailAt = Date.now();
  console.warn("[draft] localStorage write failed (" + what + "):", e && e.message);
  if (typeof setStatus === "function") setStatus("draft", "storage full!", "bad");
  if (typeof updateDraftDiagnostics === "function") updateDraftDiagnostics();
}
function _dlogPersist() {
  try {
    localStorage.setItem(_DLOG_LS_KEY, JSON.stringify({
      leagueId: _dlog.leagueId, sport: _dlog.sport, startedAt: _dlog.startedAt,
      events: _dlog.events.slice(-4000),
    }));
  } catch (e) { _storageFail("events", e); }
}
let _dlogPersistTimer = null;
function _dlogPersistSoon() {
  if (_dlogPersistTimer) return;
  _dlogPersistTimer = setTimeout(() => { _dlogPersistTimer = null; _dlogPersist(); }, 2000);
}
function _dlogLoad() {
  try {
    const v = JSON.parse(localStorage.getItem(_DLOG_LS_KEY) || "null");
    if (v && Array.isArray(v.events)) {
      _dlog.leagueId = v.leagueId; _dlog.sport = v.sport; _dlog.startedAt = v.startedAt || 0;
      _dlog.events = v.events;
      _dlog.lastEventAt = v.events.length ? (v.events[v.events.length - 1].at || 0) : 0;
    }
  } catch (e) {}
}
_dlogLoad();

// After a reload, resume the Supabase mirror where it left off (draft-log.js
// keeps an uploaded-seq watermark, so this only sends what's missing).
setTimeout(() => {
  if (_dlog.events.length && _dlogAccepts(_dlog.leagueId) && typeof logDraftEvents === "function") {
    logDraftEvents({ leagueId: _dlog.leagueId, sport: _dlog.sport, startedAt: _dlog.startedAt },
      _dlog.events, getFeedMode() !== "real");
  }
}, 3000);

// Feed events arriving while the user is mid-keystroke shouldn't rebuild the
// whole view — update the live bits of the feed panel in place instead.
function _updateFeedActivityDom() {
  if (typeof mockFeedPumping === "function" && mockFeedPumping()) return;   // suppressed during a fast-forward burst (avoids diagnostics/invariant flicker)
  const el = document.getElementById("feed-activity");
  if (el) el.innerHTML = _feedActivityHtml();
  if (typeof updateDraftDiagnostics === "function") updateDraftDiagnostics();
}

// Should this event stream be accepted + logged? Mirrors the pick-feed mode
// rules: off = no; real = only your league; test = anything.
function _dlogAccepts(leagueId) {
  const mode = getFeedMode();
  if (mode === "off") return false;
  if (mode === "real" && typeof UD_HOME_LEAGUE_ID !== "undefined" &&
      String(leagueId) !== String(UD_HOME_LEAGUE_ID)) return false;
  return true;
}

function _onDraftEvents(msg) {
  if (!msg || !msg.log || !Array.isArray(msg.events)) return;
  if (!_dlogAccepts(msg.log.leagueId)) return;
  const isNewStream = _dlog.leagueId !== msg.log.leagueId || _dlog.startedAt !== msg.log.startedAt;
  // The pick list belongs to ONE draft (P2R1 state-1 / chaos-2): a rotated
  // same-league re-draft or a cross-league switch must clear it, or draft #1's
  // picks contaminate draft #2's board and re-drafted players get swallowed.
  // First association (streamKey null, e.g. manual picks before the feed
  // connects) adopts without clearing; INIT backfill refills current picks.
  const streamKey = String(msg.log.leagueId) + ":" + String(msg.log.startedAt);
  if (_liveDraft.streamKey && _liveDraft.streamKey !== streamKey) {
    _liveDraft.picks = [];
    _liveDraft.deleted = {};
    _liveDraft.streamKey = streamKey;
    // The rotated-away draft's retained artifacts must die with it, or the
    // next tab-open "heal" re-applies the OLD draft's picks onto the fresh
    // board (P2R2 interact-F2).
    _feed.staleInfo = null;
    _feed.staleRetained = null;
    _dlog.initState = null;
    saveLiveDraft();
    if (currentView === "draft") renderDraft();
  } else if (!_liveDraft.streamKey) {
    _liveDraft.streamKey = streamKey;
    saveLiveDraft();
  }
  if (msg.full || isNewStream) {
    _dlog.leagueId = msg.log.leagueId; _dlog.sport = msg.log.sport; _dlog.startedAt = msg.log.startedAt;
    if (isNewStream) _dlog.events = [];
  }
  const last = _dlog.events.reduce((m, e) => Math.max(m, e.seq || 0), 0);
  const fresh = msg.events.filter(e => e && e.seq != null && e.seq > last);
  if (!fresh.length) return;
  _dlog.events.push(...fresh);
  if (_dlog.events.length > 15000) _dlog.events.splice(0, _dlog.events.length - 15000);
  _dlog.lastEventAt = fresh[fresh.length - 1].at || Date.now();
  _dlogPersistSoon();
  // Mirror to Supabase (draft-log.js). Mock unless Real mode on your league.
  if (typeof logDraftEvents === "function") {
    logDraftEvents({ leagueId: _dlog.leagueId, sport: _dlog.sport, startedAt: _dlog.startedAt },
      fresh, getFeedMode() !== "real");
  }
  _updateFeedActivityDom();
  if (typeof updateDraftModeLive === "function") updateDraftModeLive();
}

function _onDraftInit(init) {
  if (!init || !Array.isArray(init.picks)) return;
  if (!_dlogAccepts(init.leagueId)) return;
  _dlog.initState = init;
  if (currentView !== "draft") return;
  // Draft Mode mid-lot: patch in place (a full rebuild wipes search/scroll);
  // the undo-suspects warning lives in the bottom feed panel either way.
  if (typeof _draftModeOn === "function" && _draftModeOn()) {
    if (typeof updateDraftModeLive === "function") updateDraftModeLive();
  } else {
    renderDraft();
  }
}

// Picks we hold (from the feed) that ESPN's own latest full state no longer
// contains = likely commissioner undos. Only judged for picks made BEFORE the
// INIT snapshot (later picks are simply newer than it).
function _undoSuspects() {
  const init = _dlog.initState;
  if (!init || !Array.isArray(init.picks) || !init.picks.length) return [];
  if (String(init.leagueId) !== String(_feed.leagueId || init.leagueId)) return [];
  const inState = new Set(init.picks.map(p => p.playerId));
  return _liveDraft.picks
    .map((pk, idx) => ({ pk, idx }))
    .filter(({ pk }) => pk.espnPlayerId != null && !inState.has(pk.espnPlayerId) && (pk.ts || 0) < init.at - 3000);
}

// The ESPN draft tab heartbeats every ~8s while open. Treat it as "open" only if
// we've heard a beat in the last ~25s, so a closed tab auto-clears.
function draftTabOpen() { return _feed.tabAt && (Date.now() - _feed.tabAt) < 25000; }
function _onDraftTabPresent(tab) {
  if (!tab) return;
  // A beat is only a LIVE signal if it's recent. The extension re-pushes the
  // last STORED beat on every full sync — after a finished mock that beat is
  // hours old, and treating it as a "tab just opened" transition caused an
  // infinite heal→ping→re-push→heal render storm (~13 renders/sec) that made
  // the whole page unclickable (Jeff, Jul 5). Stale beats update fields only.
  const beatFresh = !!tab.at && (Date.now() - tab.at) < 25000;
  const wasOpen = draftTabOpen();
  _feed.tabAt = tab.at || 0;
  _feed.tabLeagueId = tab.leagueId || null;
  _feed.tabSport = tab.sport || null;
  if (tab.lastFrameAt) _feed.lastFrameAt = Math.max(_feed.lastFrameAt, tab.lastFrameAt);
  if (!beatFresh) { _updateFeedActivityDom(); return; }
  // Auto-detect "my team" in mocks: the extension reads the ESPN team id this
  // browser drafts as straight from the socket JOIN URL — no manual seat entry
  // (the number is the LEAGUE team id, not the draft-order position; auto-
  // detection removes the ambiguity entirely). Manual edits on Draft Setup
  // still work as an override until the next socket connect.
  if (tab.myTeamId != null && typeof draftTestMode === "function" && draftTestMode() &&
      typeof getMyDraftEspnId === "function" && getMyDraftEspnId() !== tab.myTeamId) {
    setMyDraftEspnId(tab.myTeamId);
    if (currentView === "draft") renderDraft();
  }
  clearTimeout(_draftTabStaleTimer);
  // When beats stop, re-render once so the panel flips to "no draft tab".
  _draftTabStaleTimer = setTimeout(() => { if (currentView === "draft") renderDraft(); }, 26000);
  if (!wasOpen) {
    // Closed→open transition (fresh beat only): heal a stale-gated capture —
    // clear the gate and re-apply so _applyDraftFeed re-runs with the tab now
    // open (P2R1 state-3, spec S-053). Ping the extension at most every 10s.
    if (_feed.staleInfo) {
      const retained = _feed.staleRetained;
      _feed.staleInfo = null;
      _feed.staleRetained = null;
      if (retained) _applyDraftFeed(retained);
      if (!_feed._lastHealPing || Date.now() - _feed._lastHealPing > 10000) {
        _feed._lastHealPing = Date.now();
        _feedRequestSync();
      }
    }
    if (currentView === "draft") renderDraft();
  } else {
    _updateFeedActivityDom();
  }
}

// Build an ESPN playerId → name map (kona_player_info) so socket picks, which
// carry only playerId, can be named. Best-effort; unresolved → "Player <id>".
// The same payload carries injuryStatus — kept in a name-keyed map so the
// on-the-clock card can flag DTD/IL players.
// IMPORTANT: only assign the map on SUCCESS — a failed fetch must retry on the
// next call, not poison the whole session with "Player 12345" names. After a
// late success, sweep already-recorded placeholder picks and fix their names.
let _espnInjuryByName = {};
let _espnNamesLoading = null;
async function _ensureEspnNames() {
  if (_espnIdToName) return;
  if (_espnNamesLoading) return _espnNamesLoading;
  _espnNamesLoading = (async () => {
    try {
      if (typeof fetchEspnPlayers !== "function") return;
      const data = await fetchEspnPlayers();
      const list = data.players || data.playerPool || [];
      const _nk = (typeof normalizePlayerName === "function") ? normalizePlayerName : (s => String(s || "").toLowerCase());
      const map = {};
      for (const e of list) {
        const p = e.player || e;
        if (!p || p.id == null) continue;
        const name = p.fullName || ((p.firstName || "") + " " + (p.lastName || "")).trim();
        map[p.id] = name;
        const inj = p.injuryStatus || e.injuryStatus;
        if (name && inj && inj !== "ACTIVE") _espnInjuryByName[_nk(name)] = inj;
      }
      if (Object.keys(map).length) {
        _espnIdToName = map;
        _espnNamesAreMock = false;   // these are real ESPN names now
        _fixPlaceholderNames();
      }
    } catch (e) { /* names are best-effort; next call retries */ }
    finally { _espnNamesLoading = null; }
  })();
  return _espnNamesLoading;
}

// Rewrite any "Player 12345" picks recorded while the name map was missing.
function _fixPlaceholderNames() {
  if (!_espnIdToName) return;
  let fixed = 0;
  for (const pk of _liveDraft.picks) {
    if (pk.espnPlayerId != null && /^Player \d+$/.test(pk.player || "") && _espnIdToName[pk.espnPlayerId]) {
      pk.player = _espnIdToName[pk.espnPlayerId];
      pk.pos = getPlayerValue(pk.player)?.posKey || pk.pos;
      fixed++;
    }
  }
  if (fixed) {
    saveLiveDraft();
    if (currentView === "draft") {
      // Mid-lot in Draft Mode, patch in place — a full rebuild eats search
      // caret/scroll (same policy as _onDraftInit).
      if (typeof _draftModeOn === "function" && _draftModeOn() && typeof updateDraftModeLive === "function") updateDraftModeLive();
      else renderDraft();
    }
  }
}

// Short human label for an ESPN injury status, or null if healthy/unknown.
function espnInjuryLabel(playerName) {
  const _nk = (typeof normalizePlayerName === "function") ? normalizePlayerName : (s => String(s || "").toLowerCase());
  const s = _espnInjuryByName[_nk(playerName)];
  if (!s) return null;
  if (s.includes("DAY_TO_DAY")) return "DTD";
  if (s.includes("SEVEN")) return "IL-7";
  if (s.includes("TEN")) return "IL-10";
  if (s.includes("FIFTEEN")) return "IL-15";
  if (s.includes("SIXTY")) return "IL-60";
  if (s.includes("SUSPEN")) return "SUSP";
  if (s.includes("OUT")) return "OUT";
  return s.replace(/_/g, " ");
}
function _resolveEspnName(id) {
  return (_espnIdToName && _espnIdToName[id]) || ("Player " + id);
}

// Ask the extension (if present) to (re)send the current feed.
function _feedRequestSync() {
  try { window.postMessage({ source: "ud-app", type: "ping" }, location.origin); } catch (e) {}
}

async function _applyDraftFeed(feed) {
  const mode = getFeedMode();
  if (mode === "off" || !feed || !Array.isArray(feed.picks)) return;
  // In "real" mode, only accept picks from your actual league.
  if (mode === "real" && typeof UD_HOME_LEAGUE_ID !== "undefined" &&
      String(feed.leagueId) !== String(UD_HOME_LEAGUE_ID)) return;

  // STALENESS GATE: chrome.storage keeps the last capture forever, and the
  // bridge re-pushes it on every page load. Old data must not present as a
  // live draft ("● Live — capturing…") or silently refill cleared picks.
  const freshest = Math.max(feed.updatedAt || 0, ...feed.picks.map(p => p.ts || 0), 0);
  if (freshest && Date.now() - freshest > 15 * 60 * 1000 && !draftTabOpen()) {
    _feed.staleInfo = { leagueId: feed.leagueId, count: feed.picks.length, at: freshest };
    _feed.staleRetained = feed;   // kept so tab-open can heal without an extension round trip
    _feed.connected = false;
    if (currentView === "draft") _updateFeedActivityDom();
    return;   // don't ingest old picks
  }
  _feed.staleInfo = null;
  _feed.staleRetained = null;

  // Stream-identity guard (mirror of _onDraftEvents' rotation): a feed from a
  // DIFFERENT stream than the current picks must not merge into them — the
  // events path owns rotation and will clear + re-accept it moments later.
  // Tolerant of sub-minute startedAt skew: older bridge versions stamped the
  // feed and event log independently (milliseconds apart), and a strict
  // comparison would silently drop every legitimate pick until the extension
  // is reloaded. Real rotations differ by an hour or more.
  if (feed.startedAt && _liveDraft.streamKey) {
    const parts = _liveDraft.streamKey.split(":");
    const skLeague = parts[0], skStarted = Number(parts[1]) || 0;
    const leagueDiffers = String(feed.leagueId) !== skLeague;
    const startedFar = skStarted && Math.abs(Number(feed.startedAt) - skStarted) > 60 * 1000;
    if (leagueDiffers || startedFar) return;
  }

  _feed.connected = true;
  _feed.leagueId = feed.leagueId;
  _feed.sport = feed.sport;
  _feed.count = feed.picks.length;
  _feed.at = Date.now();

  await _ensureEspnNames();

  // Tombstones: a manually-deleted pick (commissioner undo) must not be
  // re-added by the cumulative feed. But if the feed now carries a DIFFERENT
  // lot seq for that player, he was genuinely re-auctioned — clear the
  // tombstone and accept the new sale.
  let tombstonesChanged = false;
  const alive = feed.picks.filter(p => {
    const dead = _liveDraft.deleted[p.playerId];
    if (dead == null) return true;
    // seq tombstone: a different lot seq = genuine re-auction → resurrect.
    // negative tombstone = deletion timestamp (pick had no seq): resurrect
    // only if the feed record was written AFTER the deletion.
    const isReAuction = (typeof dead === "number" && dead < 0)
      ? ((p.ts || 0) > -dead)
      : (dead !== true && p.seq != null && String(p.seq) !== String(dead));
    if (isReAuction) {
      delete _liveDraft.deleted[p.playerId];
      tombstonesChanged = true;
      return true;
    }
    return false;
  });

  // Reconcile picks we already hold whose feed record CHANGED (undo → re-sold
  // to another team/price: the bridge replaces the pick, keeping the playerId).
  let updated = 0;
  const held = new Map(_liveDraft.picks.filter(pk => pk.espnPlayerId != null).map(pk => [pk.espnPlayerId, pk]));
  for (const p of alive) {
    const pk = held.get(p.playerId);
    if (!pk) continue;
    const seqChanged = p.seq != null && pk.espnSeq != null && String(p.seq) !== String(pk.espnSeq);
    if (seqChanged || pk.price !== p.price || pk.espnTeamId !== p.teamId) {
      pk.price = p.price;
      pk.espnTeamId = p.teamId;
      // Same owner-mapping rule as processEspnPicks: mock re-sales must stay
      // on generic espn:N teams, never a real leaguemate's ledger.
      pk.team = draftTestMode() ? ("espn:" + p.teamId) : espnTeamIdToOwnerId(p.teamId);
      pk.espnSeq = p.seq != null ? p.seq : pk.espnSeq;
      updated++;
    }
  }
  if (tombstonesChanged || updated) saveLiveDraft();

  const raws = alive.map(p => ({
    playerId: p.playerId, teamId: p.teamId, bidAmount: p.price, seq: p.seq, playerName: _resolveEspnName(p.playerId),
  }));
  // processEspnPicks (espn.js) de-dupes by espnPlayerId, saves, and re-renders.
  if (typeof processEspnPicks === "function") processEspnPicks(raws);
  if (updated && currentView === "draft" && !(typeof mockFeedPumping === "function" && mockFeedPumping())) renderDraft();
}

// Listen for the extension bridge's messages (same-window postMessage).
window.addEventListener("message", (ev) => {
  if (ev.source !== window) return;
  const d = ev.data;
  if (!d || d.source !== "keeper-edge") return;
  _feed.extPresent = true;
  _feed.extAt = Date.now();
  if (d.type === "feedCleared") _onFeedCleared();
  else if (d.type === "draftFeed") _applyDraftFeed(d.feed);
  else if (d.type === "draftEvents") _onDraftEvents(d);
  else if (d.type === "draftInit") _onDraftInit(d.init);
  else if (d.type === "draftTab") _onDraftTabPresent(d.tab);
  else if (d.type === "hello" && currentView === "draft") renderDraft();
});
// One-time nudge in case the app loaded before the extension bridge.
setTimeout(_feedRequestSync, 800);

function renderDraftFeedPanel() {
  const mode = getFeedMode();
  const seg = (val, label, sub) =>
    '<button class="btn' + (mode === val ? ' primary' : ' ghost') + '" data-feedmode="' + val +
    '" style="border-radius:0;">' + label + (sub ? ' <span class="small" style="opacity:.8;">' + sub + '</span>' : '') + '</button>';

  // Auto-detected state of the two links in the chain.
  const tabOpen = draftTabOpen();
  const dot = (on, color) => '<span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:' +
    (on ? color : "var(--text-3)") + '; margin-right:5px; vertical-align:middle;"></span>';

  // Extension detected? / ESPN draft tab open? — two auto-detected indicators.
  let detect = '<div class="small" style="margin-top:6px; display:flex; gap:16px; flex-wrap:wrap;">';
  detect += '<span>' + dot(_feed.extPresent, "var(--good)") + (_feed.extPresent ? "Keeper Edge connected" : "Keeper Edge not detected") + '</span>';
  detect += '<span>' + dot(tabOpen, "var(--good)") +
    (tabOpen ? "ESPN draft tab open — " + esc(_feed.tabSport === "ffl" ? "football" : _feed.tabSport === "flb" ? "baseball" : (_feed.tabSport || "?")) + " · league " + esc(String(_feed.tabLeagueId || "?"))
             : "No ESPN draft tab open") + '</span>';
  detect += '</div>';

  let status, cls;
  if (_feed.staleInfo && !_feed.connected) {
    const age = Math.round((Date.now() - _feed.staleInfo.at) / 3600000);
    cls = "muted";
    status = "Last capture: league <b>" + esc(String(_feed.staleInfo.leagueId)) + "</b> — " + _feed.staleInfo.count +
      " picks, " + (age < 1 ? "under an hour" : age < 48 ? age + "h" : Math.round(age / 24) + "d") + " ago (not live). " +
      '<button class="btn ghost" id="feed-clear-stale" style="padding:1px 8px; font-size:11px;">🗑 Clear captured feed</button>';
  } else if (!_feed.extPresent) {
    cls = "warn"; status = "Load/reload Keeper Edge (chrome://extensions), then reopen this tab.";
  } else if (mode === "off") {
    cls = "muted"; status = tabOpen
      ? "Draft tab detected. Pick <b>Test</b> or <b>Real</b> to start auto-capturing picks."
      : "Feed off. Pick <b>Test</b> or <b>Real</b>, then open your ESPN draft tab.";
  } else if (_feed.connected && _feed.count > 0) {
    cls = "good"; status = "● Live — capturing league <b>" + esc(String(_feed.leagueId || "?")) + "</b>: <b>" + _feed.count + "</b> pick" + (_feed.count === 1 ? "" : "s") + " received.";
  } else if (tabOpen && mode === "real" && String(_feed.tabLeagueId) !== String(typeof UD_HOME_LEAGUE_ID !== "undefined" ? UD_HOME_LEAGUE_ID : 1200)) {
    cls = "warn"; status = "Draft tab is league <b>" + esc(String(_feed.tabLeagueId)) + "</b>, but Real mode only accepts your league (" + (typeof UD_HOME_LEAGUE_ID !== "undefined" ? UD_HOME_LEAGUE_ID : 1200) + "). Switch to <b>Test</b> for a mock.";
  } else if (tabOpen) {
    cls = "muted"; status = "Connected to your draft tab — waiting for the first pick. Picks appear here automatically.";
  } else {
    cls = "muted"; status = "Waiting for your ESPN draft tab… open your " + (mode === "real" ? "league's draft" : "mock draft") + " and start it.";
  }
  const colorVar = cls === "good" ? "var(--good)" : cls === "warn" ? "var(--warn)" : "var(--text-2)";

  let html = '<div class="card" style="padding:10px 12px;">';
  html += '<div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">';
  html += '<b>Live Pick Feed</b> <span class="muted small">via Keeper Edge — no manual entry</span>';
  html += '<span style="flex:1;"></span>';
  html += '<div class="seg" style="display:inline-flex; border:1px solid var(--border); border-radius:6px; overflow:hidden;">';
  html += seg("off", "Off", "");
  html += seg("test", "Test", "(mock)");
  html += seg("real", "Real", "(my league)");
  html += '</div></div>';
  html += detect;
  html += '<div class="small" style="margin-top:4px; color:' + colorVar + ';">' + status + '</div>';
  html += '<div id="feed-activity">' + _feedActivityHtml() + '</div>';
  html += _undoSuspectsHtml();
  html += _feedDiagnosticsHtml();
  html += '</div>';
  return html;
}

// --- Live activity + watchdog -----------------------------------------------
// Human-readable line for the newest draft-room event, plus a loud warning when
// the ESPN tab is open but the socket has gone quiet (pipe broken vs. tab
// closed — the failure mode that silently ate picks in the last mock).

function _describeDraftEvent(e) {
  if (!e) return "";
  const test = draftTestMode();
  const owner = (!test && e.teamId != null && typeof espnTeamIdToOwnerId === "function")
    ? (getTeam(espnTeamIdToOwnerId(e.teamId))?.owner || null) : null;
  const team = e.teamId != null ? (owner || "Team " + e.teamId) : "";
  const player = e.playerId != null ? ((_espnIdToName && _espnIdToName[e.playerId]) || "player " + e.playerId) : "";
  switch (e.cmd) {
    case "NOMINATION": return team + " nominates" + (player ? " " + player : "");
    case "BID":        return team + " bids" + (e.amount != null ? " $" + e.amount : "") + (player ? " — " + player : "");
    case "BID_ACK":    return "bid confirmed" + (e.amount != null ? " at $" + e.amount : "");
    case "PASSED":     return team + " passes";
    case "SOLD":       return "SOLD — " + (player || "?") + " to " + (team || "?") + " for $" + (e.amount != null ? e.amount : "?");
    case "INIT":       return "full draft state received (" + (e.text || "") + ")";
    case "SOCKET_OPEN":  return "draft-room socket connected";
    case "SOCKET_CLOSE": return "draft-room socket closed (" + (e.text || "?") + ")";
    case "SOCKET_ERROR": return "draft-room socket error";
    default:           return e.cmd + (e.text ? " · " + e.text.slice(0, 80) : "");
  }
}

// Classify feed silence. Commissioner pauses are REAL-DRAFT-ONLY (mocks never
// have them) and can't be rehearsed, so the watchdog must be pause-safe by
// construction: silence is only a red "stalled" alarm when it began MID-LOT
// (bidding was in flight — frames should never stop then). Silence after a
// SOLD, or on an idle lot, reads as a pause/between-lots gap: muted, no alarm.
function _feedStallState() {
  const lastFrame = Math.max(_feed.lastFrameAt || 0, _dlog.lastEventAt || 0);
  const quietMs = lastFrame ? Date.now() - lastFrame : 0;
  if (!lastFrame || !draftTabOpen() || quietMs <= 30000) return { level: "ok", quietSecs: Math.round(quietMs / 1000), midLot: false };
  let last = null;
  for (let i = _dlog.events.length - 1; i >= 0; i--) {
    const c = _dlog.events[i].cmd;
    if (c === "NOMINATION" || c === "BID" || c === "BID_ACK" || c === "PASSED" || c === "SOLD" || c === "INIT") { last = c; break; }
  }
  const midLot = last === "NOMINATION" || last === "BID" || last === "BID_ACK" || last === "PASSED";
  return { level: midLot ? "stalled" : "quiet", quietSecs: Math.round(quietMs / 1000), midLot };
}

function _feedActivityHtml() {
  const mode = getFeedMode();
  if (mode === "off") return "";
  let html = "";
  const last = _dlog.events.length ? _dlog.events[_dlog.events.length - 1] : null;
  if (last) {
    const age = Math.max(0, Math.round((Date.now() - (last.at || 0)) / 1000));
    html += '<div class="small muted" style="margin-top:4px;">Last activity ' +
      (last.at ? age + "s ago" : "—") + ' · ' + esc(_describeDraftEvent(last)) +
      ' <span class="dim">(' + _dlog.events.length + ' events logged)</span></div>';
  }
  // Watchdog (pause-safe): red only when silence began MID-LOT.
  const stall = _feedStallState();
  if (stall.level === "stalled") {
    html += '<div class="small" style="margin-top:4px; color:var(--bad);"><b>⚠ Feed stalled mid-bidding (' +
      stall.quietSecs + 's silent)</b> — reload the ESPN draft tab, then this tab ' +
      '(the INIT backfill recovers anything missed).</div>';
  } else if (stall.level === "quiet") {
    html += '<div class="small muted" style="margin-top:4px;">Quiet ' + Math.round(stall.quietSecs / 60) +
      'm — commissioner pause or between lots; picks resume automatically.</div>';
  }
  return html;
}

// Commissioner-undo reconciliation: picks we hold that ESPN's latest full state
// (INIT frame, sent on socket reconnect) no longer contains.
function _undoSuspectsHtml() {
  if (getFeedMode() === "off") return "";
  const suspects = _undoSuspects();
  if (!suspects.length) return "";
  let html = '<div class="small" style="margin-top:6px; padding:8px 10px; border:1px solid var(--warn); background:rgba(210,153,34,.08);">';
  html += '<b style="color:var(--warn);">⚠ ' + suspects.length + ' recorded pick' + (suspects.length === 1 ? '' : 's') +
    ' no longer in ESPN\'s draft state</b> — likely undone by the commissioner:';
  html += '<ul style="margin:4px 0 6px 18px;">';
  for (const { pk } of suspects.slice(0, 8)) {
    html += '<li>' + esc(pk.player) + ' — $' + pk.price + '</li>';
  }
  html += '</ul>';
  html += '<button class="btn ghost" id="undo-remove-suspects" style="padding:3px 10px;">Remove ' +
    (suspects.length === 1 ? 'it' : 'them') + '</button>';
  html += ' <span class="muted">(each gets a tombstone; a genuine re-auction is still accepted)</span>';
  html += '</div>';
  return html;
}

// Diagnostics: the black box. Event counts, pipe ages, Supabase mirror status,
// and a one-click export of everything for post-mortem debugging.
function _feedDiagnosticsHtml() {
  if (getFeedMode() === "off") return "";
  let html = '<details style="margin-top:6px;"><summary class="small muted" style="cursor:pointer;">Diagnostics & event log</summary>';
  html += '<div id="feed-diag-body" class="small" style="margin-top:6px;">' + _feedDiagBodyHtml() + '</div>';
  html += '<div style="display:flex; gap:8px; margin-top:6px; flex-wrap:wrap;">';
  html += '<button class="btn ghost" id="feed-download-log" style="padding:3px 10px; font-size:11px;">⬇ Download event log</button>';
  html += '<button class="btn ghost" id="feed-resync" style="padding:3px 10px; font-size:11px;">↻ Re-sync from extension</button>';
  html += '<button class="btn ghost" id="feed-clear-stale-diag" style="padding:3px 10px; font-size:11px;">🗑 Clear captured feed</button>';
  html += '</div></details>';
  return html;
}

function _feedDiagBodyHtml() {
  const now = Date.now();
  const fmtAge = (t) => t ? Math.round((now - t) / 1000) + "s ago" : "never";
  let rows = [];
  rows.push(["Extension", _feed.extPresent ? "connected" : "not detected"]);
  rows.push(["ESPN tab heartbeat", fmtAge(_feed.tabAt)]);
  rows.push(["Last socket frame", fmtAge(Math.max(_feed.lastFrameAt || 0, _dlog.lastEventAt || 0))]);
  rows.push(["Events logged", String(_dlog.events.length) + (_dlog.leagueId ? " (league " + _dlog.leagueId + ")" : "")]);
  rows.push(["Picks held", String(_liveDraft.picks.length) + " · tombstones " + Object.keys(_liveDraft.deleted).length]);
  if (_dlog.initState) rows.push(["ESPN state (INIT)", _dlog.initState.picks.length + " picks, " + fmtAge(_dlog.initState.at)]);
  if (_storageFailAt) rows.push(["⚠ Storage", "a localStorage write FAILED " + Math.round((Date.now() - _storageFailAt) / 60000) + "m ago (quota?) — picks may not survive a reload; export the event log now"]);
  if (typeof draftLogStatus === "function") {
    const s = draftLogStatus();
    rows.push(["Supabase mirror", s.sessionId
      ? ("session " + String(s.sessionId).slice(0, 8) + "… (" + (s.isMock ? "mock" : "REAL") + ") · uploaded thru seq " + s.uploadedSeq + " · pending " + s.pending)
      : (s.pending ? s.pending + " events pending (session not started)" : "idle")]);
    if (s.lastError) rows.push(["Mirror error", s.lastError + " (retrying)"]);
  }
  let html = rows.map(r => '<div><span class="muted">' + r[0] + ':</span> ' + esc(String(r[1])) + '</div>').join("");
  if (typeof renderInvariantsLine === "function") html += '<div style="margin-top:2px;">' + renderInvariantsLine() + '</div>';
  return html;
}

function updateDraftDiagnostics() {
  const el = document.getElementById("feed-diag-body");
  if (el) el.innerHTML = _feedDiagBodyHtml();
}

function downloadDraftLog() {
  const payload = {
    exportedAt: new Date().toISOString(),
    league: _dlog.leagueId, sport: _dlog.sport, startedAt: _dlog.startedAt,
    feedMode: getFeedMode(),
    events: _dlog.events,
    initState: _dlog.initState,
    picks: _liveDraft.picks,
    tombstones: _liveDraft.deleted,
    supabase: (typeof draftLogStatus === "function") ? draftLogStatus() : null,
  };
  const blob = new Blob([JSON.stringify(payload, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "draft-log-" + (_dlog.leagueId || "unknown") + "-" + new Date().toISOString().slice(0, 10) + ".json";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

// Keep the activity/watchdog ages fresh without full re-renders.
setInterval(() => {
  // An extension reload/crash kills both content-script bridges silently —
  // expire the "connected" dot when we haven't heard anything for 60s.
  if (_feed.extPresent && _feed.extAt && Date.now() - _feed.extAt > 60000) {
    _feed.extPresent = false;
    if (typeof currentView !== "undefined" && currentView === "draft") renderDraft();
  }
  if (typeof currentView !== "undefined" && currentView === "draft") {
    _updateFeedActivityDom();
    // Keep the cockpit's time-derived bits (pause banner, feed-age chips)
    // moving during quiet spells — nothing else re-renders without frames
    // (P2R2 dress rehearsal F3).
    if (typeof _draftModeOn === "function" && _draftModeOn() && typeof updateDraftModeLive === "function") updateDraftModeLive();
  }
}, 10000);

// Enforce Real mode's guarantees at LOAD, not just on click — aged/cloud-synced
// mock state (picks, league override) must be reconciled before the first
// render. Lives at the end of the file so every const it touches is initialized
// (an earlier placement hit FEED_MODE_KEY's temporal dead zone and died silently).
try { reconcileDraftContext(); } catch (e) { console.warn("[draft] load reconcile failed:", e && e.message); }
