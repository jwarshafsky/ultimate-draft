// Endgame assistant. Activates when the draft is in the late-stage scarcity
// phase, where most teams are running out of money and roster spots. The key
// insight: in the endgame, the *competition profile* of remaining teams
// matters more than projected value. A $5 player you want might cost $1 if
// nobody else can afford > $1; a $1 player might cost $5 if three teams need
// to fill their last C slot.
//
// Inputs: current live draft state (picks made, $ spent per team), keepers,
// player pool, your priority targets.
//
// Outputs:
//   - Per-team "max bid" right now (budget - slots_needed + 1)
//   - For each undrafted player: count of teams that COULD bid > $X for them
//   - Safe nominate recommendations: "Nominate X at $1 — only 1 team can outbid you to $3"
//   - Drain opportunities: "Nominate Y — opponent Z really needs CL and can afford $8"

// Compute per-team current state during a live draft. Uses _liveDraft.picks
// + keepers to figure out remaining budget, slots, and position needs.
function computeLiveTeamStates() {
  const states = {};
  // Keepers come from the Keepers tab (your predicted keepers), not the
  // league-site marks. ML draft slots are filled by major keepers AND
  // called-up minor leaguers; stashed minors stay off the ML roster.
  const test = (typeof draftTestMode === "function") && draftTestMode();
  const selections = test ? {} : ((typeof getEffectiveKeeperSelections === "function") ? getEffectiveKeeperSelections() : getKeeperSelections());
  const teams = (typeof draftTeams === "function") ? draftTeams() : LEAGUE.teams;
  for (const t of teams) {
    const teamSel = selections[t.id] || {};
    const kept = Object.entries(teamSel)
      .filter(([_, f]) => f.keeper)   // minor keepers are stashed — no ML slot
      .map(([name]) => name);
    // Same keeper-cost source as inflation.js (keeperCostFor) — the max bid
    // Jeff bids against must agree with the inflation badge (spec S-104).
    const keptCost = kept.reduce((s, n) => s + (typeof keeperCostFor === "function" ? keeperCostFor(n) : (getCurrentKeeperSalary(n) ?? 0)), 0);
    // Live picks for this team (mock teams also match on the raw ESPN id, so
    // picks recorded before a My-team change still count)
    const picks = (typeof _liveDraft !== "undefined" ? _liveDraft.picks : [])
      .filter(p => p.team === t.id || (t.espnTeamId != null && p.espnTeamId === t.espnTeamId));
    const spent = picks.reduce((s, p) => s + p.price, 0);
    const totalRoster = kept.length + picks.length;
    const slotsRemaining = LEAGUE.rosterSize - totalRoster;
    // Base budget includes traded draft dollars / manual setup overrides —
    // previously omitted here, so live max bids ignored budget trades.
    const adj = test ? 0 : (typeof getBudgetAdjustment === "function") ? getBudgetAdjustment(t.id) : 0;
    const budget = LEAGUE.draftBudget + adj - keptCost - spent;
    // True max bid: budget - (slotsRemaining - 1) reserved for $1 each.
    // A FULL roster (0 slots) can't bid at all — leftover cash is not a bid
    // (P2R1 math-2: a done team showed maxBid=$234 and polluted recommendBid
    // and ownerInterest as a phantom competitor).
    const maxBid = slotsRemaining <= 0 ? 0 : Math.max(0, budget - (slotsRemaining - 1));
    // Position need: count of each pos filled across keepers + draft
    const posCounts = {};
    for (const name of [...kept, ...picks.map(p => p.player)]) {
      const v = getPlayerValue(name);
      if (!v) continue;
      posCounts[v.posKey] = (posCounts[v.posKey] || 0) + 1;
    }
    states[t.id] = {
      teamId: t.id,
      teamName: t.name,
      ownerName: t.owner,
      isMe: !!t.isMe,
      budget, spent, keptCost, maxBid,
      slotsRemaining, picksMade: picks.length, keepersHeld: kept.length,
      posCounts,
      needsCatcher: (posCounts.C || 0) === 0,
      needsSS: (posCounts.SS || 0) === 0,
      needsRP: (posCounts.RP || 0) < 2,
    };
  }
  return states;
}

// Endgame trigger: total $ remaining / total slots remaining across the league
// is below threshold, OR your slots remaining is small. Either signals late-
// stage scarcity.
// Endgame is "active" when scarcity is real:
//   - Average $/slot across all teams < $6, OR
//   - 3+ teams have max bid <= $4, OR
//   - Total picks made >= 60% of total roster slots (200+ in a 12x26 league)
function isEndgame() {
  const states = Object.values(computeLiveTeamStates());
  const totalRem = states.reduce((s, t) => s + t.budget, 0);
  const totalSlots = states.reduce((s, t) => s + t.slotsRemaining, 0);
  const totalPicks = states.reduce((s, t) => s + t.picksMade, 0);
  if (totalSlots === 0) return true;
  const dollarsPerSlot = totalRem / totalSlots;
  const constrainedTeams = states.filter(t => t.maxBid <= 4 && t.slotsRemaining > 0).length;
  const totalRosterSlots = LEAGUE.numTeams * LEAGUE.rosterSize;
  return dollarsPerSlot < 6 || constrainedTeams >= 3 || totalPicks / totalRosterSlots >= 0.6;
}

// For each undrafted player, count how many opposing teams can afford a bid
// of $X+ AND have a need for that position. Returns a sorted list of
// "competition tier" entries.
function competitionProfile(player, states, myId, opts) {
  const minBidThreshold = (opts && opts.minBid) || 2;
  let competitorsAtMinBid = 0;
  let competitorsAtPlus2 = 0;
  let maxCompetitorBid = 0;
  for (const s of Object.values(states)) {
    if (s.teamId === myId) continue;
    if (s.slotsRemaining <= 0) continue;
    // Position need check — teams full at this pos won't bid hard.
    const target = POS_TARGETS[player.posKey] || 1;
    const have = s.posCounts[player.posKey] || 0;
    const need = have < target;
    const effectiveMax = need ? s.maxBid : Math.min(s.maxBid, 1); // teams full at pos can only $1
    if (effectiveMax >= minBidThreshold) competitorsAtMinBid += 1;
    if (effectiveMax >= minBidThreshold + 2) competitorsAtPlus2 += 1;
    if (effectiveMax > maxCompetitorBid) maxCompetitorBid = effectiveMax;
  }
  return { competitorsAtMinBid, competitorsAtPlus2, maxCompetitorBid };
}

// Safe nominate: "If I nominate X at $1, the highest anybody can pay is
// `maxCompetitorBid`. So my expected cost is in the range [$1, maxCompetitorBid+1]."
function endgameNominationRecommendations() {
  const states = computeLiveTeamStates();
  const me = (typeof getMyDraftTeam === "function") ? getMyDraftTeam() : getMyTeam();
  if (!me) return { state: "no-team", recs: [] };
  const myState = states[me.id];
  if (myState.slotsRemaining === 0) return { state: "done", recs: [] };

  const draftedNames = new Set((typeof _liveDraft !== "undefined" ? _liveDraft.picks : []).map(p => p.player));
  const _egNk = (typeof normalizePlayerName === "function") ? normalizePlayerName : (s => String(s || "").toLowerCase());
  const keptNames = (typeof draftExcludedNames === "function") ? draftExcludedNames() : new Set(collectKeepers().map(k => _egNk(k.name)));
  const pool = getValues().filter(p => p.value > -2 && !draftedNames.has(p.name) && !keptNames.has(_egNk(p.name)));

  // For each player I might want, compute:
  //   - my interest (positive surplus + position need)
  //   - competition profile
  //   - "safe price" = max(1, maxCompetitorBid + 1) — what I'd likely pay if I win
  const myNeed = (pos) => {
    const target = POS_TARGETS[pos] || 1;
    const have = myState.posCounts[pos] || 0;
    return Math.max(0, target - have);
  };

  const candidates = [];
  for (const p of pool.slice(0, 200)) {
    const myInterest = myNeed(p.posKey) > 0 ? p.value : p.value - 8; // small penalty if I don't strictly need
    if (myInterest <= 0) continue;
    const comp = competitionProfile(p, states, me.id, { minBid: 2 });
    const safePrice = Math.max(1, Math.min(comp.maxCompetitorBid + 1, myState.maxBid));
    candidates.push({
      player: p,
      myInterest,
      comp,
      safePrice,
      ev: myInterest - safePrice, // your expected value capture
      myNeed: myNeed(p.posKey),
    });
  }
  // Sort by EV (expected value capture)
  candidates.sort((a, b) => b.ev - a.ev);

  // Top safe-nominate (low competition, you want them)
  const safeNominate = candidates.filter(c => c.comp.maxCompetitorBid <= 3 && c.myInterest >= 3).slice(0, 12);

  // Drain opportunities — players opponents need that you don't, where they'll
  // overpay because they HAVE to fill the position.
  const drainCandidates = [];
  for (const p of pool.slice(0, 200)) {
    // Players I don't need
    if (myNeed(p.posKey) === 0 || p.value < 3) continue;
    if (myNeed(p.posKey) > 0 && p.value > 10) continue; // skip ones I might want
    const comp = competitionProfile(p, states, me.id, { minBid: 5 });
    if (comp.competitorsAtMinBid >= 2) {
      drainCandidates.push({
        player: p,
        comp,
        impactOpponents: comp.competitorsAtMinBid,
        expectedPrice: Math.max(p.value, comp.maxCompetitorBid),
      });
    }
  }
  drainCandidates.sort((a, b) => b.impactOpponents - a.impactOpponents);

  // Block opportunities — players nobody else can outbid but you should claim
  // because they'd block opponents from getting them cheap.
  const blockCandidates = candidates.filter(c => c.comp.maxCompetitorBid === 0 && c.player.value > 0).slice(0, 6);

  return {
    state: "active",
    myState,
    safeNominate,
    drainCandidates: drainCandidates.slice(0, 8),
    blockCandidates,
    allCandidates: candidates.slice(0, 30),
  };
}

// Endgame optimizer — a target-first plan: given my remaining targets and
// budget, what order to nominate them and what to pay, so I land the ones I
// want before the field's money (or mine) runs out. Different from the
// safe/drain/block lists above, which are opportunistic; this one is a plan to
// execute MY shortlist.
function endgameOptimizer() {
  const states = computeLiveTeamStates();
  const me = (typeof getMyDraftTeam === "function") ? getMyDraftTeam() : getMyTeam();
  if (!me) return { state: "no-team" };
  const myState = states[me.id];
  if (!myState || myState.slotsRemaining <= 0) return { state: "done" };

  const _nk = (typeof normalizePlayerName === "function") ? normalizePlayerName : (s => String(s || "").toLowerCase());
  const drafted = new Set((typeof _liveDraft !== "undefined" ? _liveDraft.picks : []).map(p => _nk(p.player)));
  const off = (typeof draftExcludedNames === "function") ? draftExcludedNames() : new Set();
  const available = getValues().filter(p => p.value > -2 && !drafted.has(_nk(p.name)) && !off.has(_nk(p.name)));

  // My remaining targets: flagged 'target' players still available, PLUS the
  // best available player at each of my open positions (so the plan is useful
  // even before I've flagged anyone).
  const flagged = (typeof getFlaggedPlayers === "function") ? new Set(getFlaggedPlayers("target").map(f => _nk(f.name || f.key))) : new Set();
  const openPos = {};
  for (const [pos, tgt] of Object.entries((typeof POS_TARGETS !== "undefined" ? POS_TARGETS : {}))) {
    openPos[pos] = Math.max(0, tgt - (myState.posCounts[pos] || 0));
  }
  const chosen = new Map();
  for (const p of available) if (flagged.has(_nk(p.name))) chosen.set(_nk(p.name), p);
  for (const pos of Object.keys(openPos)) {
    if (openPos[pos] <= 0) continue;
    const bestAtPos = available.filter(p => p.posKey === pos).sort((a, b) => b.value - a.value).slice(0, openPos[pos] + 1);
    for (const p of bestAtPos) if (p.value >= 3) chosen.set(_nk(p.name), p);
  }

  // Price + competition for each target.
  const targets = [];
  for (const p of chosen.values()) {
    const comp = competitionProfile(p, states, me.id, { minBid: 2 });
    const safePrice = Math.max(1, Math.min(comp.maxCompetitorBid + 1, myState.maxBid));
    targets.push({
      player: p, comp, safePrice,
      competitors: comp.competitorsAtMinBid,
      canAfford: safePrice <= myState.maxBid,
      // Risk of losing him = how many rivals can outbid you now. High risk →
      // nominate SOON (before their money tightens further isn't the point —
      // rather, before someone else nominates him and you're reacting). Low
      // risk (only you can pay) → safe to wait, grab cheap late.
      urgency: comp.competitorsAtMinBid,
    });
  }
  // Nominate the contested ones first (get them locked while you have max
  // flexibility); the ones only you can afford drop to the bottom (wait, $1).
  targets.sort((a, b) => b.urgency - a.urgency || b.player.value - a.player.value);

  const totalSafe = targets.reduce((s, t) => s + t.safePrice, 0);
  const feasible = totalSafe <= myState.maxBid + (myState.slotsRemaining - 1);   // rough: safe prices vs budget w/ $1 fillers
  const budgetForTargets = myState.budget;

  // High-value leftovers nobody can outbid you for → $1 grabs to prioritize.
  const freebies = available
    .filter(p => p.value >= 4 && !chosen.has(_nk(p.name)))
    .map(p => ({ player: p, comp: competitionProfile(p, states, me.id, { minBid: 2 }) }))
    .filter(x => x.comp.maxCompetitorBid === 0)
    .sort((a, b) => b.player.value - a.player.value)
    .slice(0, 6);

  return { state: "active", myState, targets, totalSafe, feasible, budgetForTargets, freebies };
}

function renderEndgameOptimizer() {
  const r = endgameOptimizer();
  if (r.state !== "active" || !r.targets.length) return '';
  let html = '<div class="card" style="border-color: rgba(79,142,247,.4);">';
  html += '<h3>🎯 Target plan <span class="muted small">nominate in this order · $' + r.myState.maxBid + ' max bid, ' + r.myState.slotsRemaining + ' slots</span></h3>';
  html += '<p class="small ' + (r.feasible ? 'muted' : 'bad') + '">Your shortlist costs ~$' + r.totalSafe + ' at safe prices' +
    (r.feasible ? ' — fits your budget.' : ' — over budget; drop or discount the lowest-priority ones.') + '</p>';
  html += '<table style="font-size:12px;"><thead><tr><th class="num">#</th><th>Player</th><th>Pos</th><th class="num">Value</th><th class="num">Safe $</th><th class="num">Rivals</th><th>When</th></tr></thead><tbody>';
  r.targets.forEach((t, i) => {
    const when = t.competitors === 0 ? '<span class="good">wait — grab cheap</span>' : t.competitors >= 3 ? '<span class="bad">nominate now</span>' : 'soon';
    html += '<tr><td class="num">' + (i + 1) + '</td>';
    html += '<td><span class="nom-pick" data-name="' + esc(t.player.name) + '" style="cursor:pointer;" title="Start auction">' + esc(t.player.name) + '</span></td>';
    html += '<td>' + esc(t.player.posKey) + '</td><td class="num">$' + t.player.value.toFixed(0) + '</td>';
    html += '<td class="num ' + (t.canAfford ? 'good' : 'bad') + '">$' + t.safePrice + '</td>';
    html += '<td class="num">' + t.competitors + '</td><td class="small">' + when + '</td></tr>';
  });
  html += '</tbody></table>';
  if (r.freebies.length) {
    html += '<p class="small" style="margin-top:6px;"><b>Free for $1</b> (nobody can outbid you): ' +
      r.freebies.map(f => '<span class="nom-pick" data-name="' + esc(f.player.name) + '" style="cursor:pointer; color:var(--good);">' + esc(f.player.name) + '</span>').join(", ") + '</p>';
  }
  html += '</div>';
  return html;
}

function renderEndgamePanel() {
  const endgameActive = isEndgame();
  if (!endgameActive) {
    return '<div class="card"><h2>Endgame Assistant</h2><p class="muted small">Activates automatically when the draft enters the late scarcity phase ($/slot drops below ~$4.50 across the league). Currently inactive.</p></div>';
  }
  const result = endgameNominationRecommendations();
  if (result.state === "no-team") return '';
  if (result.state === "done") {
    return '<div class="card"><h2>Endgame</h2><p class="good">Your roster is full. Watch for opponents to fill out.</p></div>';
  }

  let html = '';
  // Target-first plan comes before the opportunistic lists.
  html += renderEndgameOptimizer();

  html += '<div class="card" style="border-color: rgba(248,81,73,.4);">';
  html += '<h2>🔥 Endgame Assistant <span class="muted small">$' + result.myState.maxBid + ' max bid · ' + result.myState.slotsRemaining + ' slots open</span></h2>';

  // Safe nominate
  html += '<h3>Safe to nominate (low competition + you want them)</h3>';
  if (!result.safeNominate.length) {
    html += '<p class="muted small">No clean safe-nominate candidates right now.</p>';
  } else {
    html += '<table style="margin-bottom: 14px;"><thead><tr>';
    html += '<th>Player</th><th>Pos</th><th class="num">Value</th><th class="num">Safe $</th><th class="num">Max Opp Bid</th><th class="num">EV</th><th>Why</th></tr></thead><tbody>';
    for (const c of result.safeNominate) {
      html += '<tr>';
      html += '<td>' + esc(c.player.name) + '</td>';
      html += '<td>' + esc(c.player.posKey) + '</td>';
      html += '<td class="num">$' + c.player.value.toFixed(0) + '</td>';
      html += '<td class="num good">$' + c.safePrice + '</td>';
      html += '<td class="num">$' + c.comp.maxCompetitorBid + '</td>';
      html += '<td class="num good">+$' + c.ev.toFixed(0) + '</td>';
      const teams = c.comp.competitorsAtMinBid;
      html += '<td class="small muted">' + teams + ' team' + (teams === 1 ? "" : "s") + ' could outbid you to $2+</td>';
      html += '</tr>';
    }
    html += '</tbody></table>';
  }

  // Drain opportunities
  if (result.drainCandidates.length) {
    html += '<h3>Drain nominations (force opponents to spend)</h3>';
    html += '<table style="margin-bottom: 14px;"><thead><tr>';
    html += '<th>Player</th><th>Pos</th><th class="num">Value</th><th class="num">Expected $</th><th class="num">Opponents</th><th>Why</th></tr></thead><tbody>';
    for (const d of result.drainCandidates) {
      html += '<tr>';
      html += '<td>' + esc(d.player.name) + '</td>';
      html += '<td>' + esc(d.player.posKey) + '</td>';
      html += '<td class="num">$' + d.player.value.toFixed(0) + '</td>';
      html += '<td class="num warn">$' + d.expectedPrice.toFixed(0) + '</td>';
      html += '<td class="num">' + d.impactOpponents + '</td>';
      html += '<td class="small muted">You don\'t need ' + d.player.posKey + '; opponents do</td>';
      html += '</tr>';
    }
    html += '</tbody></table>';
  }

  // Block / freebies
  if (result.blockCandidates.length) {
    html += '<h3>Free for $1 (nobody can outbid)</h3>';
    html += '<table><thead><tr><th>Player</th><th>Pos</th><th class="num">Value</th><th>Why</th></tr></thead><tbody>';
    for (const c of result.blockCandidates) {
      html += '<tr>';
      html += '<td>' + esc(c.player.name) + '</td>';
      html += '<td>' + esc(c.player.posKey) + '</td>';
      html += '<td class="num">$' + c.player.value.toFixed(0) + '</td>';
      html += '<td class="small muted">Nobody else has roster + budget to bid $2+</td>';
      html += '</tr>';
    }
    html += '</tbody></table>';
  }

  html += '</div>';
  return html;
}

// Compact team-state strip for the ESPN-style header. Returns HTML.
function renderTeamStrip() {
  const states = computeLiveTeamStates();
  const sorted = Object.values(states).sort((a, b) => {
    if (a.isMe !== b.isMe) return a.isMe ? -1 : 1;
    return b.budget - a.budget;
  });
  let html = '<div class="team-strip">';
  for (const s of sorted) {
    const perSlot = s.slotsRemaining > 0 ? (s.budget / s.slotsRemaining).toFixed(1) : "—";
    html += '<div class="team-strip-card' + (s.isMe ? " me" : "") + (s.slotsRemaining === 0 ? " done" : "") + '">';
    html += '<div class="ts-name">' + esc(s.ownerName) + '</div>';
    html += '<div class="ts-row"><span class="ts-label">$</span><span class="ts-val">' + s.budget + '</span></div>';
    html += '<div class="ts-row"><span class="ts-label">slots</span><span class="ts-val">' + s.slotsRemaining + '</span></div>';
    html += '<div class="ts-row"><span class="ts-label">max</span><span class="ts-val">' + s.maxBid + '</span></div>';
    html += '<div class="ts-row"><span class="ts-label">$/sl</span><span class="ts-val">' + perSlot + '</span></div>';
    html += '</div>';
  }
  html += '</div>';
  return html;
}
