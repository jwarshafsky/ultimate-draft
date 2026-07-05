// Post-draft debrief — an auto recap opened from the Live Draft controls or
// Draft Mode. Works off the recorded picks (_liveDraft.picks) plus, when
// available, the full event stream (_dlog.events) for nomination patterns and
// a retrospective cold/hot read on each sale. Renders into a fixed overlay so
// it never disturbs draft state.

function _dbNk(s) { return (typeof normalizePlayerName === "function") ? normalizePlayerName(s) : String(s || "").toLowerCase(); }

// Signed money: +$14 / -$15 (not "$-15").
function _dbSigned(n) { return (n >= 0 ? "+$" : "-$") + Math.abs(n).toFixed(0); }

function _dbTeamLabel(pick) {
  if (typeof draftTestMode === "function" && draftTestMode()) return "Team " + (pick.espnTeamId != null ? pick.espnTeamId : "?");
  return (typeof getTeam === "function" && getTeam(pick.team)?.owner) || pick.team || "?";
}

// Retrospective cold/hot classification per SOLD lot from the event log: a sale
// with few distinct bidders AND a price well under market reads "cold" (bargain
// nobody chased); many bidders or a price over market reads "hot".
function _dbLotReads() {
  const reads = {};   // espnPlayerId -> { bidders, cold, hot, price, market }
  if (typeof _dlog === "undefined" || !_dlog.events) return reads;
  let cur = null;
  for (const e of _dlog.events) {
    if (e.cmd === "NOMINATION" && e.playerId) cur = { playerId: e.playerId, bidders: new Set(), bids: 0 };
    else if ((e.cmd === "BID" || e.cmd === "BID_ACK") && e.playerId) {
      if (!cur || cur.playerId !== e.playerId) cur = { playerId: e.playerId, bidders: new Set(), bids: 0 };
      if (e.teamId != null) cur.bidders.add(e.teamId);
      cur.bids++;
    } else if (e.cmd === "SOLD" && e.playerId) {
      const bidders = cur && cur.playerId === e.playerId ? cur.bidders.size : (e.teamId != null ? 1 : 0);
      const name = (typeof _resolveEspnName === "function") ? _resolveEspnName(e.playerId) : null;
      const val = name && typeof getPlayerValue === "function" ? getPlayerValue(name) : null;
      const nf = name && typeof getNfbc === "function" ? getNfbc(name) : null;
      const market = Math.max(val ? val.value : 0, nf?.avg || 0);
      const price = e.amount || 0;
      reads[e.playerId] = {
        bidders, price, market,
        cold: bidders <= 2 && market > 0 && price < market * 0.8,
        hot: bidders >= 4 || (market > 0 && price > market * 1.1),
      };
      cur = null;
    }
  }
  return reads;
}

// Nomination patterns (first look): per team, how many players they nominated
// and how often they won what they nominated (telegraphed targets).
function _dbNominationPatterns() {
  if (typeof _dlog === "undefined" || !_dlog.events) return null;
  const noms = {}, selfWins = {};
  const nominatedBy = {};   // playerId -> teamId of nominator
  for (const e of _dlog.events) {
    if (e.cmd === "NOMINATION" && e.playerId && e.teamId != null) {
      noms[e.teamId] = (noms[e.teamId] || 0) + 1;
      nominatedBy[e.playerId] = e.teamId;
    } else if (e.cmd === "SOLD" && e.playerId && e.teamId != null) {
      if (nominatedBy[e.playerId] === e.teamId) selfWins[e.teamId] = (selfWins[e.teamId] || 0) + 1;
    }
  }
  const rows = Object.keys(noms).map(tid => ({ teamId: tid, noms: noms[tid], selfWins: selfWins[tid] || 0 }));
  rows.sort((a, b) => b.noms - a.noms);
  return rows.length ? rows : null;
}

function renderDebrief() {
  const picks = (typeof _liveDraft !== "undefined") ? _liveDraft.picks : [];
  if (!picks.length) return '<p class="muted">No picks recorded yet — the debrief fills in as the draft runs.</p>';

  const reads = _dbLotReads();
  const meId = (typeof getMyTeam === "function") ? getMyTeam()?.id : null;

  // Per-pick enrichment.
  const rows = picks.map(p => {
    const val = (typeof getPlayerValue === "function") ? getPlayerValue(p.player) : null;
    const nf = (typeof getNfbc === "function") ? getNfbc(p.player) : null;
    const model = val ? val.value : null;
    const surplus = model != null ? model - p.price : null;
    const read = p.espnPlayerId != null ? reads[p.espnPlayerId] : null;
    return { p, model, nfbc: nf?.avg ?? null, surplus, read, isMine: p.team === meId };
  });

  // Team surplus totals.
  const teamAgg = {};
  for (const r of rows) {
    const k = r.p.team || ("espn:" + r.p.espnTeamId);
    const t = teamAgg[k] || (teamAgg[k] = { label: _dbTeamLabel(r.p), spent: 0, surplus: 0, n: 0, isMine: r.isMine });
    t.spent += r.p.price; t.n++;
    if (r.surplus != null) t.surplus += r.surplus;
  }
  const teamRows = Object.values(teamAgg).sort((a, b) => b.surplus - a.surplus);

  let html = '';

  // My draft summary
  const mine = rows.filter(r => r.isMine);
  if (mine.length) {
    const spent = mine.reduce((s, r) => s + r.p.price, 0);
    const surplus = mine.reduce((s, r) => s + (r.surplus || 0), 0);
    const myNames = mine.map(r => r.p.player);
    const cats = (typeof projectTeamCategories === "function") ? projectTeamCategories([...(typeof getMyRoster === "function" ? getMyRoster() : []), ...myNames].filter((v, i, a) => a.indexOf(v) === i)) : null;
    html += '<div class="card"><h3>Your draft</h3>';
    html += '<p class="small">' + mine.length + ' picks · spent <b>$' + spent + '</b> · surplus <b class="' + (surplus >= 0 ? 'good' : 'bad') + '">' + _dbSigned(surplus) + '</b> vs model</p>';
    if (cats) {
      const ranked = Object.entries(cats.ranks).sort((a, b) => a[1] - b[1]);
      html += '<p class="small muted">Projected strengths: ' + ranked.slice(0, 3).map(c => c[0]).join(", ") +
        ' · needs: ' + ranked.slice(-3).map(c => c[0]).join(", ") + '</p>';
    }
    html += '</div>';
  }

  // League surplus leaderboard
  html += '<div class="card"><h3>Value captured by team <span class="muted small">(model $ − price paid)</span></h3>';
  html += '<table style="font-size:12px;"><thead><tr><th>Team</th><th class="num">Picks</th><th class="num">Spent</th><th class="num">Surplus</th></tr></thead><tbody>';
  for (const t of teamRows) {
    html += '<tr' + (t.isMine ? ' style="background:rgba(79,142,247,.08);"' : '') + '><td>' + esc(t.label) + '</td><td class="num">' + t.n + '</td><td class="num">$' + t.spent + '</td>' +
      '<td class="num ' + (t.surplus >= 0 ? 'good' : 'bad') + '">' + _dbSigned(t.surplus) + '</td></tr>';
  }
  html += '</tbody></table></div>';

  // Biggest bargains / overpays leaguewide
  const withSurplus = rows.filter(r => r.surplus != null).slice();
  const bargains = withSurplus.slice().sort((a, b) => b.surplus - a.surplus).slice(0, 8);
  const overpays = withSurplus.slice().sort((a, b) => a.surplus - b.surplus).slice(0, 8);
  html += '<div class="grid cols-2">';
  html += '<div class="card"><h3>Best bargains</h3>' + _dbPickTable(bargains) + '</div>';
  html += '<div class="card"><h3>Biggest overpays</h3>' + _dbPickTable(overpays) + '</div>';
  html += '</div>';

  // Cold/hot rooms (retrospective, from the bid stream)
  const coldSales = rows.filter(r => r.read?.cold);
  const hotSales = rows.filter(r => r.read?.hot);
  if (coldSales.length || hotSales.length) {
    html += '<div class="card"><h3>Room reads <span class="muted small">(from the recorded bidding)</span></h3>';
    html += '<p class="small">🧊 <b>' + coldSales.length + '</b> cold sales (nobody chased — bargains) · 🔥 <b>' + hotSales.length + '</b> hot sales (bidding wars).</p>';
    if (coldSales.length) html += '<p class="small muted">Coldest: ' + coldSales.slice(0, 6).map(r => esc(r.p.player) + ' ($' + r.p.price + ')').join(", ") + '</p>';
    html += '</div>';
  } else if (typeof _dlog !== "undefined" && _dlog.events && _dlog.events.length) {
    html += '<div class="card"><h3>Room reads</h3><p class="muted small">Not enough bid detail in the stream to classify sales this time.</p></div>';
  }

  // Nomination patterns (first look)
  const noms = _dbNominationPatterns();
  if (noms) {
    html += '<div class="card"><h3>Nomination patterns <span class="muted small">(first look — telegraphed targets)</span></h3>';
    html += '<table style="font-size:12px;"><thead><tr><th>Team</th><th class="num">Nominated</th><th class="num">Won own noms</th></tr></thead><tbody>';
    for (const r of noms) {
      const label = (typeof draftTestMode === "function" && draftTestMode()) ? "Team " + r.teamId : ((typeof espnTeamIdToOwnerId === "function" && getTeam(espnTeamIdToOwnerId(r.teamId))?.owner) || "Team " + r.teamId);
      html += '<tr><td>' + esc(label) + '</td><td class="num">' + r.noms + '</td><td class="num">' + r.selfWins + '</td></tr>';
    }
    html += '</tbody></table><p class="muted small" style="margin-top:4px;">Teams that win the players they nominate are telegraphing targets — leverage for next year.</p></div>';
  }

  return html;
}

function _dbPickTable(rows) {
  if (!rows.length) return '<p class="muted small">—</p>';
  let html = '<table style="font-size:12px;"><thead><tr><th>Player</th><th>Team</th><th class="num">$</th><th class="num">Model</th><th class="num">+/−</th></tr></thead><tbody>';
  for (const r of rows) {
    html += '<tr><td>' + esc(r.p.player) + '</td><td class="small">' + esc(_dbTeamLabel(r.p)) + '</td><td class="num">$' + r.p.price + '</td>' +
      '<td class="num">' + (r.model != null ? '$' + r.model.toFixed(0) : '—') + '</td>' +
      '<td class="num ' + (r.surplus >= 0 ? 'good' : 'bad') + '">' + _dbSigned(r.surplus) + '</td></tr>';
  }
  html += '</tbody></table>';
  return html;
}

// Overlay open/close.
function openDebrief() {
  closeDebrief();
  const ov = document.createElement("div");
  ov.id = "debrief-overlay";
  ov.style.cssText = "position:fixed; inset:0; background:rgba(0,0,0,.6); z-index:9999; overflow:auto; padding:24px;";
  ov.innerHTML = '<div style="max-width:1100px; margin:0 auto; background:var(--bg-2); border:1px solid var(--border); border-radius:10px; padding:18px;">' +
    '<div style="display:flex; align-items:center; gap:12px; margin-bottom:12px;"><h2 style="margin:0;">Post-Draft Debrief</h2><span style="flex:1;"></span>' +
    '<button class="btn ghost" id="debrief-close">✕ Close</button></div>' +
    renderDebrief() + '</div>';
  document.body.appendChild(ov);
  document.getElementById("debrief-close")?.addEventListener("click", closeDebrief);
  ov.addEventListener("click", (e) => { if (e.target === ov) closeDebrief(); });
}
function closeDebrief() {
  document.getElementById("debrief-overlay")?.remove();
}
