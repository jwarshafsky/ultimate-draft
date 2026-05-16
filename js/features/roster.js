// Roster optimizer. Given your drafted + kept players, assign each to the
// best lineup slot using greedy slot-filling. Position counts per FG:
//   1 C, 1 1B, 1 2B, 1 3B, 1 SS, 5 OF, 1 MI, 1 CI, 1 UTIL, 6 SP, 4 RP, 4 BN
//
// Algorithm: sort players by projected value desc, then for each player,
// place them in the most scarce/specific eligible slot first (C > SS > 2B/3B
// > 1B > OF > MI > CI > UTIL > SP > RP > Bench). Handles two-way players by
// allowing assignment to either H or P slots.

const ROSTER_SLOTS = [
  { key: "C",     accepts: (pos) => pos === "C" },
  { key: "SS",    accepts: (pos) => pos === "SS" },
  { key: "2B",    accepts: (pos) => pos === "2B" },
  { key: "3B",    accepts: (pos) => pos === "3B" },
  { key: "1B",    accepts: (pos) => pos === "1B" },
  { key: "OF1",   accepts: (pos) => pos === "OF" },
  { key: "OF2",   accepts: (pos) => pos === "OF" },
  { key: "OF3",   accepts: (pos) => pos === "OF" },
  { key: "OF4",   accepts: (pos) => pos === "OF" },
  { key: "OF5",   accepts: (pos) => pos === "OF" },
  { key: "MI",    accepts: (pos) => pos === "2B" || pos === "SS" },
  { key: "CI",    accepts: (pos) => pos === "1B" || pos === "3B" },
  { key: "UTIL",  accepts: (pos) => ["C","1B","2B","3B","SS","OF","UTIL","DH"].includes(pos) },
  { key: "SP1",   accepts: (pos) => pos === "SP" },
  { key: "SP2",   accepts: (pos) => pos === "SP" },
  { key: "SP3",   accepts: (pos) => pos === "SP" },
  { key: "SP4",   accepts: (pos) => pos === "SP" },
  { key: "SP5",   accepts: (pos) => pos === "SP" },
  { key: "SP6",   accepts: (pos) => pos === "SP" },
  { key: "RP1",   accepts: (pos) => pos === "RP" },
  { key: "RP2",   accepts: (pos) => pos === "RP" },
  { key: "RP3",   accepts: (pos) => pos === "RP" },
  { key: "RP4",   accepts: (pos) => pos === "RP" },
  { key: "BN1",   accepts: () => true },
  { key: "BN2",   accepts: () => true },
  { key: "BN3",   accepts: () => true },
  { key: "BN4",   accepts: () => true },
];

function optimizeRoster(playerNames) {
  // Build player objects with position
  const players = playerNames.map(n => {
    const v = getPlayerValue(n);
    return {
      name: n,
      value: v?.value || 0,
      pos: v?.posKey || "UTIL",
      type: v?.type || "H",
      isTwoWay: !!v?.isTwoWay,
      posSecondary: v?.posSecondary || null,
    };
  });
  // Sort by value desc
  players.sort((a, b) => b.value - a.value);

  // Initialize empty slot map
  const slotAssignments = ROSTER_SLOTS.map(s => ({ ...s, player: null }));
  // Place each player in the most-restrictive eligible empty slot
  for (const p of players) {
    for (const s of slotAssignments) {
      if (s.player) continue;
      if (s.accepts(p.pos)) {
        s.player = p;
        break;
      }
      // Two-way: try the secondary position too
      if (p.isTwoWay && p.posSecondary && s.accepts(p.posSecondary)) {
        s.player = p;
        break;
      }
    }
  }
  return slotAssignments;
}

function renderRoster() {
  const root = document.getElementById("view-root");
  const me = getMyTeam();
  if (!me) {
    root.innerHTML = '<div class="empty"><p>Set your team in league config to optimize a roster.</p></div>';
    return;
  }
  const sel = getKeeperSelections()[me.id] || {};
  const kept = Object.entries(sel).filter(([_, f]) => f.keeper).map(([n]) => n);
  const myPicks = (_liveDraft.picks || []).filter(p => p.team === me.id).map(p => p.player);
  const allPlayers = [...kept, ...myPicks];

  let html = '<div class="card"><h2>Roster Optimizer <span class="muted small">' + esc(me.name) + '</span></h2>';
  html += '<p class="muted small">Greedy assignment of your kept + drafted players to optimal lineup slots. Most-restrictive position filled first (C, SS, 2B, 3B, 1B); flex slots (MI/CI/UTIL) absorb spillover; bench absorbs overflow.</p>';

  if (!allPlayers.length) {
    html += '<p class="muted">No players on your roster yet. Mark keepers in The League App or record draft picks.</p>';
    html += '</div>';
    root.innerHTML = html;
    return;
  }

  const assignments = optimizeRoster(allPlayers);
  const assigned = assignments.filter(s => s.player).length;
  const unassigned = allPlayers.length - assigned;

  html += '<div class="stat-row"><span class="label">Players</span><span class="value">' + allPlayers.length + ' (' + kept.length + ' kept, ' + myPicks.length + ' drafted)</span></div>';
  html += '<div class="stat-row"><span class="label">Filled slots</span><span class="value">' + assigned + ' / ' + ROSTER_SLOTS.length + '</span></div>';
  if (unassigned > 0) {
    html += '<div class="stat-row bad"><span class="label">Unable to assign</span><span class="value">' + unassigned + ' (over roster size)</span></div>';
  }
  html += '</div>';

  // Display the roster
  html += '<div class="card"><h3>Optimal Lineup</h3>';
  html += '<table><thead><tr><th>Slot</th><th>Player</th><th>Pos</th><th class="num">Value</th><th>Source</th></tr></thead><tbody>';
  const keptSet = new Set(kept);
  for (const s of assignments) {
    html += '<tr' + (s.player ? '' : ' class="dim"') + '>';
    html += '<td><strong>' + s.key + '</strong></td>';
    if (s.player) {
      html += '<td>' + esc(s.player.name) + '</td>';
      html += '<td>' + esc(s.player.pos) + (s.player.isTwoWay ? '/' + esc(s.player.posSecondary) : '') + '</td>';
      html += '<td class="num">$' + s.player.value.toFixed(0) + '</td>';
      html += '<td class="small ' + (keptSet.has(s.player.name) ? "keeper" : "") + '">' + (keptSet.has(s.player.name) ? "kept" : "drafted") + '</td>';
    } else {
      html += '<td class="dim">—</td><td></td><td></td><td></td>';
    }
    html += '</tr>';
  }
  html += '</tbody></table></div>';

  // Categorize summary
  const totals = projectTeamCategories(allPlayers);
  html += '<div class="card"><h3>Projection if This Roster Were Final</h3>';
  html += '<div class="grid cols-2"><div>';
  html += '<h3>Hitting</h3>';
  for (const [k, lbl] of [["R","Runs"],["HR","HR"],["RBI","RBI"],["SB","SB"],["OBP","OBP"]]) {
    const v = k === "OBP" ? totals.totals.OBP.toFixed(3) : Math.round(totals.totals[k]);
    const r = totals.ranks[k];
    html += '<div class="stat-row"><span class="label">' + esc(lbl) + '</span><span class="value">' + v + ' <span class="muted small">~' + r.toFixed(1) + '</span></span></div>';
  }
  html += '</div><div>';
  html += '<h3>Pitching</h3>';
  for (const [k, lbl] of [["QS","QS"],["K","K"],["SV_HLD","SV+HLD"],["ERA","ERA"],["WHIP","WHIP"]]) {
    const v = k === "ERA" ? totals.totals.ERA.toFixed(2) : k === "WHIP" ? totals.totals.WHIP.toFixed(2) : k === "SV_HLD" ? Math.round(totals.totals.SV_HLD) : Math.round(totals.totals[k]);
    const r = totals.ranks[k];
    html += '<div class="stat-row"><span class="label">' + esc(lbl) + '</span><span class="value">' + v + ' <span class="muted small">~' + r.toFixed(1) + '</span></span></div>';
  }
  html += '</div></div>';
  html += '<div style="margin-top: 8px;"><span class="muted small">Projected roto points: </span><strong style="font-family: var(--mono);">' + totals.rotoPoints.toFixed(1) + '</strong></div>';
  html += '</div>';

  root.innerHTML = html;
}
