// Nomination strategy assistant. Suggests who to nominate based on:
//   - Current phase of draft (open / middle / endgame)
//   - Your filled positions vs. opponents' open positions ("drain" mode)
//   - High-volume players you don't want (dump nominations)
//   - Endgame blockers (drain final dollars to set your $1 buys free)
//
// Surfaced both in the Live Draft view (during the auction) and as a
// pre-draft list on the Overview / Mock pages.

// Compute remaining-need profile for every team. Higher = more open slots and
// positions. Used to decide who's hurt by which nomination.
function teamOpenSlotProfile() {
  const profile = {};
  const selections = getKeeperSelections();
  for (const t of LEAGUE.teams) {
    const sel = selections[t.id] || {};
    const kept = Object.entries(sel).filter(([_, f]) => f.keeper).map(([n]) => n);
    const posCounts = {};
    for (const name of kept) {
      const val = getPlayerValue(name);
      if (!val) continue;
      posCounts[val.posKey] = (posCounts[val.posKey] || 0) + 1;
    }
    profile[t.id] = {
      teamId: t.id,
      keptCount: kept.length,
      slotsOpen: LEAGUE.rosterSize - kept.length,
      posCounts,
      // "Open need" per position
      openNeed: {},
    };
    for (const pos of ["C", "1B", "2B", "SS", "3B", "OF", "SP", "RP"]) {
      const target = pos === "OF" ? 5 : pos === "SP" ? 6 : pos === "RP" ? 3 : 1;
      profile[t.id].openNeed[pos] = Math.max(0, target - (posCounts[pos] || 0));
    }
  }
  return profile;
}

// Builds a ranked nomination list. The strategy mix is the same as the mock
// engine's owner profile, but the suggestions are tailored to YOUR team.
function suggestNominations(opts) {
  opts = opts || {};
  const me = getMyTeam();
  if (!me) return [];
  const myProfile = teamOpenSlotProfile()[me.id];
  const values = getValues();
  if (!values.length) return [];

  // Off the board = predicted keepers + every MiL-rostered player (stashed or
  // called up) — normalized names so accents/suffixes can't leak one through.
  const _nomNk = (typeof normalizePlayerName === "function") ? normalizePlayerName : (s => String(s || "").toLowerCase());
  const keptNames = (typeof draftExcludedNames === "function")
    ? draftExcludedNames()
    : new Set(collectKeepers().map(k => _nomNk(k.name)));
  const draftedNames = new Set(opts.draftedNames || []);
  const pool = values.filter(p => p.value > 0 && !keptNames.has(_nomNk(p.name)) && !draftedNames.has(p.name));

  const inflation = computeTieredInflation();
  const allOpen = teamOpenSlotProfile();
  // Other teams (not me) — their position needs
  const others = Object.values(allOpen).filter(p => p.teamId !== me.id);

  const suggestions = [];

  // 1. Dump candidates — players I don't need but other teams do want.
  // Look for high-value players at positions I'm full on.
  const myFullPositions = new Set(
    Object.entries(myProfile.openNeed).filter(([_, n]) => n === 0).map(([p]) => p)
  );
  for (const p of pool.slice(0, 50)) {
    if (myFullPositions.has(p.posKey) && p.value >= 18) {
      // Demand level: how many other teams want this position
      const demand = others.filter(o => (o.openNeed[p.posKey] || 0) > 0).length;
      if (demand >= 4) {
        suggestions.push({
          kind: "dump",
          player: p,
          reason: "Position is full for you; " + demand + " other teams still need " + p.posKey,
          drainsTeams: others.filter(o => (o.openNeed[p.posKey] || 0) > 0).length,
          priceTarget: Math.round(inflatedValue(p, inflation)),
        });
      }
    }
  }

  // 2. Drain candidates — players at scarce/contested positions, push opponents
  // who really need them. Different from "dump" because you may not even be full;
  // you're just pricing them out for opponents.
  const scarcePositions = ["C", "SS", "RP"];
  for (const pos of scarcePositions) {
    const top = pool.filter(p => p.posKey === pos).slice(0, 3);
    for (const p of top) {
      const demand = others.filter(o => (o.openNeed[pos] || 0) > 0).length;
      if (demand >= 5 && p.value > 5) {
        // Skip if already suggested
        if (!suggestions.find(s => s.player.name === p.name)) {
          suggestions.push({
            kind: "drain",
            player: p,
            reason: "Scarce position; " + demand + " teams still need " + pos,
            drainsTeams: demand,
            priceTarget: Math.round(inflatedValue(p, inflation)),
          });
        }
      }
    }
  }

  // 3. Blocker candidates — late-draft nominations to drain the last $5-10
  // from a couple of opponents who could compete for your endgame $1 targets.
  // (Most useful once we have live draft state; static list shows top
  // "blocker" candidates by position).
  const blockerCutoff = 10;
  for (const p of pool) {
    if (p.value >= 4 && p.value <= blockerCutoff) {
      const demand = others.filter(o => (o.openNeed[p.posKey] || 0) > 0).length;
      if (demand >= 3 && (myProfile.openNeed[p.posKey] || 0) === 0) {
        if (!suggestions.find(s => s.player.name === p.name)) {
          suggestions.push({
            kind: "blocker",
            player: p,
            reason: "Late-draft drainer; " + demand + " teams need " + p.posKey + " but you don't",
            drainsTeams: demand,
            priceTarget: Math.round(inflatedValue(p, inflation)),
          });
        }
      }
    }
  }

  // Sort: by kind priority (drain > dump > blocker), then by drain count
  const kindOrder = { drain: 0, dump: 1, blocker: 2 };
  suggestions.sort((a, b) => {
    if (kindOrder[a.kind] !== kindOrder[b.kind]) return kindOrder[a.kind] - kindOrder[b.kind];
    return b.drainsTeams - a.drainsTeams;
  });

  return suggestions.slice(0, 30);
}

// Helper to render a nomination panel (used inside the Live Draft view and the
// Overview as a sidebar). Returns an HTML string.
function renderNominationsPanel() {
  const suggestions = suggestNominations();
  if (!suggestions.length) {
    return '<div class="muted small">Nomination suggestions will appear here once projections are loaded and your keepers are set.</div>';
  }
  let html = '<table style="font-size: 12px;"><thead><tr>';
  html += '<th>Kind</th><th>Player</th><th>Pos</th><th class="num">Target $</th><th>Why</th></tr></thead><tbody>';
  for (const s of suggestions) {
    const colors = { drain: "var(--bad)", dump: "var(--warn)", blocker: "var(--accent)" };
    html += '<tr>';
    html += '<td><span class="kbd" style="color: ' + colors[s.kind] + '; font-size: 10px;">' + s.kind.toUpperCase() + '</span></td>';
    html += '<td>' + esc(s.player.name) + '</td>';
    html += '<td>' + esc(s.player.posKey) + '</td>';
    html += '<td class="num">$' + s.priceTarget + '</td>';
    html += '<td class="small muted">' + esc(s.reason) + '</td>';
    html += '</tr>';
  }
  html += '</tbody></table>';
  return html;
}
