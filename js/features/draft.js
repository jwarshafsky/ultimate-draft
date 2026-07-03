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
  picks: [],            // [{ player, pos, team, price, ts, espnPlayerId }]
  current: null,        // { player, posKey, value } currently up for auction
  highBid: 0,
  highBidder: null,
  poolFilter: { pos: "ALL", search: "" },
};

function getMyLiveDraftPicks() {
  const me = getMyTeam();
  if (!me) return [];
  return _liveDraft.picks.filter(p => p.team === me.id).map(p => p.player);
}

// Names of every player already drafted in the live draft (taken).
function getDraftedNames() {
  return new Set(_liveDraft.picks.map(p => p.player));
}

// Players still nominate-able: in the value pool, not drafted, not kept.
// Sorted by value so the typeahead surfaces the best names first.
function availableDraftPool() {
  const _nk = (typeof normalizePlayerName === "function") ? normalizePlayerName : (s => String(s || "").toLowerCase());
  const drafted = new Set(_liveDraft.picks.map(p => _nk(p.player)));
  const kept = new Set(collectKeepers().map(k => _nk(k.name)));
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
  const kept = new Set(collectKeepers().map(k => _nk(k.name)));

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
  const keptNames = new Set(collectKeepers().map(k => _nk(k.name)));
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
  if (!getValues().length) {
    root.innerHTML = '<div class="empty"><p>Live Draft requires projections.</p><p class="small">Import a FanGraphs CSV on the Data tab.</p></div>';
    return;
  }

  const inflation = computeLiveInflation();
  const badge = document.getElementById("inflation-badge");
  if (inflation) {
    badge.textContent = "live infl " + inflation.multiplier.toFixed(2) + "×";
    badge.title = "Live auction inflation — remaining budget vs. remaining player value, recomputed from the picks recorded so far.";
    badge.className = "badge " + (inflation.multiplier > 1.2 ? "hot" : inflation.multiplier < 1.0 ? "cold" : "");
  }
  setStatus("draft", _liveDraft.picks.length + " picks", _liveDraft.picks.length > 0 ? "ok" : "");

  let html = '';

  // === Draft controls (reset / undo) ===
  html += renderDraftControls();

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
    html += renderInflationCurve();
    html += renderSpendingPace();
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
  html += '<b>Live Draft</b> <span class="muted small">' + n + ' pick' + (n === 1 ? '' : 's') + ' recorded · keepers excluded</span>';
  html += '<span style="flex:1;"></span>';
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
    html += '<div class="otc-player">' + esc(c.player) + '</div>';
    html += '<div class="otc-meta">';
    html += '<span class="kbd">' + esc(val?.posKey || "?") + '</span>';
    if (val?.team) html += ' <span class="muted">' + esc(val.team) + '</span>';
    html += ' · <span class="muted">value</span> $' + (val ? val.value.toFixed(0) : "?");
    if (nfbc?.avg) html += ' · <span class="muted">NFBC avg</span> $' + nfbc.avg.toFixed(0) + (nfbc.min && nfbc.max ? ' <span class="muted small">[' + nfbc.min + '-' + nfbc.max + ']</span>' : "");
    if (sc?.xwOBA) html += ' · <span class="muted">xwOBA</span> ' + sc.xwOBA.toFixed(3);
    if (sc?.xERA) html += ' · <span class="muted">xERA</span> ' + sc.xERA.toFixed(2);
    html += '</div>';
    if (sig) html += '<div class="otc-signal ' + sig.signal + '">' + (sig.signal === "buy" ? "📈 BUY signal" : "📉 SELL signal") + ': ' + esc(sig.reason) + '</div>';
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
    for (const t of LEAGUE.teams) {
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
  const keptNames = new Set(collectKeepers().map(k => _nk(k.name)));
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
  let html = '<div class="card"><h3>Recent Picks (last 12)</h3>';
  html += '<p class="muted small" style="margin:0 0 6px;">↶ reverts the draft to just before that pick.</p>';
  html += '<table style="font-size: 12px;"><thead><tr><th class="num">#</th><th>Player</th><th>Team</th><th class="num">$</th><th class="num">vs Val</th><th></th></tr></thead><tbody>';
  const recent = _liveDraft.picks.slice(-12).reverse();
  const myId = getMyTeam()?.id;
  for (let i = 0; i < recent.length; i++) {
    const pk = recent[i];
    const origIndex = _liveDraft.picks.length - 1 - i;   // index in _liveDraft.picks
    const val = getPlayerValue(pk.player);
    const v = val ? val.value : 0;
    const surplus = v - pk.price;
    const testMode = typeof leagueOverrideActive === "function" && leagueOverrideActive();
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
      const who = pk ? (getTeam(pk.team)?.owner || pk.team) : "someone";
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
  _liveDraft.highBidder = getMyTeam()?.id || LEAGUE.teams[0].id;
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

function saveLiveDraft() {
  try { localStorage.setItem("ud_live_draft_v1", JSON.stringify(_liveDraft.picks)); } catch {}
}
function loadLiveDraft() {
  try {
    const v = JSON.parse(localStorage.getItem("ud_live_draft_v1") || "[]");
    if (Array.isArray(v)) _liveDraft.picks = v;
  } catch {}
}
loadLiveDraft();
