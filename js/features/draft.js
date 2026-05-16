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

// Live inflation accounting for picks made so far.
function computeLiveInflation() {
  const flat = computeFlatInflation();
  if (!flat) return null;
  const draftedNames = new Set(_liveDraft.picks.map(p => p.player));
  const spent = _liveDraft.picks.reduce((s, p) => s + p.price, 0);
  const values = getValues();
  let remainingValue = 0;
  const keptNames = new Set(collectKeepers().map(k => k.name));
  for (const p of values) {
    if (p.value <= 0) continue;
    if (keptNames.has(p.name) || draftedNames.has(p.name)) continue;
    remainingValue += p.value;
  }
  const remaining = Math.max(0, flat.leagueRemaining - spent);
  const mult = remainingValue > 0 ? remaining / remainingValue : 1;
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
    badge.textContent = "infl " + inflation.multiplier.toFixed(2) + "x";
    badge.className = "badge " + (inflation.multiplier > 1.2 ? "hot" : inflation.multiplier < 1.0 ? "cold" : "");
  }
  setStatus("draft", _liveDraft.picks.length + " picks", _liveDraft.picks.length > 0 ? "ok" : "");

  let html = '';

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
    html += '<input id="otc-nominate-name" placeholder="Player name…" style="flex: 1; min-width: 200px; font-size: 16px;">';
    html += '<input id="otc-nominate-open" type="number" placeholder="Opening $" value="1" style="width: 100px; font-size: 16px;">';
    html += '<button class="btn primary" id="otc-nominate" style="width: auto; padding: 10px 16px; font-size: 14px;">Nominate</button>';
    html += '</div>';
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
  const draftedNames = new Set(_liveDraft.picks.map(p => p.player));
  const keptNames = new Set(collectKeepers().map(k => k.name));
  let players = getValues().filter(p => !draftedNames.has(p.name) && !keptNames.has(p.name));
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
  html += '<table style="font-size: 12px;"><thead><tr><th class="num">#</th><th>Player</th><th>Team</th><th class="num">$</th><th class="num">vs Val</th></tr></thead><tbody>';
  const recent = _liveDraft.picks.slice(-12).reverse();
  const myId = getMyTeam()?.id;
  for (let i = 0; i < recent.length; i++) {
    const pk = recent[i];
    const val = getPlayerValue(pk.player);
    const v = val ? val.value : 0;
    const surplus = v - pk.price;
    const isMine = pk.team === myId;
    html += '<tr' + (isMine ? ' style="background: rgba(79,142,247,.06);"' : '') + '>';
    html += '<td class="num dim">' + (_liveDraft.picks.length - i) + '</td>';
    html += '<td>' + esc(pk.player) + '</td>';
    html += '<td>' + esc(getTeam(pk.team)?.owner || pk.team) + '</td>';
    html += '<td class="num">$' + pk.price + '</td>';
    html += '<td class="num ' + (surplus > 0 ? 'good' : 'bad') + '">' + (val ? (surplus > 0 ? '+' : '') + '$' + surplus.toFixed(0) : '—') + '</td>';
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
    renderDraft();
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
  // Nominate via input
  document.getElementById("otc-nominate")?.addEventListener("click", () => {
    const name = document.getElementById("otc-nominate-name").value.trim();
    const open = parseFloat(document.getElementById("otc-nominate-open").value) || 1;
    if (!name) { alert("Enter a player name."); return; }
    startAuction(name, open);
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
    });
  });
  document.getElementById("otc-price")?.addEventListener("change", (e) => {
    _liveDraft.highBid = parseInt(e.target.value, 10) || 0;
  });
  document.getElementById("otc-team")?.addEventListener("change", (e) => {
    _liveDraft.highBidder = e.target.value;
  });
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
