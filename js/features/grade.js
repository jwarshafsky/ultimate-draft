// Draft grade card. Computes a letter grade based on:
//   - Total surplus captured (sum of value − price across drafted players)
//   - Projected roto points
//   - Roster completeness (all positions filled)
//   - Category balance (no severe weaknesses)
//   - Hit/pit split adherence (vs target)
//
// Surfaces:
//   - Letter grade A+/A/A-/B+/B/B-/C/D/F
//   - Total surplus + per-pick surplus table
//   - Identified buy-low chips (high yr1 surplus but declining trajectory =
//     better as trade chips than keepers)
//   - Weak categories worth addressing in-season

function computeDraftGrade() {
  const me = getMyTeam();
  if (!me) return null;
  const picks = (_liveDraft.picks || []).filter(p => p.team === me.id);
  const keeperSel = getKeeperSelections()[me.id] || {};
  const kept = Object.entries(keeperSel).filter(([_, f]) => f.keeper).map(([n]) => n);
  const keptCost = kept.reduce((s, n) => s + (getKeeperPriceExceptions()[n] || 0), 0);
  const draftedSpent = picks.reduce((s, p) => s + p.price, 0);
  const roster = [...kept, ...picks.map(p => p.player)];

  // Surplus components
  const draftedSurplus = picks.reduce((s, p) => {
    const v = getPlayerValue(p.player);
    return s + ((v?.value || 0) - p.price);
  }, 0);
  const keeperSurplus = kept.reduce((s, n) => {
    const v = getPlayerValue(n);
    const sal = getKeeperPriceExceptions()[n] || 0;
    return s + ((v?.value || 0) - sal);
  }, 0);
  const totalSurplus = draftedSurplus + keeperSurplus;

  // Category projections + roto points
  const cats = projectTeamCategories(roster);

  // Roster completeness — count slot fill rate using greedy optimizer
  const assignments = (typeof optimizeRoster === "function") ? optimizeRoster(roster) : [];
  const filledStarters = assignments.filter(s => s.player && !s.key.startsWith("BN")).length;
  const totalStarters = assignments.filter(s => !s.key.startsWith("BN")).length;
  const completeness = totalStarters > 0 ? filledStarters / totalStarters : 0;

  // Category balance — count weak (rank >= 9) and strong (rank <= 4) cats
  const allCats = ["R","HR","RBI","SB","OBP","QS","K","SV_HLD","ERA","WHIP"];
  const weakCats = allCats.filter(c => cats.ranks[c] >= 9);
  const strongCats = allCats.filter(c => cats.ranks[c] <= 4);

  // H/P split adherence
  let hSpent = 0, pSpent = 0;
  for (const name of kept) {
    const v = getPlayerValue(name);
    const sal = getKeeperPriceExceptions()[name] || 0;
    if (v?.type === "P") pSpent += sal; else hSpent += sal;
  }
  for (const pk of picks) {
    const v = getPlayerValue(pk.player);
    if (v?.type === "P") pSpent += pk.price; else hSpent += pk.price;
  }
  const totalSpent = hSpent + pSpent;
  const hPct = totalSpent > 0 ? hSpent / totalSpent : VALUATION.hitBudgetPct;
  const hPctDelta = Math.abs(hPct - VALUATION.hitBudgetPct);

  // Scoring (0-100)
  // 35 pts: surplus (cap at +60 = full marks, -10 = 0)
  const surplusScore = Math.max(0, Math.min(35, ((totalSurplus + 10) / 70) * 35));
  // 30 pts: roto points (95+ = full, 60 = 0)
  const rotoScore = Math.max(0, Math.min(30, ((cats.rotoPoints - 60) / 35) * 30));
  // 15 pts: completeness (1.0 = full)
  const completenessScore = completeness * 15;
  // 10 pts: category balance (no weak cats = full, 4+ weak = 0)
  const balanceScore = Math.max(0, 10 - weakCats.length * 2.5);
  // 10 pts: H/P adherence (<5% delta = full, 20% delta = 0)
  const hpScore = Math.max(0, 10 - (hPctDelta * 100 - 5) * 0.67);

  const score = Math.round(surplusScore + rotoScore + completenessScore + balanceScore + hpScore);

  let letter;
  if (score >= 93) letter = "A+";
  else if (score >= 88) letter = "A";
  else if (score >= 83) letter = "A-";
  else if (score >= 78) letter = "B+";
  else if (score >= 73) letter = "B";
  else if (score >= 68) letter = "B-";
  else if (score >= 60) letter = "C";
  else if (score >= 50) letter = "D";
  else letter = "F";

  // Buy-low / trade chip identification: high yr1 surplus, declining yr2-3.
  const chips = [];
  for (const pk of picks) {
    const v = getPlayerValue(pk.player);
    if (!v) continue;
    const yr1Surplus = v.value - pk.price;
    if (yr1Surplus >= 6) {
      const traj = surplusTrajectory({ playerValue: v.value, salary: pk.price, originalDraftPrice: pk.price });
      const yr2Surplus = traj[1]?.surplus || 0;
      // If yr2 surplus is significantly less, they're a better trade chip.
      if (yr2Surplus < yr1Surplus * 0.6) {
        chips.push({ name: pk.player, yr1: yr1Surplus, yr2: yr2Surplus, type: "trade" });
      }
    }
  }

  return {
    letter, score,
    breakdown: {
      surplus: surplusScore.toFixed(1),
      roto: rotoScore.toFixed(1),
      completeness: completenessScore.toFixed(1),
      balance: balanceScore.toFixed(1),
      hp: hpScore.toFixed(1),
    },
    totalSurplus, draftedSurplus, keeperSurplus,
    rotoPoints: cats.rotoPoints,
    weakCats, strongCats,
    hPct, hPctDelta,
    completeness,
    pickCount: picks.length,
    keeperCount: kept.length,
    totalSpent,
    chips,
    cats,
  };
}

function renderDraftGrade() {
  const me = getMyTeam();
  if (!me) return "";
  const g = computeDraftGrade();
  if (!g || (g.pickCount === 0 && g.keeperCount === 0)) {
    return '<div class="card"><h2>Draft Grade</h2><p class="muted small">Grade computes once you have picks recorded or keepers marked.</p></div>';
  }

  // Color by letter
  const gradeColor =
    g.letter.startsWith("A") ? "var(--good)" :
    g.letter.startsWith("B") ? "var(--keeper)" :
    g.letter.startsWith("C") ? "var(--warn)" :
    "var(--bad)";

  let html = '<div class="card" style="border-color: rgba(79,142,247,.4);">';
  html += '<h2>Draft Grade</h2>';
  html += '<div class="grade-grid">';
  html += '<div class="grade-letter" style="color: ' + gradeColor + ';">' + g.letter + '<div class="grade-score">' + g.score + ' / 100</div></div>';
  html += '<div class="grade-summary">';
  html += '<div class="stat-row"><span class="label">Total surplus</span><span class="value ' + (g.totalSurplus > 0 ? "good" : "bad") + '">' + (g.totalSurplus > 0 ? "+" : "") + '$' + g.totalSurplus.toFixed(0) + '</span></div>';
  html += '<div class="stat-row"><span class="label">Drafted surplus</span><span class="value">' + (g.draftedSurplus > 0 ? "+" : "") + '$' + g.draftedSurplus.toFixed(0) + ' <span class="muted small">(' + g.pickCount + ' picks)</span></span></div>';
  html += '<div class="stat-row"><span class="label">Keeper surplus</span><span class="value">' + (g.keeperSurplus > 0 ? "+" : "") + '$' + g.keeperSurplus.toFixed(0) + ' <span class="muted small">(' + g.keeperCount + ' kept)</span></span></div>';
  html += '<div class="stat-row"><span class="label">Projected roto pts</span><span class="value">' + g.rotoPoints.toFixed(1) + ' / 120</span></div>';
  html += '<div class="stat-row"><span class="label">Roster completeness</span><span class="value">' + (g.completeness * 100).toFixed(0) + '%</span></div>';
  html += '<div class="stat-row"><span class="label">H/P split</span><span class="value">' + (g.hPct * 100).toFixed(0) + '/' + ((1 - g.hPct) * 100).toFixed(0) + ' <span class="muted small">target ' + (VALUATION.hitBudgetPct * 100).toFixed(0) + '/' + ((1 - VALUATION.hitBudgetPct) * 100).toFixed(0) + '</span></span></div>';
  html += '</div>';
  html += '<div class="grade-breakdown">';
  html += '<div class="muted small">Score breakdown</div>';
  for (const [label, points, max] of [
    ["Surplus", g.breakdown.surplus, 35],
    ["Roto pts", g.breakdown.roto, 30],
    ["Completeness", g.breakdown.completeness, 15],
    ["Cat balance", g.breakdown.balance, 10],
    ["H/P split", g.breakdown.hp, 10],
  ]) {
    const pct = (parseFloat(points) / max) * 100;
    html += '<div class="breakdown-row">';
    html += '<span style="font-size: 11px;">' + label + '</span>';
    html += '<div class="breakdown-bar"><div class="breakdown-bar-fill" style="width: ' + pct + '%;"></div></div>';
    html += '<span style="font-size: 11px; font-family: var(--mono);">' + points + '/' + max + '</span>';
    html += '</div>';
  }
  html += '</div>';
  html += '</div>';

  // Strong / weak categories
  if (g.strongCats.length || g.weakCats.length) {
    html += '<div style="margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--border);">';
    if (g.strongCats.length) html += '<div class="small good">Strong (top 4): ' + g.strongCats.join(", ") + '</div>';
    if (g.weakCats.length) html += '<div class="small bad">Address in-season: ' + g.weakCats.join(", ") + '</div>';
    html += '</div>';
  }

  // Buy-low / trade chips
  if (g.chips.length) {
    html += '<div style="margin-top: 12px;">';
    html += '<h3>Trade chip candidates</h3>';
    html += '<p class="muted small">High Year 1 surplus but declining trajectory — better to trade mid-season than keep long-term.</p>';
    html += '<table style="font-size: 12px;"><thead><tr><th>Player</th><th class="num">Yr1 Surplus</th><th class="num">Yr2 Surplus</th></tr></thead><tbody>';
    for (const c of g.chips) {
      html += '<tr><td>' + esc(c.name) + '</td><td class="num good">+$' + c.yr1.toFixed(0) + '</td><td class="num">+$' + c.yr2.toFixed(0) + '</td></tr>';
    }
    html += '</tbody></table>';
    html += '</div>';
  }

  html += '</div>';
  return html;
}
