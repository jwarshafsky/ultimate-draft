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
  gen: 0,            // bumped on start/stop; queued timers from an old gen are ignored
  bidLog: [],        // [{owner, bid}] for the CURRENT auction (escalation ticker)
  lastSale: null,    // {player, price, owner, mine} — for the SOLD banner
  useTimer: true,    // draft-day countdown pressure when it's your turn to act
  timerSecs: 12,
  secondsLeft: 0,    // live countdown while waiting on the user
  bidSpeed: "realistic", // "realistic" (staggered) | "fast" | "instant" — pacing of AI bids/nominations
  proxyMax: null,    // auto-bid cap for the CURRENT lot (engine bids for you up to this)
  nomSlot: "random", // where you sit in the nomination order: "random" | "first" | "last" | 0-based seat #
  heat: "normal",    // market-heat label: "cold" | "normal" | "hot" (UI; engine global does the work)
  cockpit: false,    // true when this mock drives the Live Draft cockpit (frames mirrored via _mockCockpitEmit)
};

// Cockpit bridge: when this interactive mock is driving the Live Draft cockpit
// (not the Mock-tab UI), mirror each nomination / bid / sale into the cockpit's
// ESPN-style event pipeline through the global installed by mock-live-feed.js,
// so the real hero / ticker / budgets / standings / picks all update unchanged.
// A no-op in the ordinary Mock-tab interactive mode.
function _icEmit(cmd, realTeamId, playerName, amount) {
  if (!_interactive.cockpit) return;
  if (typeof _mockCockpitEmit === "function") _mockCockpitEmit(cmd, realTeamId, playerName, amount);
}

const HEAT_FACTORS = { cold: 0.92, normal: 1.0, hot: 1.10 };
function setMockClock(secsOrOff) {
  if (secsOrOff === "off" || secsOrOff === 0) { _interactive.useTimer = false; _clearMockTimer(); }
  else { _interactive.useTimer = true; _interactive.timerSecs = parseInt(secsOrOff, 10) || 12; }
  _fireChange();
}
function setMockNomSlot(slot) { _interactive.nomSlot = slot; _fireChange(); }
function setMockHeat(label) {
  if (!(label in HEAT_FACTORS)) return;
  _interactive.heat = label;
  if (typeof setMockMarketHeat === "function") setMockMarketHeat(HEAT_FACTORS[label]);
  _fireChange();
}
// Auto-bid cap for the current lot. Cleared at the start of each new auction.
function setProxyMax(v) {
  const n = parseInt(v, 10);
  _interactive.proxyMax = (isFinite(n) && n > _interactive.currentBid) ? n : null;
  _fireChange();
  // If it's already our turn (an AI is leading), let the proxy engage immediately.
  if (_interactive.proxyMax) { const me = getMyTeam(); if (me && _interactive.phase === "bidding" && _interactive.currentWinner !== me.id && !_interactive.passedTeams.has(me.id)) _giveUserTheClock(); }
}

// Pacing factor applied to every AI-churn / between-lot delay (NOT the draft
// clock, which is real seconds). instant=0 (resolve on next tick), fast=0.4x.
function _bidSpeedFactor() {
  return _interactive.bidSpeed === "instant" ? 0 : _interactive.bidSpeed === "fast" ? 0.4 : 1;
}
function _d(base) { return Math.round(base * _bidSpeedFactor()); }
function setMockBidSpeed(speed) {
  if (["realistic", "fast", "instant"].includes(speed)) { _interactive.bidSpeed = speed; _fireChange(); }
}

// Schedule a callback that only runs if the mock is still on the SAME generation
// and active — so a stopped/restarted/backgrounded mock can't keep mutating
// state when its old setTimeouts fire.
function _later(fn, ms) {
  const g = _interactive.gen;
  setTimeout(() => { if (_interactive.gen === g && _interactive.active) fn(); }, ms);
}

function onInteractiveChange(fn) {
  _interactive.listeners.push(fn);
}
function _fireChange() {
  for (const fn of _interactive.listeners) {
    try { fn(_interactive); } catch (e) { console.error(e); }
  }
}

function getInteractiveState() { return _interactive; }
function setMockTimerEnabled(on) {
  _interactive.useTimer = !!on;
  if (!on) _clearMockTimer();
  _fireChange();
}

function startInteractiveMock(opts) {
  opts = opts || {};
  // GUARD: the mock must run the full league. If LEAGUE.teams isn't loaded yet
  // (or is short), refuse to start rather than silently run a 3-team draft.
  const expectedTeams = (typeof LEAGUE !== "undefined" && Array.isArray(LEAGUE.teams)) ? LEAGUE.teams.length : 0;
  if (expectedTeams < 2) {
    return { ok: false, error: "League not loaded yet — try again in a moment." };
  }
  _interactive.gen++;   // invalidate any timers from a prior session
  _interactive.cockpit = !!opts.cockpit;   // drive the Live Draft cockpit instead of the Mock-tab UI
  // The draft clock stays ON in the cockpit (Jeff: "there is no countdown for
  // picks") — real auction pressure; expiry auto-passes, same as the Mock tab.
  // Keepers are REAL by default everywhere (item 6 — a kept player like Nick
  // Kurtz must never be nominable); noKeepers stays as an explicit opt-in for
  // tests/simulations only.
  const noKeepers = !!opts.noKeepers;
  const built = buildMockTeamStates(noKeepers ? { noKeepers: true } : {});
  // Belt-and-suspenders: if the build somehow came back short of the league,
  // abort with a clear message instead of starting a partial (< full) mock.
  if (Object.keys(built).length < expectedTeams) {
    return { ok: false, error: "Couldn't build all " + expectedTeams + " teams — reload and try again." };
  }
  _interactive.states = built;
  const _nk = (typeof normalizePlayerName === "function") ? normalizePlayerName : (s => String(s || "").toLowerCase());
  const keptNames = noKeepers ? new Set()
    : ((typeof _mockKeptSet === "function") ? _mockKeptSet() : new Set(collectKeepers().map(k => _nk(k.name))));
  _interactive.pool = getValues().filter(p => p.value > 0 && !keptNames.has(_nk(p.name))).slice();
  _interactive.pool.sort((a, b) => b.value - a.value);
  _interactive.picks = [];
  _interactive.nominationOrder = Object.keys(_interactive.states);
  // Shuffle nomination order; user goes wherever they land...
  for (let i = _interactive.nominationOrder.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [_interactive.nominationOrder[i], _interactive.nominationOrder[j]] = [_interactive.nominationOrder[j], _interactive.nominationOrder[i]];
  }
  // ...unless you chose a specific nomination seat — re-seat yourself there.
  const meId = (typeof getMyTeam === "function" && getMyTeam()) ? getMyTeam().id : null;
  if (meId && _interactive.nomSlot !== "random") {
    const order = _interactive.nominationOrder.filter(id => id !== meId);
    const n = order.length;
    let idx;
    if (_interactive.nomSlot === "first") idx = 0;
    else if (_interactive.nomSlot === "last") idx = n;
    else { idx = parseInt(_interactive.nomSlot, 10); if (!isFinite(idx)) idx = 0; idx = Math.max(0, Math.min(n, idx)); }
    order.splice(idx, 0, meId);
    _interactive.nominationOrder = order;
  }
  _interactive.currentNominator = 0;
  _interactive.phase = "nominating";
  _interactive.active = true;
  _interactive.current = null;
  _interactive.currentBid = 0;
  _interactive.currentWinner = null;
  _interactive.passedTeams = new Set();
  _interactive.bidLog = [];
  _interactive.lastSale = null;
  _interactive.secondsLeft = 0;
  _interactive.proxyMax = null;
  if (typeof setMockMarketHeat === "function") setMockMarketHeat(HEAT_FACTORS[_interactive.heat] || 1.0);
  _interactive.inflation = inflationForMockState(_interactive.states);
  _advanceToNominatingTeam();
  return { ok: true };
}

function stopInteractiveMock() {
  _clearMockTimer();
  _interactive.active = false;
  _interactive.gen++;   // invalidate in-flight timers
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
        _later(() => _aiAutoNominate(id), _d(400));
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
  // Open at the $1 floor like the headless engine — contenders bid it up.
  _startAuction(player, teamId, 1);
}

// Single source of truth for the paused flag: reuse _mockFeed.paused (set by
// the flow controls in mock-live-feed.js) so the engine and the UI agree. Safe
// to reference even outside the cockpit mock — undefined _mockFeed → not paused.
function _icPaused() {
  return typeof _mockFeed !== "undefined" && !!_mockFeed.paused;
}

// Called by UI when the user nominates a player.
function userNominate(playerName, opening) {
  if (_icPaused()) return { ok: false, error: "Paused." };
  const me = getMyTeam();
  if (!me || getCurrentNominatorId() !== me.id) return { ok: false, error: "Not your turn to nominate." };
  const myState = _interactive.states[me.id];
  if (myState.slotsRemaining <= 0) return { ok: false, error: "Your roster is full." };
  const nk = (typeof normalizePlayerName === "function") ? normalizePlayerName : (s => String(s || "").toLowerCase());
  const q = nk(playerName);
  const player = _interactive.pool.find(p => p.name.toLowerCase() === playerName.toLowerCase()) ||
                 _interactive.pool.find(p => nk(p.name) === q);
  if (!player) {
    // A keeper deserves a specific message — "not in pool" reads like a bug
    // when Jeff types a real player's name (R16).
    const kept = (typeof _mockKeptSet === "function") ? _mockKeptSet() : null;
    if (kept && kept.has(q)) return { ok: false, error: playerName + " is a keeper — already on a roster, not in this auction." };
    return { ok: false, error: "Player not in pool: " + playerName };
  }
  const openingBid = Math.max(1, Math.min(opening || 1, myState.budget - Math.max(0, myState.slotsRemaining - 1)));
  _startAuction(player, me.id, openingBid);
  return { ok: true };
}

function _startAuction(player, nominatorId, opening) {
  _clearMockTimer();
  _interactive.current = player;
  _interactive.currentBid = opening;
  _interactive.currentWinner = nominatorId;
  _interactive.passedTeams = new Set();
  _interactive.phase = "bidding";
  _interactive.proxyMax = null;     // proxy cap is per-lot
  _interactive.lastSale = null;     // clear the SOLD banner once a new lot opens
  // Seed the escalation ticker with the opening (nominating) bid.
  const nom = _interactive.states[nominatorId];
  _interactive.bidLog = [{ owner: nom ? (nom.isMe ? "You" : nom.ownerName) : "—", bid: opening, mine: !!(nom && nom.isMe) }];
  // Cockpit mirror: open the lot (NOMINATION) then the opening bid.
  _icEmit("NOMINATION", nominatorId, player.name, null);
  _icEmit("BID", nominatorId, player.name, opening);
  _fireChange();
  // AI gets first crack at responding (one step at a time, so the price climbs visibly).
  _later(() => _runAiBidsUntilUserTurn(), _d(450));
}

// ----- draft-day countdown -----
// While it's the user's turn to act (an AI is winning), a soft timer adds
// real auction pressure. On expiry the user auto-passes.
function _clearMockTimer() {
  if (_interactive._timerId) { clearTimeout(_interactive._timerId); _interactive._timerId = null; }
  _interactive.secondsLeft = 0;
}
function _startMockTimer() {
  _clearMockTimer();
  if (!_interactive.useTimer) return;
  _interactive.secondsLeft = _interactive.timerSecs;
  const myGen = _interactive.gen;
  const tick = () => {
    if (_interactive.gen !== myGen || _interactive.phase !== "bidding") return;
    _interactive.secondsLeft -= 1;
    if (_interactive.secondsLeft <= 0) {
      _interactive.secondsLeft = 0;
      _interactive._timerId = null;
      _fireChange();
      userPass();           // time's up — auto-pass
      return;
    }
    _fireChange();
    _interactive._timerId = setTimeout(tick, 1000);
  };
  _interactive._timerId = setTimeout(tick, 1000);
}

// One AI bump: the first willing team (random order) raises the price by one
// increment. AI teams are RE-EVALUATED every step (no permanent pass) so their
// willingness tracks the headless engine — fresh noise each call gives a team
// that just declined another shot, exactly like a live room. Returns the
// bumping owner's display name, or null if no AI wants the lot at this price.
function _aiBidsOnce() {
  const me = getMyTeam();
  const aiIds = Object.keys(_interactive.states).filter(id =>
    !_interactive.states[id].isMe &&
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
      const inc = _interactive.currentBid < 12 ? 1 : _interactive.currentBid < 25 ? 2 : _interactive.currentBid < 40 ? 3 : 4;
      const newBid = Math.min(max, _interactive.currentBid + inc);
      if (newBid > _interactive.currentBid) {
        _interactive.currentBid = newBid;
        _interactive.currentWinner = id;
        _interactive.bidLog.push({ owner: state.ownerName, bid: newBid, mine: false });
        if (_interactive.bidLog.length > 40) _interactive.bidLog.shift();
        _icEmit("BID", id, _interactive.current.name, newBid);   // cockpit mirror
        return state.ownerName;
      }
    }
  }
  return null;
}

// Step-wise bidding: ONE AI bump per tick (the price climbs visibly with a
// live "X bid $Y" feel), pausing whenever it becomes the user's turn to act.
//   (a) user is winning + no AI bumps  -> SOLD to user
//   (b) user passed   + no AI bumps    -> SOLD to current (AI) winner
//   (c) AI is winning + user can still act -> stop, start the user's timer
//   (d) AI bumped but user is winner/passed -> keep stepping after a beat
function _runAiBidsUntilUserTurn() {
  if (_interactive.phase !== "bidding") return;
  const me = getMyTeam();
  const bumpedBy = _aiBidsOnce();
  _fireChange();
  if (!bumpedBy) {
    // No AI wanted the lot at this price.
    if (_interactive.currentWinner === me?.id || _interactive.passedTeams.has(me?.id)) {
      _completeSale();
      return;
    }
    // AI is winning and the user hasn't acted -> their turn (or auto-pass if priced out).
    _giveUserTheClock();
    return;
  }
  // An AI just bumped.
  if (_interactive.currentWinner !== me?.id && !_interactive.passedTeams.has(me?.id)) {
    // The user is now outbid and still live -> their turn (or auto-pass if priced out).
    _giveUserTheClock();
    return;
  }
  // User is winning or has passed -> let the AI keep fighting, one beat at a time.
  // Snappier once the user has bowed out (they're just watching price discovery);
  // a touch slower while the user is still the high bidder and could be re-engaged.
  const delay = _interactive.passedTeams.has(me?.id) ? 150 : 550;
  _later(() => _runAiBidsUntilUserTurn(), _d(delay));
}

// Hand the user the decision — but if they literally can't outbid the current
// price (max affordable <= current bid, or roster full), auto-pass so they
// aren't prompted on lots they can't win. Keeps a fast draft moving.
function _giveUserTheClock() {
  const me = getMyTeam();
  const st = me ? _interactive.states[me.id] : null;
  const myMax = st ? (st.budget - Math.max(0, st.slotsRemaining - 1)) : 0;
  if (!st || st.slotsRemaining <= 0 || myMax <= _interactive.currentBid) {
    _later(() => userPass(), _d(180));   // priced out / roster full -> auto-pass
    return;
  }
  // Proxy / max-bid: if you've set an auto-bid cap, the engine bids for you.
  if (_interactive.proxyMax != null) {
    if (_interactive.proxyMax > _interactive.currentBid) {
      const inc = _interactive.currentBid < 12 ? 1 : _interactive.currentBid < 25 ? 2 : 3;
      const next = Math.min(_interactive.proxyMax, _interactive.currentBid + inc);
      _later(() => userBid(next), _d(200));   // step up toward your cap
      return;
    }
    // An AI passed your cap — you're out.
    _later(() => userPass(), _d(180));
    return;
  }
  _startMockTimer();
}

// User clicks "Bid +$X" or enters a specific amount.
function userBid(amount) {
  if (_icPaused()) return { ok: false, error: "Paused." };
  const me = getMyTeam();
  if (!me) return { ok: false, error: "No team" };
  if (_interactive.phase !== "bidding") return { ok: false, error: "Not bidding." };
  const myState = _interactive.states[me.id];
  if (myState.slotsRemaining <= 0) return { ok: false, error: "Your roster is full." };
  const maxAffordable = myState.budget - Math.max(0, myState.slotsRemaining - 1);
  const bid = Math.min(amount, maxAffordable);
  if (bid <= _interactive.currentBid) return { ok: false, error: "Bid must exceed $" + _interactive.currentBid };
  if (bid > maxAffordable) return { ok: false, error: "Max affordable: $" + maxAffordable };
  _clearMockTimer();
  _interactive.currentBid = bid;
  _interactive.currentWinner = me.id;
  _interactive.passedTeams.delete(me.id);   // re-enter if they'd passed earlier
  _interactive.bidLog.push({ owner: "You", bid, mine: true });
  if (_interactive.bidLog.length > 40) _interactive.bidLog.shift();
  _icEmit("BID", me.id, _interactive.current.name, bid);   // cockpit mirror
  _fireChange();
  _later(() => _runAiBidsUntilUserTurn(), _d(450));
  return { ok: true };
}

// User passes on current auction.
function userPass() {
  if (_icPaused()) return { ok: false, error: "Paused." };
  const me = getMyTeam();
  if (!me) return;
  if (_interactive.phase !== "bidding") return;
  _clearMockTimer();
  _interactive.passedTeams.add(me.id);
  _fireChange();
  _later(() => _runAiBidsUntilUserTurn(), _d(350));
}

function _completeSale() {
  if (!_interactive.current) return;
  _clearMockTimer();
  const winnerId = _interactive.currentWinner;
  const winner = _interactive.states[winnerId];
  const rawPrice = _interactive.currentBid;
  const winnerReserve = Math.max(0, winner.slotsRemaining - 1);
  const winnerMaxPrice = Math.max(1, winner.budget - winnerReserve);
  const price = Math.min(rawPrice, winnerMaxPrice);
  const player = _interactive.current;

  // Guard (parity with the headless engine): if the winner has no slot for this
  // player, void the sale rather than charge them / burn a slot for someone they
  // can't roster (only happens on an uncontested nomination of an unrosterable
  // player). Remove from pool and move on.
  // In cockpit mode we already emitted NOMINATION + bids for this lot, so it
  // MUST close with a SOLD or the hero would hang on it — proceed as a normal
  // sale (generic slot) rather than voiding, keeping engine ↔ cockpit in lockstep.
  const filledSlot = assignToSlot(winner.openSlots, player.elig || [player.posKey]);
  if (!filledSlot && !_interactive.cockpit) {
    _interactive.pool = _interactive.pool.filter(p => p.name !== player.name);
    _interactive.current = null; _interactive.currentBid = 0; _interactive.currentWinner = null;
    _interactive.passedTeams = new Set();
    _interactive.phase = "sold";
    _interactive.inflation = inflationForMockState(_interactive.states);
    _fireChange();
    _interactive.currentNominator++;
    _later(() => _advanceToNominatingTeam(), _d(500));
    return;
  }

  winner.budget = Math.max(0, winner.budget - price);
  winner.drafted.push({ name: player.name, pos: player.posKey, slot: filledSlot, price, value: player.value, type: player.type });
  winner.slotsByPos[filledSlot || player.posKey] = (winner.slotsByPos[filledSlot || player.posKey] || 0) + 1;
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
  _icEmit("SOLD", winnerId, player.name, price);   // cockpit mirror — closes the lot, adds the pick

  // Remove from pool
  _interactive.pool = _interactive.pool.filter(p => p.name !== player.name);
  _interactive.lastSale = {
    player: player.name, pos: player.posKey, price,
    owner: winner.ownerName, mine: !!winner.isMe,
    value: player.value,
  };
  _interactive.current = null;
  _interactive.currentBid = 0;
  _interactive.currentWinner = null;
  _interactive.passedTeams = new Set();
  _interactive.phase = "sold";
  _interactive.inflation = inflationForMockState(_interactive.states);
  _fireChange();
  // Advance to next nominator after a 5-second beat on the SOLD banner so you
  // can absorb who won and for how much. ("Instant" speed collapses it.)
  _interactive.currentNominator++;
  const dwell = _interactive.bidSpeed === "instant" ? 0 : 5000;
  _later(() => _advanceToNominatingTeam(), dwell);
}

// ---------------------------------------------------------------------------
// Flow controls for the interactive practice draft (Jeff: "there needs to be an
// option to pause, finish existing pick, skip 10 picks, skip to end").
//
// These are ENGINE-AWARE. The paused flag lives on _mockFeed.paused (single
// source of truth, read by _icPaused); the ENGINE is frozen by bumping
// _interactive.gen (kills scheduled bot steps + timer ticks) and clearing the
// timer. mock-live-feed.js's pauseMockFeed / resumeMockFeed route here for an
// interactive mock; the skip helpers are called from the skip-control delegation.

// Freeze everything: no scheduled bot step or timer tick can fire, and no
// user action (bid/pass/nominate) is accepted, until we resume.
function pauseInteractiveMock() {
  if (!_interactive.active) return;
  if (typeof _mockFeed !== "undefined") _mockFeed.paused = true;
  _interactive.gen++;    // invalidate every queued bot step + timer tick
  _clearMockTimer();
  _fireChange();
}

// Un-pause and restart the flow WHERE IT LEFT OFF. A beat later (real setTimeout
// in the browser; instant in tests) the appropriate driver runs: mid-lot →
// resume the bid ladder (which re-gives the user the clock if it's their turn);
// between lots → advance the nominator (auto-nominates for a bot, waits for you).
function resumeInteractiveMock() {
  if (!_interactive.active) return;
  if (typeof _mockFeed !== "undefined") _mockFeed.paused = false;
  _fireChange();
  if (_interactive.phase === "bidding") {
    _later(() => _runAiBidsUntilUserTurn(), _d(300));
  } else if (_interactive.phase === "nominating") {
    _later(() => _advanceToNominatingTeam(), _d(300));
  }
}

// True when the draft can't advance any further: every team's slots are full,
// or the pool is empty (nothing left to nominate).
function _icDraftDone() {
  if (_interactive.phase === "done") return true;
  if (!_interactive.pool.length) return true;
  return Object.keys(_interactive.states).every(id => _interactive.states[id].slotsRemaining <= 0);
}

// SYNCHRONOUSLY resolve the CURRENT pick — no _later delays (the sandbox stubs
// setTimeout to a no-op, and a skip must not consume wall-clock time). Advances
// the draft by exactly ONE lot:
//   • phase "nominating" (no lot open) → auto-nominate for whoever is up (bot
//     logic via chooseNomination, even on the user's turn), then resolve it;
//   • phase "bidding" (a lot is open) → apply _aiBidsOnce() until no bot bumps,
//     then _completeSale(). Standard auction rules: if the user leads and no bot
//     tops them, the user wins the lot.
// The user auto-passes any lot they DON'T currently lead (add them to
// passedTeams so an idle skip doesn't magically bid for them) — but a lot they
// DO lead resolves to them if unmatched. Returns true if a pick was made.
function _icFinishCurrentPick(userAutoPass) {
  if (!_interactive.active || _icDraftDone()) return false;
  _clearMockTimer();

  // Between lots: auto-nominate for the up team (bot logic), opening at $1.
  if (_interactive.phase !== "bidding" || !_interactive.current) {
    _advanceToNominatingTeam();   // skip past full teams, may flip to "done"
    if (_interactive.phase === "done") return false;
    const nomId = getCurrentNominatorId();
    const state = _interactive.states[nomId];
    if (!state || state.slotsRemaining <= 0) return false;
    const player = chooseNomination(state, _interactive.pool, _interactive.inflation);
    if (!player) { _interactive.phase = "done"; _fireChange(); return false; }
    _startAuction(player, nomId, 1);
  }
  if (_interactive.phase !== "bidding" || !_interactive.current) return false;

  // The user auto-passes lots they don't lead, so an idle skip never bids for
  // them — but never a lot they currently lead (that one can still resolve to
  // them). Skipping over the flag is opt-out via userAutoPass === false.
  const me = getMyTeam();
  if (userAutoPass !== false && me && _interactive.currentWinner !== me.id) {
    _interactive.passedTeams.add(me.id);
  }

  // Bot bid ladder, resolved synchronously: keep bumping until no bot tops.
  let guard = 0;
  while (guard++ < 500) {
    const bumped = _aiBidsOnce();
    if (!bumped) break;
  }
  _completeSale();   // schedules _advanceToNominatingTeam via _later (real setTimeout in the browser)
  return true;
}

// Skip N completed picks — loop "finish current pick" N times synchronously
// (no _later delays). Stops early if the draft ends. One full re-render after
// the burst (mirrors _mfFastForward's pumping flag so per-frame renders are
// suppressed during the loop). Returns the number of picks actually made.
function _icSkipPicks(n) {
  const target = Math.max(1, Math.min(2000, parseInt(n, 10) || 1));
  const wasPumping = (typeof _mockFeed !== "undefined") ? _mockFeed.pumping : false;
  if (typeof _mockFeed !== "undefined") _mockFeed.pumping = true;
  let made = 0;
  for (let i = 0; i < target; i++) {
    if (_icDraftDone()) break;
    if (!_icFinishCurrentPick(true)) break;
    made++;
  }
  if (typeof _mockFeed !== "undefined") _mockFeed.pumping = wasPumping;
  return made;
}

// Skip to the very end: resolve lots until every slot is full / the pool is
// empty, then freeze the finished draft (parity with endInteractiveCockpitMock)
// so the Save & clear / Debrief flow appears. Hard-capped against an infinite
// loop. Returns the number of picks made in the burst.
function _icSkipToEnd() {
  const wasPumping = (typeof _mockFeed !== "undefined") ? _mockFeed.pumping : false;
  if (typeof _mockFeed !== "undefined") _mockFeed.pumping = true;
  let made = 0, guard = 0;
  while (!_icDraftDone() && guard++ < 1000) {
    if (!_icFinishCurrentPick(true)) break;
    made++;
  }
  if (guard >= 1000) console.warn("_icSkipToEnd: hit the 1000-lot hard cap — stopping to avoid an infinite loop.");
  if (typeof _mockFeed !== "undefined") _mockFeed.pumping = wasPumping;
  // Freeze the finished draft: stop the engine and mark the feed finished so the
  // cockpit shows Save & clear / Debrief (same as endInteractiveCockpitMock).
  stopInteractiveMock();
  if (typeof _mockFeed !== "undefined") { _mockFeed.finished = true; _mockFeed.paused = false; }
  return made;
}

// Interactive inflation now uses the shared inflationForMockState() so the
// player-vs-AI sim matches the headless engine exactly (tail-trim + per-position
// scarcity included).
