// Trade analyzer — drop players (or draft dollars / picks) on each side; see
// year-by-year surplus delta, category fit, position context, and a clear
// "winner" verdict with reasoning.

const _tradeState = {
  team1: null,
  team2: null,
  team1Gives: [], // [{ name }] — players only for now
  team2Gives: [],
  team1FaabGives: 0,
  team2FaabGives: 0,
  team1DollarGives: 0,
  team2DollarGives: 0,
};

function renderTrade() {
  const root = document.getElementById("view-root");
  if (!getValues().length) {
    root.innerHTML = '<div class="empty"><p>Trade analyzer requires projections.</p><p class="small">Import a FanGraphs CSV first.</p></div>';
    return;
  }

  if (!_tradeState.team1) _tradeState.team1 = (getMyTeam() || LEAGUE.teams[0]).id;
  if (!_tradeState.team2 || _tradeState.team2 === _tradeState.team1) {
    _tradeState.team2 = LEAGUE.teams.find(t => t.id !== _tradeState.team1).id;
  }

  let html = '<div class="card"><h2>Trade Analyzer</h2>';
  html += '<p class="muted small">Multi-year surplus + category impact + position context. Add players to each side or include FAAB / draft dollars.</p></div>';

  html += '<div class="grid cols-2">';
  html += renderTradeSide("team1");
  html += renderTradeSide("team2");
  html += '</div>';

  html += renderTradeVerdict();

  root.innerHTML = html;

  // Wire UI
  document.querySelectorAll(".trade-team-select").forEach(s => {
    s.addEventListener("change", (e) => {
      _tradeState[e.target.dataset.side] = e.target.value;
      _tradeState[e.target.dataset.side === "team1" ? "team1Gives" : "team2Gives"] = [];
      renderTrade();
    });
  });
  document.querySelectorAll(".trade-add").forEach(b => {
    b.addEventListener("click", () => addTradeAsset(b.dataset.side));
  });
  document.querySelectorAll(".trade-remove").forEach(b => {
    b.addEventListener("click", () => {
      const list = b.dataset.side === "team1" ? "team1Gives" : "team2Gives";
      _tradeState[list].splice(parseInt(b.dataset.idx, 10), 1);
      renderTrade();
    });
  });
  document.querySelectorAll(".trade-faab").forEach(i => {
    i.addEventListener("change", (e) => {
      const key = e.target.dataset.side === "team1" ? "team1FaabGives" : "team2FaabGives";
      _tradeState[key] = parseFloat(e.target.value) || 0;
      renderTrade();
    });
  });
  document.querySelectorAll(".trade-dollars").forEach(i => {
    i.addEventListener("change", (e) => {
      const key = e.target.dataset.side === "team1" ? "team1DollarGives" : "team2DollarGives";
      _tradeState[key] = parseFloat(e.target.value) || 0;
      renderTrade();
    });
  });
}

function renderTradeSide(side) {
  const teamId = _tradeState[side];
  const team = getTeam(teamId);
  const gives = _tradeState[side === "team1" ? "team1Gives" : "team2Gives"];
  const faab = _tradeState[side === "team1" ? "team1FaabGives" : "team2FaabGives"];
  const dollars = _tradeState[side === "team1" ? "team1DollarGives" : "team2DollarGives"];

  let html = '<div class="card">';
  html += '<h3>' + (side === "team1" ? "Team A gives" : "Team B gives") + '</h3>';
  html += '<select class="trade-team-select" data-side="' + side + '" style="width: 100%; margin-bottom: 10px;">';
  for (const t of LEAGUE.teams) {
    html += '<option value="' + t.id + '"' + (t.id === teamId ? ' selected' : '') + '>' + esc(t.owner) + '</option>';
  }
  html += '</select>';

  // Players table
  html += '<table style="margin-bottom: 12px;"><thead><tr><th>Player</th><th class="num">Salary</th><th class="num">Value</th><th class="num">Yr1 Surp</th><th class="num">Lifetime</th><th></th></tr></thead><tbody>';
  let totalSal = 0, totalVal = 0, totalLifetime = 0;
  for (let i = 0; i < gives.length; i++) {
    const g = gives[i];
    const val = getPlayerValue(g.name);
    const sal = getCurrentKeeperSalary(g.name) ?? 0;
    const v = val ? val.value : 0;
    const lt = val ? lifetimeSurplus({ playerValue: v, salary: sal, originalDraftPrice: sal }) : 0;
    totalSal += sal; totalVal += v; totalLifetime += lt;
    html += '<tr>';
    html += '<td>' + esc(g.name) + (!val ? ' <span class="kbd bad" style="color: var(--bad);">?</span>' : '') + '</td>';
    html += '<td class="num">$' + sal + '</td>';
    html += '<td class="num">' + (val ? '$' + v.toFixed(0) : '<span class="dim">—</span>') + '</td>';
    html += '<td class="num ' + (v - sal > 0 ? 'good' : 'bad') + '">' + (v - sal > 0 ? '+' : '') + '$' + (v - sal).toFixed(0) + '</td>';
    html += '<td class="num ' + (lt > 0 ? 'good' : '') + '">+$' + lt.toFixed(0) + '</td>';
    html += '<td><button class="btn ghost trade-remove" data-side="' + side + '" data-idx="' + i + '" style="padding: 2px 8px; font-size: 11px;">×</button></td>';
    html += '</tr>';
  }
  if (gives.length) {
    html += '<tr style="font-weight: 600; border-top: 2px solid var(--border);">';
    html += '<td>Total</td><td class="num">$' + totalSal + '</td><td class="num">$' + totalVal.toFixed(0) + '</td>';
    html += '<td class="num ' + (totalVal - totalSal > 0 ? 'good' : 'bad') + '">' + (totalVal - totalSal > 0 ? '+' : '') + '$' + (totalVal - totalSal).toFixed(0) + '</td>';
    html += '<td class="num good">+$' + totalLifetime.toFixed(0) + '</td><td></td></tr>';
  }
  html += '</tbody></table>';

  html += '<div style="margin-bottom: 10px;"><button class="btn trade-add" data-side="' + side + '">+ Add player</button></div>';

  // Non-player assets
  html += '<div class="grid cols-2" style="gap: 8px;">';
  html += '<div><label class="muted small">FAAB $</label><input type="number" class="trade-faab" data-side="' + side + '" value="' + faab + '" style="width: 100%;"></div>';
  html += '<div><label class="muted small">Draft $</label><input type="number" class="trade-dollars" data-side="' + side + '" value="' + dollars + '" style="width: 100%;"></div>';
  html += '</div>';

  html += '</div>';
  return html;
}

function addTradeAsset(side) {
  const teamId = _tradeState[side];
  const sel = getKeeperSelections()[teamId] || {};
  const owned = Object.entries(sel)
    .filter(([_, f]) => f.keeper || f.minorKeeper)
    .map(([n]) => n);
  const hint = owned.length
    ? "Owned keepers: " + owned.slice(0, 10).join(", ") + (owned.length > 10 ? "…" : "")
    : "(no keepers marked for this team — enter any player name)";
  const name = prompt("Player name:\n" + hint);
  if (!name) return;
  const list = side === "team1" ? "team1Gives" : "team2Gives";
  _tradeState[list].push({ name: name.trim() });
  renderTrade();
}

// Computes category impact for a list of players given the projections —
// returns total contribution to each of the 10 categories.
function categoryImpact(players) {
  const out = {
    R: 0, HR: 0, RBI: 0, SB: 0, OBP_pa: 0, OBP_h_bb: 0,
    QS: 0, K: 0, SV_HLD: 0, IP: 0, ER: 0, BB_H: 0,
  };
  for (const p of players) {
    const proj = getProjection(p.name);
    if (!proj) continue;
    if (proj.type === "H") {
      out.R += proj.R || 0;
      out.HR += proj.HR || 0;
      out.RBI += proj.RBI || 0;
      out.SB += proj.SB || 0;
      out.OBP_pa += proj.PA || 0;
      out.OBP_h_bb += ((proj.OBP || 0) * (proj.PA || 0));
    } else {
      out.QS += proj.QS || 0;
      out.K += proj.K || 0;
      out.SV_HLD += (proj.SV || 0) + (proj.HLD || 0);
      out.IP += proj.IP || 0;
      out.ER += ((proj.ERA || 0) * (proj.IP || 0)) / 9;
      out.BB_H += ((proj.WHIP || 0) * (proj.IP || 0));
    }
  }
  return out;
}

// Format a category delta as "+15 R" etc. Returns array of small strings.
function categoryDeltaSummary(receiveSide, giveSide) {
  const r = categoryImpact(receiveSide);
  const g = categoryImpact(giveSide);
  const parts = [];
  // Counting cats: net add
  for (const k of ["R", "HR", "RBI", "SB", "QS", "K", "SV_HLD"]) {
    const delta = r[k] - g[k];
    if (Math.abs(delta) >= 1) {
      parts.push((delta > 0 ? "+" : "") + delta.toFixed(0) + " " + k.replace("_HLD", "+H"));
    }
  }
  // OBP — weighted impact
  const rOBP = r.OBP_pa > 0 ? r.OBP_h_bb / r.OBP_pa : 0;
  const gOBP = g.OBP_pa > 0 ? g.OBP_h_bb / g.OBP_pa : 0;
  if (r.OBP_pa + g.OBP_pa > 100) {
    const obpNet = rOBP - gOBP;
    if (Math.abs(obpNet) > 0.005) parts.push((obpNet > 0 ? "+" : "") + obpNet.toFixed(3) + " OBP");
  }
  // ERA/WHIP: lower is better, so net = give - receive (you'd want to give worse pitchers)
  const rERA = r.IP > 0 ? (r.ER * 9) / r.IP : 0;
  const gERA = g.IP > 0 ? (g.ER * 9) / g.IP : 0;
  if (r.IP + g.IP > 30) {
    const eraDelta = rERA - gERA;
    if (Math.abs(eraDelta) > 0.05) parts.push((eraDelta < 0 ? "improves" : "worsens") + " ERA " + eraDelta.toFixed(2));
  }
  return parts;
}

// Multi-year aggregate surplus over a list of players.
function multiYearSurplus(players, years) {
  let total = 0;
  for (const p of players) {
    const val = getPlayerValue(p.name);
    if (!val) continue;
    const sal = getCurrentKeeperSalary(p.name) ?? 0;
    const traj = surplusTrajectory({ playerValue: val.value, salary: sal, originalDraftPrice: sal, yearsAhead: years });
    for (const y of traj) {
      if (y.keeperEligible && y.surplus > 0) total += y.surplus;
    }
  }
  return total;
}

function renderTradeVerdict() {
  const a = _tradeState.team1Gives;
  const b = _tradeState.team2Gives;
  if (!a.length && !b.length && !_tradeState.team1FaabGives && !_tradeState.team2FaabGives && !_tradeState.team1DollarGives && !_tradeState.team2DollarGives) {
    return '<div class="card"><h3>Verdict</h3><p class="muted small">Add assets to both sides to see the analysis.</p></div>';
  }

  const yr1 = (list) => list.reduce((s, g) => {
    const val = getPlayerValue(g.name);
    const v = val ? val.value : 0;
    const sal = getCurrentKeeperSalary(g.name) ?? 0;
    return s + (v - sal);
  }, 0);
  const aYr1 = yr1(a);
  const bYr1 = yr1(b);
  const aLife = multiYearSurplus(a, 3);
  const bLife = multiYearSurplus(b, 3);

  // FAAB and draft dollars valuation: rough — $1 of draft dollars ≈ $1 in
  // current year, FAAB ≈ $0.5 in current year (since FAAB is a budget for
  // free agents, not actual roster $). These can be refined.
  const aExtras = (_tradeState.team1DollarGives) + (_tradeState.team1FaabGives * 0.5);
  const bExtras = (_tradeState.team2DollarGives) + (_tradeState.team2FaabGives * 0.5);

  // Net to each side: what you receive minus what you give
  const teamADelta = (bYr1 + bExtras) - (aYr1 + aExtras);
  const teamBDelta = -teamADelta;
  const teamALife = bLife - aLife;
  const teamBLife = -teamALife;

  // Category deltas
  const teamACatDelta = categoryDeltaSummary(b, a);
  const teamBCatDelta = categoryDeltaSummary(a, b);

  let html = '<div class="card"><h3>Verdict</h3>';
  html += '<div class="grid cols-2">';

  for (const [label, ownerId, yr1Delta, lifeDelta, catDelta] of [
    ["Team A", _tradeState.team1, teamADelta, teamALife, teamACatDelta],
    ["Team B", _tradeState.team2, teamBDelta, teamBLife, teamBCatDelta],
  ]) {
    const owner = getTeam(ownerId);
    html += '<div style="padding: 8px;">';
    html += '<div class="muted small">' + esc(owner.owner) + '</div>';
    html += '<div style="font-size: 22px; font-family: var(--mono); margin: 4px 0;" class="' + (yr1Delta > 0 ? "good" : yr1Delta < 0 ? "bad" : "") + '">';
    html += (yr1Delta > 0 ? "+" : "") + "$" + yr1Delta.toFixed(0) + ' <span class="muted small" style="font-size: 12px;">Yr1 surplus</span></div>';
    html += '<div style="font-family: var(--mono); font-size: 14px;" class="' + (lifeDelta > 0 ? "good" : lifeDelta < 0 ? "bad" : "") + '">';
    html += (lifeDelta > 0 ? "+" : "") + "$" + lifeDelta.toFixed(0) + ' <span class="muted small" style="font-size: 12px;">3-yr lifetime</span></div>';
    if (catDelta.length) {
      html += '<div style="margin-top: 8px;">';
      for (const c of catDelta) {
        html += '<span class="kbd" style="margin-right: 4px; font-size: 11px;">' + esc(c) + '</span>';
      }
      html += '</div>';
    }
    html += '</div>';
  }
  html += '</div>';

  // Overall judgement
  const lean = Math.abs(teamADelta);
  let verdict = "Roughly even";
  let verdictClass = "muted";
  if (lean >= 15) { verdict = teamADelta > 0 ? "Strongly favors Team A" : "Strongly favors Team B"; verdictClass = teamADelta > 0 ? "good" : "bad"; }
  else if (lean >= 6) { verdict = teamADelta > 0 ? "Leans toward Team A" : "Leans toward Team B"; verdictClass = teamADelta > 0 ? "good" : "bad"; }
  html += '<div style="border-top: 1px solid var(--border); padding-top: 10px; margin-top: 10px;">';
  html += '<span class="' + verdictClass + '" style="font-weight: 600;">' + esc(verdict) + '</span>';
  html += ' <span class="muted small">based on Year-1 surplus delta of $' + Math.abs(teamADelta).toFixed(0) + '.</span>';
  html += '</div>';
  html += '<p class="muted small" style="margin-top: 8px;">Lifetime surplus assumes max keeper eligibility (price-cliff rules applied). FAAB valued at $0.50 / dollar. Position scarcity and roster need adjustments to come.</p>';

  html += '</div>';
  return html;
}
