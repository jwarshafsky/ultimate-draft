// Spending pace tracker for YOUR team. Shows whether you're ahead, on, or
// behind pace, broken out by hitter vs pitcher spending and by tier exposure.

function renderSpendingPace() {
  const me = getMyTeam();
  if (!me) return '';
  const myPicks = _liveDraft.picks.filter(p => p.team === me.id);
  const keeperSel = getKeeperSelections()[me.id] || {};
  const kept = Object.entries(keeperSel).filter(([_, f]) => f.keeper).map(([n]) => n);
  const keptCost = kept.reduce((s, n) => s + (getKeeperPriceExceptions()[n] || 0), 0);
  const draftedSpent = myPicks.reduce((s, p) => s + p.price, 0);
  const totalSpent = keptCost + draftedSpent;
  const totalSlots = kept.length + myPicks.length;
  const remainingSlots = LEAGUE.rosterSize - totalSlots;
  const remainingBudget = LEAGUE.draftBudget - totalSpent;
  const dollarsPerSlot = remainingSlots > 0 ? remainingBudget / remainingSlots : 0;

  // Hitter vs pitcher spend
  const hitNames = new Set([...kept, ...myPicks.map(p => p.player)]);
  let hitSpent = 0, pitSpent = 0;
  for (const name of kept) {
    const v = getPlayerValue(name);
    const sal = getKeeperPriceExceptions()[name] || 0;
    if (v?.type === "P") pitSpent += sal; else hitSpent += sal;
  }
  for (const p of myPicks) {
    const v = getPlayerValue(p.player);
    if (v?.type === "P") pitSpent += p.price; else hitSpent += p.price;
  }
  const hitPct = totalSpent > 0 ? hitSpent / totalSpent : 0;
  // Target: 70/30 hit/pit per FG settings
  const targetHitPct = VALUATION.hitBudgetPct;
  const hitPctDelta = hitPct - targetHitPct;

  // Pace: spent vs expected
  // Expected pace = (slots filled / total slots) of (budget - $1 per remaining slot)
  const fillablePct = totalSlots / LEAGUE.rosterSize;
  const usableBudget = LEAGUE.draftBudget - 1 * (LEAGUE.rosterSize); // $1 per slot minimum
  const expectedSpent = usableBudget * fillablePct + totalSlots; // add back $1 per filled slot
  const paceDelta = totalSpent - expectedSpent;
  const paceLabel = Math.abs(paceDelta) < 5 ? "ON PACE" : paceDelta > 0 ? "AHEAD OF PACE (spending fast)" : "BEHIND PACE (saving up)";
  const paceClass = Math.abs(paceDelta) < 5 ? "muted" : paceDelta > 0 ? "warn" : "good";

  let html = '<div class="card"><h3>Your Spending Pace</h3>';
  html += '<div class="pace-strip">';
  html += '<div><div class="muted small">Spent</div><div class="pace-val">$' + totalSpent + '</div><div class="muted small">of $' + LEAGUE.draftBudget + '</div></div>';
  html += '<div><div class="muted small">Remaining</div><div class="pace-val">$' + remainingBudget + '</div><div class="muted small">' + remainingSlots + ' slots open</div></div>';
  html += '<div><div class="muted small">$ / slot left</div><div class="pace-val">$' + dollarsPerSlot.toFixed(1) + '</div></div>';
  html += '<div><div class="muted small">Pace</div><div class="pace-val ' + paceClass + '" style="font-size: 13px;">' + paceLabel + '</div><div class="muted small">' + (paceDelta > 0 ? "+" : "") + '$' + paceDelta.toFixed(0) + '</div></div>';
  html += '</div>';

  // H/P split bar
  html += '<div style="margin-top: 12px;">';
  html += '<div class="muted small" style="display: flex; justify-content: space-between;"><span>Hit/Pit Split (target ' + (targetHitPct * 100).toFixed(0) + '/' + ((1 - targetHitPct) * 100).toFixed(0) + ')</span><span class="' + (Math.abs(hitPctDelta) > 0.1 ? "warn" : "muted") + '">' + (hitPct * 100).toFixed(0) + '/' + ((1 - hitPct) * 100).toFixed(0) + '</span></div>';
  html += '<div class="pace-bar"><div class="pace-bar-hit" style="width:' + (hitPct * 100) + '%;"></div></div>';
  html += '</div>';

  html += '</div>';
  return html;
}
