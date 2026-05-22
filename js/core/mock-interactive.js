// Interactive mock draft. User plays as their own team (Jeff/Hold the Mayo)
// and bids against AI agents for the other 11 teams. AI behavior comes from
// the tendency profiles computed from league history (via profileToMockOverlay).
//
// State machine:
//   idle → nominating → bidding → sold → nominating → ... → done

const _interactive = {
  active: false,
  states: {},        // teamId → MockTeamState
  pool: [],          // remaining draftable players
  picks: [],         // completed picks: { idx, player, pos, type, baseValue, price, surplus, winnerTeamId, winnerOwner, nominatorTeamId }
  nominationOrder: [],
  currentNominator: 0,
  current: null,     // { player, value, posKey, type }
  currentBid: 0,
  currentWinner: null,// team id
  passedTeams: null, // Set<teamId> of teams that have passed THIS auction
  phase: "idle",     // idle | nominating | bidding | sold | done
  inflation: null,
  listeners: [],
};

function onInteractiveChange(fn) {
  _interactive.listeners.push(fn);
}
function _fireChange() {
  for (const fn of _interactive.listeners) {
    try { fn(_interactive); } catch (e) { console.error(e); }
  }
}

function getInteractiveState() { return _interactive; }

function startInteractiveMock() {
  _interactive.states = buildMockTeamStates({});
  const keptNames = new Set(collectKeepers().map(k => k.name));
  _interactive.pool = getValues().filter(p => p.value > 0 && !keptNames.has(p.name)).slice();
  _interactive.pool.sort((a, b) => b.value - a.value);
  _interactive.picks = [];
  _interactive.nominationOrder = Object.keys(_interactive.states);
  // Shuffle nomination order; user goes wherever they land
  for (let i = _interactive.nominationOrder.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [_interactive.nominationOrder[i], _interactive.nominationOrder[j]] = [_interactive.nominationOrder[j], _interactive.nominationOrder[i]];
  }
  _interactive.currentNominator = 0;
  _interactive.phase = "nominating";
  _interactive.active = true;
  _interactive.current = null;
  _interactive.currentBid = 0;
  _interactive.currentWinner = null;
  _interactive.passedTeams = new Set();
  _interactive.inflation = _computeInteractiveInflation();
  _advanceToNominatingTeam();
}

function stopInteractiveMock() {
  _interactive.active = false;
  _interactive.phase = "idle";
  _fireChange();
}

// Advance the currentNominator pointer past any team that has no remaining slots.
function _advanceToNominatingTeam() {
  let tries = 0;
  while (tries < _interactive.nominationOrder.length) {
    const id = _interactive.nominationOrder[_interactive.currentNominator % _interactive.nominationOrder.length];
    if (_interactive.states[id].slotsRemaining > 0) {
      _interactive.phase = "nominating";
      _fireChange();
      // If it's an AI team's turn, auto-nominate
      if (!_interactive.states[id].isMe) {
        setTimeout(() => _aiAutoNominate(id), 400);
      }
      return;
    }
    _interactive.currentNominator++;
    tries++;
  }
  // No active teams left
  _interactive.phase = "done";
  _fireChange();
}

function getCurrentNominatorId() {
  return _interactive.nominationOrder[_interactive.currentNominator % _interactive.nominationOrder.length];
}

function _aiAutoNominate(teamId) {
  const state = _interactive.states[teamId];
  if (!state || state.slotsRemaining <= 0) {
    _interactive.currentNominator++;
    _advanceToNominatingTeam();
    return;
  }
  const player = chooseNomination(state, _interactive.pool, _interactive.inflation);
  if (!player) {
    _interactive.phase = "done";
    _fireChange();
    return;
  }
  const opening = Math.max(1, Math.min(
    Math.round(player.value * 0.5),
    state.budget - Math.max(0, state.slotsRemaining - 1)
  ));
  _startAuction(player, teamId, opening);
}

// Called by UI when the user nominates a player.
function userNominate(playerName, opening) {
  const me = getMyTeam();
  if (!me || getCurrentNominatorId() !== me.id) return { ok: false, error: "Not your turn to nominate." };
  const myState = _interactive.states[me.id];
  if (myState.slotsRemaining <= 0) return { ok: false, error: "Your roster is full." };
  const player = _interactive.pool.find(p => p.name.toLowerCase() === playerName.toLowerCase());
  if (!player) return { ok: false, error: "Player not in pool: " + playerName };
  const openingBid = Math.max(1, Math.min(opening || 1, myState.budget - Math.max(0, myState.slotsRemaining - 1)));
  _startAuction(player, me.id, openingBid);
  return { ok: true };
}

function _startAuction(player, nominatorId, opening) {
  _interactive.current = player;
  _interactive.currentBid = opening;
  _interactive.currentWinner = nominatorId;
  _interactive.passedTeams = new Set();
  _interactive.phase = "bidding";
  _fireChange();
  // AI gets first crack at responding
  setTimeout(() => _runAiBidsUntilUserTurn(), 400);
}

// Have ALL AI teams check if they want to bid above currentBid. First one
// that wants to bid bumps the price. Returns true if any AI bid.
function _aiBidsOnce() {
  // Shuffle so it's not deterministic which AI bids first
  const aiIds = Object.keys(_interactive.states).filter(id =>
    !_interactive.states[id].isMe &&
    !_interactive.passedTeams.has(id) &&
    _interactive.states[id].slotsRemaining > 0 &&
    _interactive.states[id].budget > _interactive.currentBid &&
    id !== _interactive.currentWinner
  );
  for (let i = aiIds.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [aiIds[i], aiIds[j]] = [aiIds[j], aiIds[i]];
  }
  for (const id of aiIds) {
    const state = _interactive.states[id];
    const max = computeMaxBid(state, _interactive.current, _interactive.inflation);
    if (max > _interactive.currentBid) {
      const inc = _interactive.currentBid < 5 ? 1 : _interactive.currentBid < 12 ? 1 : _interactive.currentBid < 25 ? 2 : _interactive.currentBid < 40 ? 3 : 4;
      const newBid = Math.min(max, _interactive.currentBid + inc);
      if (newBid > _interactive.currentBid) {
        _interactive.currentBid = newBid;
        _interactive.currentWinner = id;
        return true;
      }
    } else {
      _interactive.passedTeams.add(id);
    }
  }
  return false;
}

// Run AI bidding rounds until either (a) user is winning and AI all pass
// (sold to user), (b) AI is winning and user needs to decide, or
// (c) max iterations reached.
function _runAiBidsUntilUserTurn() {
  const me = getMyTeam();
  let safety = 0;
  while (safety < 100) {
    safety++;
    const aiBid = _aiBidsOnce();
    _fireChange();
    if (!aiBid) {
      // No AI wants to bump. If user is winning, sold!
      if (_interactive.currentWinner === me?.id) {
        _completeSale();
        return;
      }
      // If user has passed, AI keeps fighting amongst themselves... but
      // we already iterated. Actually if AI didn't bump and user passed,
      // then current winner wins.
      if (_interactive.passedTeams.has(me?.id)) {
        _completeSale();
        return;
      }
      // Otherwise: AI is winning, user needs to act
      return;
    }
    // AI bumped. If user is now NOT the winner and hasn't passed, give user a chance.
    if (_interactive.currentWinner !== me?.id && !_interactive.passedTeams.has(me?.id)) {
      // Wait for user to respond
      return;
    }
    // If user passed, keep iterating AI bidding amongst themselves
  }
  // Safety bailout
  _completeSale();
}

// User clicks "Bid +$X" or enters a specific amount.
function userBid(amount) {
  const me = getMyTeam();
  if (!me) return { ok: false, error: "No team" };
  if (_interactive.phase !== "bidding") return { ok: false, error: "Not bidding." };
  const myState = _interactive.states[me.id];
  if (myState.slotsRemaining <= 0) return { ok: false, error: "Your roster is full." };
  const maxAffordable = myState.budget - Math.max(0, myState.slotsRemaining - 1);
  const bid = Math.min(amount, maxAffordable);
  if (bid <= _interactive.currentBid) return { ok: false, error: "Bid must exceed $" + _interactive.currentBid };
  if (bid > maxAffordable) return { ok: false, error: "Max affordable: $" + maxAffordable };
  _interactive.currentBid = bid;
  _interactive.currentWinner = me.id;
  // Remove user from passed (in case they bid after passing earlier)
  _interactive.passedTeams.delete(me.id);
  _fireChange();
  // AI responds
  setTimeout(() => _runAiBidsUntilUserTurn(), 400);
  return { ok: true };
}

// User passes on current auction.
function userPass() {
  const me = getMyTeam();
  if (!me) return;
  if (_interactive.phase !== "bidding") return;
  _interactive.passedTeams.add(me.id);
  _fireChange();
  setTimeout(() => _runAiBidsUntilUserTurn(), 400);
}

function _completeSale() {
  if (!_interactive.current) return;
  const winnerId = _interactive.currentWinner;
  const winner = _interactive.states[winnerId];
  const rawPrice = _interactive.currentBid;
  const winnerReserve = Math.max(0, winner.slotsRemaining - 1);
  const winnerMaxPrice = Math.max(1, winner.budget - winnerReserve);
  const price = Math.min(rawPrice, winnerMaxPrice);
  const player = _interactive.current;

  winner.budget = Math.max(0, winner.budget - price);
  winner.drafted.push({ name: player.name, pos: player.posKey, price, value: player.value, type: player.type });
  winner.slotsByPos[player.posKey] = (winner.slotsByPos[player.posKey] || 0) + 1;
  winner.slotsRemaining -= 1;

  _interactive.picks.push({
    idx: _interactive.picks.length + 1,
    player: player.name,
    pos: player.posKey,
    type: player.type,
    baseValue: player.value,
    inflatedValue: inflatedValue(player, _interactive.inflation),
    price,
    surplus: player.value - price,
    winnerTeamId: winner.teamId,
    winnerOwner: winner.ownerName,
    nominatorTeamId: getCurrentNominatorId(),
  });

  // Remove from pool
  _interactive.pool = _interactive.pool.filter(p => p.name !== player.name);
  _interactive.current = null;
  _interactive.currentBid = 0;
  _interactive.currentWinner = null;
  _interactive.passedTeams = new Set();
  _interactive.phase = "sold";
  _interactive.inflation = _computeInteractiveInflation();
  _fireChange();
  // Advance to next nominator
  _interactive.currentNominator++;
  setTimeout(() => _advanceToNominatingTeam(), 700);
}

function _computeInteractiveInflation() {
  const draftedNames = new Set();
  let spent = 0;
  for (const s of Object.values(_interactive.states)) {
    for (const d of s.drafted) { draftedNames.add(d.name); spent += d.price; }
  }
  const keptNames = new Set(collectKeepers().map(k => k.name));
  const values = getValues();
  const totalBudget = LEAGUE.draftBudget * LEAGUE.numTeams;
  const totalKeptCost = Object.values(_interactive.states).reduce((s, t) => s + (LEAGUE.draftBudget - t.budget - t.drafted.reduce((x, d) => x + d.price, 0)), 0);
  const remaining = Math.max(0, totalBudget - totalKeptCost - spent);
  let remainingValue = 0;
  for (const p of values) {
    if (p.value <= 0) continue;
    if (keptNames.has(p.name) || draftedNames.has(p.name)) continue;
    remainingValue += p.value;
  }
  let mult = remainingValue > 0 ? remaining / remainingValue : 1;
  if (!isFinite(mult) || mult < 0) mult = 1;
  mult = Math.max(0.3, Math.min(3.0, mult));
  return {
    mode: "tiered",
    multiplier: mult,
    hitMultiplier: mult,
    pitMultiplier: mult,
    tierMult: { T1: mult * 1.15, T2: mult * 1.08, T3: mult, T4: mult * 0.9, T5: mult * 0.7 },
  };
}
