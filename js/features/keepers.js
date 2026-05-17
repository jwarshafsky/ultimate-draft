// Keepers view — per-team breakdown of every kept player with surplus,
// trajectory, and tier-keeper-cap flags. Read-only (selections happen in The
// League App). This is the "is this a good keeper?" analysis layer.

function renderKeepers() {
  const root = document.getElementById("view-root");
  const meta = getProjectionMeta();
  const hasProj = meta.hitterCount > 0 || meta.pitcherCount > 0;
  const selections = getKeeperSelections();

  // Header w/ filters
  let html = '<div class="card"><h2>Keepers by Team</h2>';
  if (!hasProj) {
    html += '<p class="muted small">Import projections (Data tab) to see surplus values.</p>';
  } else {
    html += '<p class="muted small">Surplus = projected value − keeper cost. Lifetime sums surplus across eligible keeper years.</p>';
  }
  html += '</div>';

  const me = LEAGUE.teams.find(t => t.isMe);
  const others = LEAGUE.teams.filter(t => !t.isMe).slice().sort((a, b) => a.owner.localeCompare(b.owner));
  const order = me ? [me, ...others] : others;

  for (const t of order) {
    const teamSel = selections[t.id] || {};
    const players = Object.entries(teamSel)
      .filter(([_, f]) => f.keeper || f.minorKeeper)
      .map(([name, f]) => ({ name, ...f }));
    if (!players.length) continue;

    html += '<div class="card"' + (t.isMe ? ' style="border-color: rgba(79,142,247,.4);"' : '') + '>';
    html += '<h2>' + esc(t.name) + ' <span class="muted small">· ' + esc(t.owner) + '</span></h2>';
    html += '<table><thead><tr>';
    html += '<th>Player</th><th>Type</th><th>Pos</th><th class="num">Cost</th><th class="num">Value</th><th class="num">Yr1 Surplus</th><th class="num">Lifetime</th><th>Flags</th>';
    html += '</tr></thead><tbody>';

    let totalCost = 0, totalValue = 0, totalSurplus = 0;
    for (const p of players) {
      const isMinor = !!p.minorKeeper;
      const rawCost = isMinor ? 0 : getCurrentKeeperSalary(p.name);
      const cost = rawCost ?? 0;
      const isEstimated = !isMinor && isKeeperSalaryEstimated(p.name);
      const isMissing = !isMinor && rawCost == null;
      const val = getPlayerValue(p.name);
      const projValue = val ? val.value : null;
      const surplus = projValue != null ? projValue - cost : null;
      const traj = (projValue != null) ? surplusTrajectory({
        playerValue: projValue, salary: cost, originalDraftPrice: cost,
      }) : [];
      const lifetime = traj.filter(y => y.keeperEligible && y.surplus > 0).reduce((s, y) => s + y.surplus, 0);

      totalCost += cost;
      totalValue += projValue || 0;
      totalSurplus += surplus || 0;

      const flags = [];
      if (cost >= 51) flags.push('<span class="kbd" title="Max 1 keeper year remaining">1yr</span>');
      else if (cost >= 41) flags.push('<span class="kbd" title="Max 2 keeper years remaining">2yr</span>');
      if (isMinor) flags.push('<span class="kbd" style="color: var(--minor);">MiL</span>');
      if (p.rule5) flags.push('<span class="kbd" style="color: var(--warn);">R5</span>');
      if (p.tradeBlock) flags.push('<span class="kbd" style="color: var(--accent);">TB</span>');
      if (surplus != null && surplus < 0 && !isMinor) flags.push('<span class="kbd" style="color: var(--bad);">UNDERWATER</span>');
      if (isEstimated) flags.push('<span class="kbd" style="color: var(--warn);" title="Salary estimated from prior years + $2/yr escalator">EST $</span>');
      if (isMissing) flags.push('<span class="kbd" style="color: var(--bad);" title="No prior draft data for this player — add a manual salary in The League App">NO $</span>');

      html += '<tr class="' + (isMinor ? 'minor-kept' : 'kept') + '">';
      html += '<td>' + esc(p.name) + '</td>';
      html += '<td>' + (isMinor ? '<span class="minor">Minor</span>' : '<span class="keeper">Major</span>') + '</td>';
      html += '<td>' + (val ? esc(val.pos) : '<span class="dim">—</span>') + '</td>';
      html += '<td class="num">' + (isMinor ? '<span class="dim">$0</span>' : '$' + cost) + '</td>';
      html += '<td class="num">' + (projValue != null ? '$' + projValue.toFixed(0) : '<span class="dim">—</span>') + '</td>';
      html += '<td class="num ' + (surplus != null ? (surplus > 0 ? 'good' : surplus < 0 ? 'bad' : '') : '') + '">' +
        (surplus != null ? (surplus > 0 ? '+' : '') + '$' + surplus.toFixed(0) : '<span class="dim">—</span>') + '</td>';
      html += '<td class="num ' + (lifetime > 0 ? 'good' : '') + '">' + (projValue != null ? '+$' + lifetime.toFixed(0) : '<span class="dim">—</span>') + '</td>';
      html += '<td>' + flags.join(' ') + '</td>';
      html += '</tr>';
    }
    html += '<tr style="font-weight: 600; border-top: 2px solid var(--border);">';
    html += '<td colspan="3">Total (' + players.length + ' kept)</td>';
    html += '<td class="num">$' + totalCost + '</td>';
    html += '<td class="num">$' + totalValue.toFixed(0) + '</td>';
    html += '<td class="num ' + (totalSurplus > 0 ? 'good' : totalSurplus < 0 ? 'bad' : '') + '">' + (totalSurplus > 0 ? '+' : '') + '$' + totalSurplus.toFixed(0) + '</td>';
    html += '<td></td><td></td></tr>';
    html += '</tbody></table></div>';
  }

  if (!Object.keys(selections).length) {
    html += '<div class="empty"><p>No keepers selected yet.</p><p class="small">Mark keepers in The League App and they\'ll show here automatically.</p></div>';
  }

  root.innerHTML = html;
}
