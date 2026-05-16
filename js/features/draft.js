// Live Draft view. Manual-entry mode lets Jeff record each pick as it
// happens; the engine auto-recomputes inflation and updates the category
// dashboard and nomination suggestions in real time. ESPN polling will replace
// the manual entry step once the Worker proxy is wired.

const _liveDraft = {
  picks: [],           // [{ player, pos, team, price, ts }]
  current: null,       // { player, pos } currently up for auction
  highBid: 0,
  highBidder: null,
};

function getMyLiveDraftPicks() {
  const me = getMyTeam();
  if (!me) return [];
  return _liveDraft.picks.filter(p => p.team === me.id).map(p => p.player);
}

// Compute inflation accounting for live picks made so far. Treats already-
// drafted players as out of the pool, deducts spent $ from league total.
function computeLiveInflation() {
  const flat = computeFlatInflation();
  if (!flat) return null;
  const draftedNames = new Set(_liveDraft.picks.map(p => p.player));
  const spent = _liveDraft.picks.reduce((s, p) => s + p.price, 0);

  // Adjust remaining $ and value
  const values = getValues();
  let remainingValue = 0;
  const keptNames = new Set(collectKeepers().map(k => k.name));
  for (const p of values) {
    if (p.value <= 0) continue;
    if (keptNames.has(p.name) || draftedNames.has(p.name)) continue;
    remainingValue += p.value;
  }
  const remaining = flat.leagueRemaining - spent;
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
    root.innerHTML = '<div class="empty"><p>Live Draft requires projections.</p></div>';
    return;
  }

  const inflation = computeLiveInflation();
  // Update inflation badge
  const badge = document.getElementById("inflation-badge");
  if (inflation) {
    badge.textContent = "infl " + inflation.multiplier.toFixed(2) + "x";
    badge.className = "badge " + (inflation.multiplier > 1.2 ? "hot" : inflation.multiplier < 1.0 ? "cold" : "");
  }
  setStatus("draft", _liveDraft.picks.length + " picks", _liveDraft.picks.length > 0 ? "ok" : "");

  let html = '';

  // Pick entry form
  html += '<div class="card">';
  html += '<h2>Record a Pick</h2>';
  html += '<p class="muted small">Manual entry. ESPN auto-polling activates when proxy URL is configured below.</p>';
  html += '<div style="display: flex; gap: 8px; flex-wrap: wrap; align-items: center;">';
  html += '<input id="live-player" placeholder="Player name" style="flex: 2; min-width: 200px;">';
  html += '<input id="live-price" type="number" placeholder="$ Price" style="width: 100px;">';
  html += '<select id="live-team" style="min-width: 180px;">';
  for (const t of LEAGUE.teams) {
    html += '<option value="' + t.id + '">' + esc(t.name) + ' · ' + esc(t.owner) + '</option>';
  }
  html += '</select>';
  html += '<button class="btn primary" id="live-record" style="width: auto; padding: 8px 16px;">Record</button>';
  html += '<button class="btn ghost" id="live-undo" title="Undo last pick">↶ Undo</button>';
  html += '</div>';
  html += '</div>';

  // ESPN proxy + AI controls
  html += '<div class="card">';
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
  html += '<span class="muted small">' + (ESPN.proxyUrl ? "Proxy configured. Polling every " + (ESPN.pollInterval / 1000) + "s." : "Set proxy URL to enable ESPN polling + AI assistant.") + '</span>';
  html += '</div>';
  html += '</div>';

  // AI assistant
  html += renderAiAssistantPanel();

  // Three-column layout: category dashboard, nominations, recent picks
  html += '<div class="grid cols-2">';
  // Left: your category projection
  html += '<div>';
  html += renderCategoryDashboard();
  html += '</div>';
  // Right: nominations + recent picks
  html += '<div>';
  html += '<div class="card"><h2>Nomination Targets</h2>';
  html += renderNominationsPanel();
  html += '</div>';
  html += '</div>';
  html += '</div>';

  // Recent picks
  html += '<div class="card"><h2>Picks (' + _liveDraft.picks.length + ')</h2>';
  if (!_liveDraft.picks.length) {
    html += '<p class="muted small">No picks recorded yet. Inflation badge updates as you enter picks.</p>';
  } else {
    html += '<table><thead><tr><th class="num">#</th><th>Player</th><th>Pos</th><th>Team</th><th class="num">Price</th><th class="num">Value</th><th class="num">Surplus</th></tr></thead><tbody>';
    const myId = getMyTeam()?.id;
    for (let i = _liveDraft.picks.length - 1; i >= 0; i--) {
      const pk = _liveDraft.picks[i];
      const val = getPlayerValue(pk.player);
      const v = val ? val.value : 0;
      const surplus = v - pk.price;
      const isMine = pk.team === myId;
      html += '<tr' + (isMine ? ' style="background: rgba(79,142,247,.06);"' : '') + '>';
      html += '<td class="num dim">' + (i + 1) + '</td>';
      html += '<td>' + esc(pk.player) + '</td>';
      html += '<td>' + (val ? esc(val.posKey) : '<span class="dim">?</span>') + '</td>';
      html += '<td>' + esc(getTeam(pk.team)?.owner || pk.team) + (isMine ? ' <span class="kbd">you</span>' : '') + '</td>';
      html += '<td class="num">$' + pk.price + '</td>';
      html += '<td class="num">' + (val ? '$' + v.toFixed(0) : '<span class="dim">—</span>') + '</td>';
      html += '<td class="num ' + (surplus > 0 ? 'good' : 'bad') + '">' + (val ? (surplus > 0 ? '+' : '') + '$' + surplus.toFixed(0) : '<span class="dim">—</span>') + '</td>';
      html += '</tr>';
    }
    html += '</tbody></table>';
  }
  html += '</div>';

  root.innerHTML = html;

  // Wire
  document.getElementById("live-record").addEventListener("click", recordLivePick);
  document.getElementById("live-player").addEventListener("keydown", (e) => {
    if (e.key === "Enter") recordLivePick();
  });
  document.getElementById("live-price").addEventListener("keydown", (e) => {
    if (e.key === "Enter") recordLivePick();
  });
  document.getElementById("live-undo").addEventListener("click", () => {
    if (_liveDraft.picks.length && confirm("Undo last pick?")) {
      _liveDraft.picks.pop();
      saveLiveDraft();
      renderDraft();
    }
  });
  document.getElementById("proxy-save")?.addEventListener("click", () => {
    const v = document.getElementById("proxy-url").value;
    setProxyUrl(v);
    renderDraft();
  });
  document.getElementById("espn-start")?.addEventListener("click", () => {
    startEspnPolling();
    renderDraft();
  });
  document.getElementById("espn-stop")?.addEventListener("click", () => {
    stopEspnPolling();
    renderDraft();
  });
  wireAiPanel();
}

function recordLivePick() {
  const player = document.getElementById("live-player").value.trim();
  const price = parseFloat(document.getElementById("live-price").value);
  const team = document.getElementById("live-team").value;
  if (!player || !price || !team) {
    alert("Player, price, and team are required.");
    return;
  }
  const val = getPlayerValue(player);
  _liveDraft.picks.push({
    player,
    pos: val ? val.posKey : null,
    team,
    price,
    ts: Date.now(),
  });
  saveLiveDraft();
  // Reset inputs
  document.getElementById("live-player").value = "";
  document.getElementById("live-price").value = "";
  document.getElementById("live-player").focus();
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
