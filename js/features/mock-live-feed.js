// UD-native mock → Live Draft feed.
//
// Runs Ultimate Draft's OWN auction engine (mock-engine.js — owner profiles
// decide WHO bids and how high) and pipes the result into the REAL Draft Mode
// cockpit by emitting the SAME event objects the Keeper Edge extension does:
// NOMINATION / BID / SOLD frames (with seq + `at` timestamps + teamId +
// playerId + amount) straight into `_onDraftEvents(msg)` and cumulative pick
// snapshots into `_applyDraftFeed(feed)`. There are ZERO new render paths — the
// hero, ticker, recommended bid, budgets, invariants, Supabase logging
// (is_mock=true), debrief and stream-key rotation all run exactly as they do
// for a live ESPN mock. The cockpit cannot tell it apart from ESPN.
//
// Two layers, cleanly separated:
//   • WHO / HOW MUCH  — mock-engine.js runMockDraft(): the engine's owner
//     profiles run a full auction and hand back the sales (winner + price per
//     lot). That IS the ground truth; the feed never invents a price.
//   • WHEN            — this file wraps each sale in a realistic bid trace and
//     inter-frame cadence MEASURED from the captured 198-lot ESPN mock of
//     2026-07-04 (see docs/live-draft-2027-plan.md): lots ~25s clock-driven
//     (p95 28s); bids/lot heavily bimodal (median 1, mean ~5.9) — which falls
//     out organically from cheap lots clearing in one bid and star wars taking
//     many; inter-bid median 0.56s / p95 4.5s (log-normal); increments median
//     $1 / mean $2.56 / p90 $6; ~2s between lots.
//
// Speed control (1× real / 4× / instant) scales only the WALL-CLOCK delays —
// event `at` stamps are always the real Date.now() at emit time, so the
// staleness gate / watchdog behave identically to a real feed. "instant" drives
// frames back-to-back (like test/simulate-draft.js) for a full run in seconds.
//
// Leaving/stopping cleans up its timers via the gen-guard pattern borrowed from
// mock-interactive.js (_interactive.gen): every scheduled step captures the
// current generation and no-ops if the generation has moved on.

const MOCK_FEED_LEAGUE_ID = 990001;   // synthetic mock league (never your real 1200)

const _mockFeed = {
  active: false,
  paused: false,
  gen: 0,                 // bumped on every start/pause/resume/stop/speed change
  speed: "4x",            // "1x" | "4x" | "instant"
  script: null,           // built frame list + ground-truth sales
  ctx: null,              // cumulative feed context (seq counter + picks)
  idx: 0,                 // next frame to emit
  startedAt: 0,
  soldLots: 0,
  lastEmitAt: 0,
  skipN: 10,              // how many picks the "skip N picks" control jumps
  pumping: false,         // true during a fast-forward burst — suppresses per-frame renders
  myEspnId: null,         // the mock's seat, in memory only (ephemeral)
  finished: false,        // reached the last lot (offer Save/Clear)
  reviewId: null,         // saved-mock currently expanded in the archive list
  interactive: false,     // true = YOU bid live against the bots (mock-interactive.js drives it); false = watch-only playback
};

// Real team id → synthetic ESPN id, and player name → synthetic playerId, for
// the interactive cockpit mock. Built once at start; read by _mockCockpitEmit.
let _icMaps = null;

function mockFeedActive() { return !!_mockFeed.active; }
// True when the running practice mock is the interactive (you-bid) kind.
function mockFeedInteractive() { return !!(_mockFeed.active && _mockFeed.interactive); }
// Reached the end of the draft (or the user ended it) — offer Save/Clear.
function mockFeedFinished() { return !!_mockFeed.finished; }
// Map an interactive-engine real team id → its synthetic ESPN id (for "Team N"
// labels in the cockpit); null outside an interactive mock.
function mockFeedEspnId(realTeamId) { return (_icMaps && _icMaps.teamMap) ? (_icMaps.teamMap[realTeamId] ?? null) : null; }
// True while a skip/fast-forward is emitting frames back-to-back. Render sites
// (updateDraftModeLive, processEspnPicks, feed-activity/diagnostics) skip during
// the burst; _mfFastForward renders ONCE after the picks settle — avoids a
// multi-second render storm and transient "SOLD with no pick" invariant flashes.
function mockFeedPumping() { return !!_mockFeed.pumping; }

// ---------------------------------------------------------------------------
// Cadence samplers (all Math.random-driven so a seeded RNG makes them
// deterministic in tests). Numbers fitted to the captured ESPN mock.

// Bid increment: median $1, mean ~$2.56, p90 ~$6.
function _mfSampleIncrement() {
  const r = Math.random();
  if (r < 0.52) return 1;   // R15 F1: P($1) must exceed .5 so the MEDIAN increment is $1 (ESPN-measured)
  if (r < 0.68) return 2;
  if (r < 0.80) return 3;
  if (r < 0.89) return 5;
  if (r < 0.94) return 6;
  if (r < 0.98) return 8;
  return 15;
}

// Inter-bid gap in ms: log-normal, median 0.56s, p95 ~4.5s.
function _mfSampleInterBid() {
  const u1 = Math.random() || 1e-9, u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const mu = Math.log(0.56), sigma = 1.26;   // exp(mu)=0.56; exp(mu+1.645σ)≈4.5
  let s = Math.exp(mu + sigma * z);
  s = Math.max(0.15, Math.min(20, s));
  return Math.round(s * 1000);
}

// Lot duration in ms: ESPN's clock dominates — ~25s nearly constant, p95 ~28s.
function _mfSampleLotDuration() {
  const r = Math.random();
  if (r < 0.90) return 25000;
  if (r < 0.97) return 25000 + Math.floor(Math.random() * 3000);   // 25–28s
  return 28000 + Math.floor(Math.random() * 4000);                 // 28–32s
}

// Gap between lots (~2s fixed with a touch of jitter).
function _mfSampleBetweenLots() { return 1800 + Math.floor(Math.random() * 600); }

// ---------------------------------------------------------------------------
// One lot's bid trace: an escalating ladder from $1 to the engine's clearing
// price, winner bidding last. The bidder mix is cosmetic (only the final
// winner + price matter to the recorded pick) so a challenger is chosen just to
// make the price climb realistically. Bid count scales with price + increment
// size, which is exactly what reproduces the bimodal bids/lot shape.
function _mfBidTrace(price, winnerEspn, nomEspn, allEspnIds) {
  const bids = [{ team: nomEspn, amount: 1 }];   // opening $1 by the nominator
  if (price <= 1) {
    // Uncontested — the engine makes the nominator the winner at $1; if a rare
    // engine edge disagrees, put the lone bid on the actual winner.
    if (winnerEspn !== nomEspn) bids[0] = { team: winnerEspn, amount: 1 };
    return bids;
  }
  // R15 F2: ESPN's bimodal shape — most CHEAP lots resolve in one or two bids
  // (nobody fights over a $2-4 player), while contested lots build a ladder.
  // UD's engine prices realistically (median ~$6 vs the ESPN mock room's $1),
  // so without this collapse almost no lot cleared in a single bid. Money math
  // untouched: the final price/winner are the engine's either way.
  if (price <= 3) {
    return [{ team: winnerEspn, amount: price }];
  }
  if (price <= 7 && Math.random() < 0.6) {
    const jump = 1 + Math.floor(Math.random() * (price - 1));
    return jump >= price
      ? [{ team: winnerEspn, amount: price }]
      : [{ team: nomEspn === winnerEspn && allEspnIds.length > 1 ? allEspnIds.find(id => id !== winnerEspn) : nomEspn, amount: jump }, { team: winnerEspn, amount: price }];
  }
  const challengers = allEspnIds.filter(id => id !== winnerEspn);
  let cur = 1, turn = 0, guard = 0;
  while (cur < price && guard++ < 300) {
    cur = Math.min(price, cur + _mfSampleIncrement());
    const isLast = cur >= price;
    const team = isLast ? winnerEspn : (challengers.length ? challengers[turn % challengers.length] : winnerEspn);
    bids.push({ team, amount: cur });
    turn++;
  }
  const last = bids[bids.length - 1];
  if (last.team !== winnerEspn || last.amount !== price) { last.team = winnerEspn; last.amount = price; }
  return bids;
}

// ---------------------------------------------------------------------------
// Build the full frame script from a single engine run. Pure: no timers, no
// DOM, no Date.now beyond stamping startedAt. Returns the frames (each with a
// `dt` = ms since the previous frame), the ground-truth sales, and the id↔name
// maps. This is where ALL cadence sampling lives, so a test can inspect the
// distributions directly.
function buildMockFeedScript(opts) {
  opts = opts || {};
  const values = (typeof getValues === "function") ? getValues() : [];
  if (!values.length) return null;

  // Real LEAGUE.teams → their REAL ESPN team ids (from ESPN_TEAM_ID_MAP in
  // espn.js). R11-reversal: the mock now runs Jeff's real league — real owners,
  // real keepers, real budgets. Feeding REAL ESPN ids (not generic 1..N) means
  // the pick pipeline (processEspnPicks / _applyDraftFeed) maps each SOLD back to
  // its real owner via espnTeamIdToOwnerId, and computeLiveTeamStates/inflation/
  // draftExcludedNames all read the real keeper-aware context (mockFeedActive()
  // is deliberately NO LONGER a draftTestMode() — see draft.js). A team missing
  // an ESPN id falls back to a synthetic id so the mock never drops a seat.
  const espnIdOf = (tid) => {
    if (typeof ESPN_TEAM_ID_MAP !== "undefined") {
      for (const [eid, oid] of Object.entries(ESPN_TEAM_ID_MAP)) if (oid === tid) return Number(eid);
    }
    return null;
  };
  const teamMap = {};                 // real team id → ESPN team id used in frames
  const espnToOwner = {};             // ESPN team id → real owner name (for _dmTeamLabel)
  let myEspnId = null, synthNext = 90;
  LEAGUE.teams.forEach((t) => {
    let eid = espnIdOf(t.id);
    if (eid == null) eid = synthNext++;   // no ESPN mapping — keep a distinct seat
    teamMap[t.id] = eid;
    espnToOwner[eid] = t.owner;
    if (t.isMe) myEspnId = eid;
  });
  if (myEspnId == null) myEspnId = teamMap[LEAGUE.teams[0].id];
  const allEspnIds = LEAGUE.teams.map((t) => teamMap[t.id]);

  // Player name → synthetic ESPN playerId (>1000 so the cockpit's lot filter
  // accepts it). Seeded into _espnIdToName so picks resolve without a fetch.
  const idByName = {}, nameById = {};
  values.forEach((p, i) => { const id = 900001 + i; idByName[p.name] = id; nameById[id] = p.name; });

  // The engine decides everything real: who nominates, who wins, the price.
  // Keepers ON (R11 reversed): the real predicted keepers fill slots + cost money,
  // so bot budgets/max-bids and the excluded pool match Jeff's real league.
  const result = (typeof runMockDraft === "function") ? runMockDraft(Object.assign({}, opts)) : { picks: [] };
  const enginePicks = result.picks || [];

  const startedAt = Date.now();
  const frames = [], sales = [];
  let lotSeq = 0;

  enginePicks.forEach((sale, li) => {
    const pid = idByName[sale.player];
    if (pid == null) return;
    const winnerEspn = teamMap[sale.winnerTeamId];
    const nomEspn = teamMap[sale.nominatorTeamId] != null ? teamMap[sale.nominatorTeamId] : winnerEspn;
    if (winnerEspn == null) return;
    const price = Math.max(1, Math.round(sale.price));
    lotSeq++;

    frames.push({ dt: li === 0 ? 0 : _mfSampleBetweenLots(), cmd: "NOMINATION", teamId: nomEspn, playerId: pid, amount: null });

    const trace = _mfBidTrace(price, winnerEspn, nomEspn, allEspnIds);
    const lotDur = _mfSampleLotDuration();
    let bidElapsed = 0;
    trace.forEach((b, bi) => {
      let dt = bi === 0 ? 300 : _mfSampleInterBid();
      if (bidElapsed + dt > lotDur - 1000) dt = Math.max(120, lotDur - 1000 - bidElapsed);
      bidElapsed += dt;
      frames.push({ dt, cmd: "BID", teamId: b.team, playerId: pid, amount: b.amount });
    });

    // SOLD lands ~lotDur after the nomination — ESPN's clock, not the last bid.
    frames.push({ dt: Math.max(500, lotDur - bidElapsed), cmd: "SOLD", teamId: winnerEspn, playerId: pid, amount: price });
    sales.push({ playerId: pid, teamId: winnerEspn, price, seq: lotSeq });
  });

  // Per-lot clearing info for the user-bid interrupt (item 3): the bots' known
  // clearing price + winner for each player. If the user tops the clearing price,
  // he wins; otherwise the scripted bot winner still takes it at that price.
  const clearingByPid = {};
  for (const s of sales) clearingByPid[s.playerId] = { price: s.price, winnerEspn: s.teamId };

  return {
    leagueId: MOCK_FEED_LEAGUE_ID, sport: "flb", startedAt, myEspnId,
    frames, sales, nameById, idByName, totalLots: sales.length,
    espnToOwner, clearingByPid,
  };
}

// ---------------------------------------------------------------------------
// Emit path — identical shapes to the extension bridge (draft-bridge.js). One
// cumulative feed context carries the running seq counter + pick list.
function _mfMakeContext(script) {
  return { leagueId: script.leagueId, sport: script.sport, startedAt: script.startedAt, seq: 0, picks: [] };
}

// Deliver ONE frame into the real pipeline with the given wall-clock stamp.
// NOMINATION/BID go to _onDraftEvents (the raw stream → hero/ticker/Supabase);
// SOLD additionally pushes a cumulative pick snapshot to _applyDraftFeed (the
// pick pipeline → processEspnPicks → the board).
// Returns the _applyDraftFeed promise for a SOLD frame (else null) so a
// fast-forward can await the async pick-adds before rendering.
function _mfApplyFrame(ctx, fr, at) {
  const seq = ++ctx.seq;
  const ev = { seq, at, cmd: fr.cmd, teamId: fr.teamId, playerId: fr.playerId, amount: fr.amount, text: "" };
  if (typeof _onDraftEvents === "function") {
    _onDraftEvents({ log: { leagueId: ctx.leagueId, sport: ctx.sport, startedAt: ctx.startedAt }, events: [ev], full: false });
  }
  if (fr.cmd === "SOLD") {
    ctx.picks.push({ playerId: fr.playerId, teamId: fr.teamId, price: fr.amount, seq, ts: at });
    if (typeof _applyDraftFeed === "function") {
      return _applyDraftFeed({ leagueId: ctx.leagueId, sport: ctx.sport, startedAt: ctx.startedAt, updatedAt: at, picks: ctx.picks.slice() });
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Arm the app for a mock (no scheduling): test mode + synthetic league so the
// cockpit runs generic Team-N / $260 / no keepers / full pool, a clean draft
// stream, seeded names, and my seat. Shared by startMockFeed and the test.
// Clear the IN-MEMORY draft view for the mock to write into. No disk writes —
// an ephemeral mock never persists (saveLiveDraft no-ops while it's active), so
// the real draft on disk is untouched and reloads when the mock is cleared.
function _mfResetDraftState() {
  if (typeof _liveDraft !== "undefined") {
    _liveDraft.picks = [];
    _liveDraft.deleted = {};
    _liveDraft.streamKey = null;
  }
  if (typeof _dlog !== "undefined") {
    _dlog.events = []; _dlog.leagueId = null; _dlog.startedAt = 0;
    _dlog.lastEventAt = 0; _dlog.initState = null;
  }
  if (typeof _feed !== "undefined") {
    _feed.staleInfo = null; _feed.staleRetained = null; _feed.connected = false; _feed.count = 0;
  }
}
// The mock's seat, held in memory (never persisted) — read by getMyDraftEspnId.
function mockFeedSeat() { return _mockFeed.myEspnId != null ? _mockFeed.myEspnId : null; }

// ESPN team id → real owner name for the running mock. Lets _dmTeamLabel print
// the real owner even for a team that has no ESPN_TEAM_ID_MAP entry (a synthetic
// seat). Null if the mock isn't running or the id isn't known.
function mockFeedOwnerName(espnId) {
  // Watch-mode carries the map on the script; the interactive cockpit mock
  // (script=null) carries it on _icMaps.
  const map = (_mockFeed.script && _mockFeed.script.espnToOwner) ||
    (_icMaps && _icMaps.espnToOwner) || null;
  if (!map) return null;
  const n = (typeof espnId === "string" && espnId.indexOf("espn:") === 0) ? Number(espnId.slice(5)) : Number(espnId);
  return map[n] || null;
}

function _mfSeedNames(nameById) {
  // draft.js owns the id→name map + a flag marking it mock-seeded, so Real mode
  // can drop it (a stale mock map otherwise makes a same-session real draft
  // record every pick as "Player <id>"). Seeding it makes _ensureEspnNames() a
  // no-op — no ESPN fetch — so synthetic picks resolve to real player names.
  if (typeof _seedMockEspnNames === "function") _seedMockEspnNames(nameById);
  else if (typeof _espnIdToName !== "undefined") _espnIdToName = Object.assign(_espnIdToName || {}, nameById);
}

function _mfArm(script) {
  // EPHEMERAL: no setFeedMode / setLeagueOverride / setMyDraftEspnId — nothing
  // is persisted. mockFeedActive() drives the test context (generic Team-N /
  // $260 / no keepers) in memory; the seat lives on _mockFeed.myEspnId.
  _mfResetDraftState();
  _mfSeedNames(script.nameById);
  _mockFeed.myEspnId = script.myEspnId;
  _mockFeed.script = script;
  _mockFeed.ctx = _mfMakeContext(script);
  _mockFeed.idx = 0;
  _mockFeed.startedAt = script.startedAt;
  _mockFeed.soldLots = 0;
}

// ---------------------------------------------------------------------------
// Playback (gen-guarded timers).
function _mfSpeedDelay(dt) {
  if (_mockFeed.speed === "instant") return 0;
  const factor = _mockFeed.speed === "4x" ? 4 : 1;
  return Math.max(0, Math.round((dt || 0) / factor));
}
function _mfLater(fn, ms) {
  const g = _mockFeed.gen;
  setTimeout(() => { if (_mockFeed.gen === g && _mockFeed.active && !_mockFeed.paused && !_mockFeed.finished) fn(); }, ms);
}
function _mfScheduleNext() {
  if (!_mockFeed.active || _mockFeed.paused || _mockFeed.finished || !_mockFeed.script) return;
  const frames = _mockFeed.script.frames;
  if (_mockFeed.idx >= frames.length) { _mfFinish(); return; }
  const fr = frames[_mockFeed.idx];
  _mfLater(() => {
    const at = (typeof Date !== "undefined" && Date.now) ? Date.now() : 0;
    _mfApplyFrame(_mockFeed.ctx, fr, at);
    if (fr.cmd === "SOLD") _mockFeed.soldLots++;
    _mockFeed.idx++;
    _mockFeed.lastEmitAt = at;
    _mfUpdateStatus();
    _mfScheduleNext();
  }, _mfSpeedDelay(fr.dt));
}
// Playback reached the last lot. The mock stays ACTIVE (ephemeral context holds,
// so saveLiveDraft keeps no-op'ing and the real draft on disk stays safe) until
// Jeff saves or clears it — we only mark it finished (offer Save/Clear).
function _mfFinish() {
  _mockFeed.finished = true;
  _mockFeed.paused = false;
  _mockFeed.gen++;
  if (typeof currentView !== "undefined" && currentView === "draft" && typeof renderDraft === "function") renderDraft();
}

function _mfRender() { if (typeof currentView !== "undefined" && currentView === "draft" && typeof renderDraft === "function") renderDraft(); }

function startMockFeed(opts) {
  opts = opts || {};
  const script = buildMockFeedScript(opts);
  if (!script || !script.frames.length) {
    if (typeof alert === "function") alert("No projections loaded — import values on the Data tab first, then start a practice mock.");
    return false;
  }
  if (opts.speed) _mockFeed.speed = opts.speed;
  // A mock is ephemeral + non-destructive: your real draft is safe on disk and
  // reloads when the mock is cleared, so no confirm is needed. Mark active BEFORE
  // arming so any save during setup no-ops.
  _mockFeed.active = true;
  _mockFeed.finished = false;
  _mockFeed.paused = false;
  _mockFeed.pumping = false;
  _mockFeed.gen++;
  _mfArm(script);
  // Item 2: jump straight into the cockpit. Switch to the Draft tab via the app's
  // real router (app.js) and turn on Draft Mode, so a Start from the Setup lobby
  // (or anywhere) lands the user in the fullscreen cockpit immediately. Both are
  // no-ops-if-already-there; setDraftMode(true) itself calls renderDraft().
  if (typeof switchView === "function" && (typeof currentView === "undefined" || currentView !== "draft")) switchView("draft");
  if (typeof setDraftMode === "function") setDraftMode(true);
  else _mfRender();
  _mfScheduleNext();
  return true;
}

// ---------------------------------------------------------------------------
// Interactive cockpit mock — YOU bid live against the bots inside the real
// Draft Mode cockpit. mock-interactive.js runs the auction lot-by-lot (bots
// nominate + bid; you nominate on your turn and bid/pass); every nomination,
// bid and sale is mirrored into the cockpit's ESPN-style event pipeline via
// _mockCockpitEmit, so the hero / ticker / budgets / standings / picks all
// update through the same paths a real ESPN feed drives. Self-paced: nothing
// advances until the current lot resolves and it's someone's turn.
function startInteractiveCockpitMock(opts) {
  opts = opts || {};
  const values = (typeof getValues === "function") ? getValues() : [];
  if (!values.length) {
    if (typeof alert === "function") alert("No projections loaded — import values on the Data tab first, then start a practice mock.");
    return false;
  }
  // REAL id maps (same scheme as the watch-mode feed, R11 reversed): real team
  // id → its REAL ESPN id, so the pick pipeline attributes every sale to the
  // real owner and the keeper-aware cockpit context (budgets/pool/inflation)
  // lines up. Player name → synthetic playerId > 1000.
  const espnIdOf = (tid) => {
    if (typeof ESPN_TEAM_ID_MAP !== "undefined") {
      for (const [eid, oid] of Object.entries(ESPN_TEAM_ID_MAP)) if (oid === tid) return Number(eid);
    }
    return null;
  };
  const teamMap = {}, espnToOwner = {};
  let myEspnId = null, synthNext = 90;
  LEAGUE.teams.forEach((t) => {
    let eid = espnIdOf(t.id);
    if (eid == null) eid = synthNext++;   // no ESPN mapping — keep a distinct seat
    teamMap[t.id] = eid;
    espnToOwner[eid] = t.owner;
    if (t.isMe) myEspnId = eid;
  });
  if (myEspnId == null) myEspnId = teamMap[LEAGUE.teams[0].id];
  const idByName = {}, nameById = {};
  values.forEach((p, i) => { const id = 900001 + i; idByName[p.name] = id; nameById[id] = p.name; });
  _icMaps = { teamMap, idByName, nameById, espnToOwner };
  _icLastKey = "";

  // Arm the ephemeral cockpit context (real owners / real keepers / real budgets).
  _mockFeed.active = true;
  _mockFeed.interactive = true;
  _mockFeed.finished = false;
  _mockFeed.paused = false;
  _mockFeed.pumping = false;
  _mockFeed.script = null;
  _mockFeed.soldLots = 0;
  _mockFeed.myEspnId = myEspnId;
  _mockFeed.gen++;
  _mfResetDraftState();
  _mfSeedNames(nameById);
  const startedAt = (typeof Date !== "undefined" && Date.now) ? Date.now() : 0;
  _mockFeed.ctx = { leagueId: MOCK_FEED_LEAGUE_ID, sport: "flb", startedAt, seq: 0, picks: [] };
  _mockFeed.startedAt = startedAt;

  if (opts.bidSpeed && typeof setMockBidSpeed === "function") setMockBidSpeed(opts.bidSpeed);
  // Start the live engine in cockpit mode. Keepers ON (item 6): kept players
  // (e.g. Nick Kurtz) are never nominable, and bot budgets/slots reflect their
  // real keeper costs — matching the keeper-aware cockpit context.
  const r = (typeof startInteractiveMock === "function") ? startInteractiveMock({ cockpit: true }) : { ok: false, error: "engine unavailable" };
  if (r && r.ok === false) {
    // Roll back so a failed start never leaves a half-live mock behind.
    _mockFeed.active = false; _mockFeed.interactive = false; _icMaps = null;
    if (typeof alert === "function") alert(r.error || "Couldn't start the mock.");
    return false;
  }
  if (typeof switchView === "function" && (typeof currentView === "undefined" || currentView !== "draft")) switchView("draft");
  if (typeof setDraftMode === "function") setDraftMode(true);
  else _mfRender();
  return true;
}

// Mirror one interactive-engine event (real team id + player NAME) into the
// cockpit's ESPN-style pipeline — same shape as _mfApplyFrame's watch-mode path,
// so the cockpit can't tell it from a real feed. Called by _icEmit in
// mock-interactive.js.
function _mockCockpitEmit(cmd, realTeamId, playerName, amount) {
  if (!_mockFeed.active || !_mockFeed.interactive || !_icMaps || !_mockFeed.ctx) return;
  const teamId = _icMaps.teamMap[realTeamId];
  const playerId = _icMaps.idByName[playerName];
  if (teamId == null || playerId == null) return;
  const at = (typeof Date !== "undefined" && Date.now) ? Date.now() : 0;
  const seq = ++_mockFeed.ctx.seq;
  const amt = (amount == null) ? null : amount;
  const ev = { seq, at, cmd, teamId, playerId, amount: amt, text: "" };
  if (typeof _onDraftEvents === "function") {
    _onDraftEvents({ log: { leagueId: _mockFeed.ctx.leagueId, sport: _mockFeed.ctx.sport, startedAt: _mockFeed.ctx.startedAt }, events: [ev], full: false });
  }
  if (cmd === "SOLD") {
    _mockFeed.ctx.picks.push({ playerId, teamId, price: amt, seq, ts: at });
    _mockFeed.soldLots++;
    if (typeof _applyDraftFeed === "function") {
      _applyDraftFeed({ leagueId: _mockFeed.ctx.leagueId, sport: _mockFeed.ctx.sport, startedAt: _mockFeed.ctx.startedAt, updatedAt: at, picks: _mockFeed.ctx.picks.slice() });
    }
  }
  _mfUpdateStatus();
}

// End the interactive mock (stop the engine) but KEEP the result on screen so
// Jeff can Save or Clear it (parity with the watch-mode stopMockFeed).
function endInteractiveCockpitMock() {
  if (!_mockFeed.active || !_mockFeed.interactive) return;
  if (typeof stopInteractiveMock === "function") stopInteractiveMock();
  _mockFeed.finished = true;
  _mockFeed.paused = false;
  _mfRender();
}

// Refresh the cockpit for interactive states that emit NO frame: your nominate
// turn (show the nominate box), a pass (disable your bid controls), the draft
// finishing. Bid/nomination/sale updates ride the emitted frames (→
// updateDraftModeLive), so we full-render only on a lot / phase / turn boundary
// — never on a plain bot bid, so a half-typed bid can't be interrupted.
let _icLastKey = "";
function _icCockpitRefresh(s) {
  const me = (typeof getMyTeam === "function") ? getMyTeam() : null;
  const iPassed = !!(me && s.passedTeams && s.passedTeams.has(me.id));
  // Per-second countdown: timer ticks fire a change but must NOT full-render
  // (that would steal a half-typed bid) — patch the clock text in place.
  const clk = (typeof document !== "undefined") ? document.getElementById("dm-icclock") : null;
  if (clk) {
    const winner = me && s.currentWinner === me.id;
    clk.textContent = (s.phase === "bidding" && s.useTimer && !winner && !iPassed && s.secondsLeft > 0) ? ("⏱ " + s.secondsLeft + "s") : "";
    clk.style.color = s.secondsLeft <= 4 ? "var(--bad)" : "var(--warn)";
  }
  const key = [s.phase, s.currentNominator, s.current ? s.current.name : "", iPassed ? "P" : "", s.picks.length, _mockFeed.finished ? "F" : ""].join("|");
  if (key === _icLastKey) return;
  _icLastKey = key;
  if (typeof renderDraft === "function") renderDraft();
}
function pauseMockFeed() {
  if (!_mockFeed.active || _mockFeed.finished || _mockFeed.paused) return;
  // Interactive practice draft: freeze the live auction engine (bots + timer),
  // not the scripted watch-mode playback.
  if (_mockFeed.interactive) {
    if (typeof pauseInteractiveMock === "function") pauseInteractiveMock();
    _mfRender();
    return;
  }
  _mockFeed.paused = true;
  _mockFeed.gen++;   // invalidate the in-flight timer
  _mfRender();
}
function resumeMockFeed() {
  if (!_mockFeed.active || _mockFeed.finished || !_mockFeed.paused) return;
  if (_mockFeed.interactive) {
    if (typeof resumeInteractiveMock === "function") resumeInteractiveMock();
    _mfRender();
    return;
  }
  _mockFeed.paused = false;
  _mockFeed.gen++;
  _mfRender();
  _mfScheduleNext();
}

// ---------------------------------------------------------------------------
// Interactive flow controls — public wrappers the skip-control delegation calls.
// Each drives the live auction engine (mock-interactive.js) synchronously, then
// does ONE full re-render (the engine's own onInteractiveChange render is
// suppressed during the burst via _mockFeed.pumping). No-ops for watch mode /
// no interactive mock.
function finishInteractivePick() {
  if (!_mockFeed.active || !_mockFeed.interactive || _mockFeed.finished || _mockFeed.paused) return;
  if (typeof _icFinishCurrentPick === "function") _icFinishCurrentPick(false);   // Your Call: don't auto-pass a single "finish this pick"
  _icLastKey = "";   // force the guarded refresh to re-render
  _mfRender();
}
function skipInteractivePicks(n) {
  if (!_mockFeed.active || !_mockFeed.interactive || _mockFeed.finished || _mockFeed.paused) return;
  if (typeof _icSkipPicks === "function") _icSkipPicks(n);
  _icLastKey = "";
  _mfRender();
}
function skipInteractiveToEnd() {
  if (!_mockFeed.active || !_mockFeed.interactive || _mockFeed.finished || _mockFeed.paused) return;
  if (typeof _icSkipToEnd === "function") _icSkipToEnd();
  _icLastKey = "";
  _mfRender();
}
// "Stop" ends playback but KEEPS the result on screen (active) so Jeff can Save
// or Clear it — it does not tear down the ephemeral context (that would let a
// later save write the mock picks to the real key).
function stopMockFeed(opts) {
  opts = opts || {};
  if (!_mockFeed.active) return;
  _mockFeed.finished = true;
  _mockFeed.paused = false;
  _mockFeed.pumping = false;
  _mockFeed.gen++;   // kill any scheduled step
  if (!opts.silent) _mfRender();
}

// Tear down the ephemeral mock entirely and restore the REAL draft from disk.
// This is the ONLY place `active` goes false — up to here every save has no-op'd,
// so the real draft in localStorage is exactly as Jeff left it.
function clearMockDraft() {
  if (_mockFeed.interactive && typeof stopInteractiveMock === "function") stopInteractiveMock();   // kill the live auction engine
  _mockFeed.active = false;
  _mockFeed.finished = false;
  _mockFeed.paused = false;
  _mockFeed.pumping = false;
  _mockFeed.interactive = false;
  _icMaps = null; _icLastKey = "";
  _mockFeed.gen++;
  _mockFeed.script = null; _mockFeed.ctx = null; _mockFeed.idx = 0; _mockFeed.soldLots = 0; _mockFeed.myEspnId = null;
  if (typeof _liveDraft !== "undefined") { _liveDraft.picks = []; _liveDraft.deleted = {}; _liveDraft.streamKey = null; }
  if (typeof _dlog !== "undefined") { _dlog.events = []; _dlog.leagueId = null; _dlog.startedAt = 0; _dlog.lastEventAt = 0; _dlog.initState = null; }
  if (typeof _feed !== "undefined") { _feed.connected = false; _feed.count = 0; _feed.staleInfo = null; _feed.staleRetained = null; }
  if (typeof _clearMockEspnNames === "function") _clearMockEspnNames();   // drop in-memory mock names so a real draft fetches real ones
  if (typeof loadLiveDraft === "function") loadLiveDraft();               // mockFeedActive() now false → restores the real draft
  _mfRender();
}

// Snapshot the finished mock into the shared "Saved mocks" archive (device-local,
// reusing the Mock Draft tab's store + review UI), so Jeff can look back at the
// result after the working slate is wiped.
function saveMockToArchive(label) {
  if (typeof getSavedMocks !== "function" || typeof computeMockStandings !== "function" || typeof _writeSavedMocks !== "function") return null;
  const teams = (typeof draftTeams === "function") ? draftTeams() : [];
  const states = {};
  for (const t of teams) states[t.id] = { teamId: t.id, ownerName: t.owner, isMe: !!t.isMe, kept: [], drafted: [] };
  for (const pk of (_liveDraft.picks || [])) {
    const id = pk.team;
    if (!states[id]) states[id] = { teamId: id, ownerName: (typeof draftTeamLabel === "function" ? draftTeamLabel(id) : String(id)), isMe: false, kept: [], drafted: [] };
    const pv = (typeof getPlayerValue === "function") ? getPlayerValue(pk.player) : null;
    states[id].drafted.push({ name: pk.player, pos: pk.pos || (pv ? pv.posKey : "?"), price: pk.price || 0, value: pv ? pv.value : 0 });
  }
  const st = computeMockStandings(states);
  const mine = st.teams.find(t => t.isMe);
  const tm = Object.values(states).find(x => x.isMe);
  const rec = {
    id: "mf" + Date.now(), ts: Date.now(),
    label: label || ("Practice mock — " + new Date().toLocaleDateString() + " " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })),
    anyData: st.anyData,
    grade: (mine && typeof _mockGrade === "function") ? _mockGrade(mine.rank, st.N) : "—",
    myRank: mine ? mine.rank : null, n: st.N, picks: (_liveDraft.picks || []).length,
    standings: st.teams.map(t => ({ owner: t.owner, isMe: t.isMe, rank: t.rank, rotoPoints: Math.round((t.rotoPoints || 0) * 10) / 10, rosterValue: Math.round(t.rosterValue || 0), spent: t.spent || 0 })),
    myRoster: tm ? tm.drafted.map(d => ({ name: d.name, pos: d.pos, price: d.price, value: d.value })) : [],
  };
  const l = getSavedMocks(); l.unshift(rec); while (l.length > 20) l.pop();
  _writeSavedMocks(l);
  return rec.id;
}
function saveAndClearMock() { const id = saveMockToArchive(); clearMockDraft(); return id; }
function setMockFeedSpeed(s) {
  if (s !== "1x" && s !== "4x" && s !== "instant") return;
  _mockFeed.speed = s;
  // Don't resume a stopped/finished mock (finished!=paused) — matches pause/resume.
  if (_mockFeed.active && !_mockFeed.paused && !_mockFeed.finished) { _mockFeed.gen++; _mfScheduleNext(); }
  _mfUpdateStatus();
  // Re-render so the segmented control's highlight matches the active speed
  // (the buttons are static HTML; without this the selection lags — R11).
  if (typeof currentView !== "undefined" && currentView === "draft" && typeof renderDraft === "function") renderDraft();
}
function getMockFeedSpeed() { return _mockFeed.speed; }

// ---------------------------------------------------------------------------
// Fast-forward — emit pending frames back-to-back (no delays, ignoring speed)
// through the SAME real pipeline, then resume normal playback where we landed.
// Used by the skip controls.
function _mfPump(stopAfter, promises) {
  const s = _mockFeed.script;
  if (!s || !_mockFeed.ctx) return true;
  let solds = 0;
  while (_mockFeed.idx < s.frames.length) {
    const fr = s.frames[_mockFeed.idx];
    const at = (typeof Date !== "undefined" && Date.now) ? Date.now() : 0;
    const p = _mfApplyFrame(_mockFeed.ctx, fr, at);
    if (promises && p && typeof p.then === "function") promises.push(p);
    _mockFeed.idx++;
    _mockFeed.lastEmitAt = at;
    if (fr.cmd === "SOLD") { _mockFeed.soldLots++; solds++; }
    if (stopAfter && stopAfter(fr, solds)) break;
  }
  return _mockFeed.idx >= s.frames.length;
}
async function _mfFastForward(stopAfter) {
  if (!_mockFeed.active || !_mockFeed.script) return;
  _mockFeed.gen++;                          // cancel any in-flight scheduled step
  const myGen = _mockFeed.gen;
  _mockFeed.pumping = true;                 // suppress per-frame renders during the burst
  const promises = [];
  const done = _mfPump(stopAfter, promises);
  // Wait for the async pick-adds (_applyDraftFeed → processEspnPicks) to settle,
  // THEN render once — so the cockpit rebuilds a single time and the invariants
  // panel never flashes transient "SOLD with no matching pick" warnings.
  try { await Promise.all(promises); } catch (e) {}
  _mockFeed.pumping = false;                // transient burst flag — always clear
  if (_mockFeed.gen !== myGen) return;      // a pause/stop/re-skip mid-await now owns rendering
  _mfUpdateStatus();
  if (done) { _mfFinish(); return; }        // reached the end → land on the final board
  if (typeof currentView !== "undefined" && currentView === "draft" && typeof renderDraft === "function") renderDraft();
  if (!_mockFeed.paused) _mfScheduleNext(); // resume live playback from the new spot
}
// Speed through the rest of the current lot (resolve this nomination now).
function skipMockNomination() { _mfFastForward((fr, solds) => solds >= 1); }
// Jump forward N completed picks (default _mockFeed.skipN).
function skipMockPicks(n) {
  const target = Math.max(1, Math.min(2000, parseInt(n, 10) || _mockFeed.skipN || 10));
  _mockFeed.skipN = target;
  _mfFastForward((fr, solds) => solds >= target);
}
// Jump straight to the end of the draft (full board + Debrief ready).
function skipMockToEnd() { _mfFastForward(() => false); }

// ---------------------------------------------------------------------------
// User bid interrupt (item 3). In a real ESPN draft Jeff bids on ESPN; in a
// practice mock there's no ESPN, so the cockpit gives him in-app bid buttons.
// A bid on the CURRENT lot cancels that lot's remaining SCRIPTED frames, emits
// the user's BID, then RE-RESOLVES the lot against the bots' known clearing
// price for that player:
//   • user's bid > clearing price → the user tops the room and WINS at his bid;
//   • otherwise the scripted bot winner still takes it at the clearing price.
// Then normal playback resumes at the NEXT lot. Everything flows through the
// same _mfApplyFrame/event path the bots use, so the hero/ticker/board update
// identically and nothing touches the real draft on disk (ephemeral + gen-guard).

// Most this seat can bid right now, from the same live team-state the cockpit
// shows (keeper-aware, budget-conserving). Falls back to the league budget.
function _mfSeatMaxBid() {
  try {
    const me = (typeof getMyDraftTeam === "function") ? getMyDraftTeam() : (typeof getMyTeam === "function" ? getMyTeam() : null);
    if (me && typeof computeLiveTeamStates === "function") {
      const st = computeLiveTeamStates()[me.id];
      if (st && isFinite(st.maxBid)) return Math.max(1, st.maxBid);
    }
  } catch (e) {}
  return (typeof LEAGUE !== "undefined" && LEAGUE.draftBudget) ? LEAGUE.draftBudget : 260;
}

// Advance _mockFeed.idx past every remaining frame of the given lot (the run of
// frames sharing playerId, up to and INCLUDING its SOLD). Returns the scripted
// SOLD frame that was skipped (for the clearing price/winner), or null.
function _mfConsumeLotFrames(pid) {
  const frames = _mockFeed.script.frames;
  let soldFrame = null;
  while (_mockFeed.idx < frames.length) {
    const fr = frames[_mockFeed.idx];
    if (fr.playerId !== pid) break;           // reached the next lot's NOMINATION
    _mockFeed.idx++;
    if (fr.cmd === "SOLD") { soldFrame = fr; break; }
  }
  return soldFrame;
}

function userMockBid(amount) {
  if (!_mockFeed.active || _mockFeed.paused || _mockFeed.finished || !_mockFeed.script || !_mockFeed.ctx) return false;
  const seat = mockFeedSeat();
  if (seat == null) return false;
  const lot = (typeof currentLotFromEvents === "function") ? currentLotFromEvents() : null;
  if (!lot || lot.playerId == null) return false;
  const pid = lot.playerId;

  // Clamp: at least a legal raise over the current high, at most the seat's max.
  const high = Number.isFinite(lot.highBid) ? lot.highBid : 1;
  const seatMax = _mfSeatMaxBid();
  let bid = Math.max(high + 1, Math.floor(Number(amount) || 0));
  bid = Math.min(bid, seatMax);
  if (bid <= high) return false;              // can't afford even one over the room

  // Take ownership of the timeline: cancel any in-flight scheduled step and the
  // rest of THIS lot's scripted frames, so the bots' pre-scripted climb/SOLD for
  // this player can't override the user's interrupt.
  _mockFeed.gen++;
  const scriptedSold = _mfConsumeLotFrames(pid);
  const clearing = (_mockFeed.script.clearingByPid && _mockFeed.script.clearingByPid[pid]) ||
    (scriptedSold ? { price: scriptedSold.amount, winnerEspn: scriptedSold.teamId } : { price: high, winnerEspn: seat });

  const at = (typeof Date !== "undefined" && Date.now) ? Date.now() : 0;
  // The user's bid, through the same path a bot bid uses.
  _mfApplyFrame(_mockFeed.ctx, { cmd: "BID", teamId: seat, playerId: pid, amount: bid }, at);
  _mockFeed.lastEmitAt = at;

  // Re-resolve the winner. The clearing price is the bots' top; if the user beats
  // it he wins at his own bid, else the scripted bot winner takes it at clearing.
  let sold;
  if (bid > clearing.price) {
    sold = { cmd: "SOLD", teamId: seat, playerId: pid, amount: bid };
  } else {
    sold = { cmd: "SOLD", teamId: clearing.winnerEspn, playerId: pid, amount: Math.max(1, clearing.price) };
  }
  const p = _mfApplyFrame(_mockFeed.ctx, sold, at);
  _mockFeed.soldLots++;
  _mockFeed.lastEmitAt = at;

  // Render + resume live playback at the next lot once the pick-add settles.
  Promise.resolve(p).then(() => {
    _mfUpdateStatus();
    if (typeof currentView !== "undefined" && currentView === "draft" && typeof renderDraft === "function") renderDraft();
    if (_mockFeed.active && !_mockFeed.paused && !_mockFeed.finished) {
      if (_mockFeed.idx >= _mockFeed.script.frames.length) _mfFinish();
      else _mfScheduleNext();
    }
  }).catch(() => {});
  return true;
}

// ---------------------------------------------------------------------------
// UI — one card on the Draft Setup lobby, a compact cluster mirrored in the
// Draft Mode top bar. Buttons wired once via document-level delegation (they
// survive the innerHTML rebuilds of both views).
function _mfSpentSoFar() {
  return (_mockFeed.ctx && _mockFeed.ctx.picks) ? _mockFeed.ctx.picks.reduce((s, p) => s + (p.price || 0), 0) : 0;
}
function _mfStatusText() {
  if (!_mockFeed.active) return "Idle — press Start to draft live against the bots. You bid; they bid back. It's a throwaway rehearsal — your real draft is never touched.";
  if (_mockFeed.interactive) {
    const done = _mockFeed.soldLots;
    if (_mockFeed.finished) return "✓ Done — " + done + " picks. Open <b>Debrief</b> to review, then <b>Save &amp; clear</b> (keeps the result in your mocks list) or <b>Clear</b> to wipe the slate.";
    return "● Live draft — <b>" + done + "</b> picks in · $" + _mfSpentSoFar() + " spent. Nominate on your turn; bid or pass from Your Call.";
  }
  const s = _mockFeed.script;
  if (!s) return "Idle — press Start to run a full auction against the bots.";
  const total = s.totalLots, done = _mockFeed.soldLots;
  if (_mockFeed.finished) {
    return "✓ Done — " + done + " lots. Open <b>Debrief</b> to review, then <b>Save &amp; clear</b> (keeps the result in your mocks list) or <b>Clear</b> to wipe the slate.";
  }
  return (_mockFeed.paused ? "⏸ Paused" : "● Running") + " — lot <b>" + done + "</b> / " + total +
    " · $" + _mfSpentSoFar() + " spent · " + esc(_mockFeed.speed);
}

// Bot pacing selector for the interactive mock (how fast the AI bids between
// your turns). Maps to the interactive engine's bidSpeed.
function _mfBotSpeedSeg() {
  const cur = (typeof getInteractiveState === "function") ? (getInteractiveState().bidSpeed || "realistic") : "realistic";
  const seg = (val, label) => '<button class="btn' + (cur === val ? ' primary' : ' ghost') +
    '" data-mockbotspeed="' + val + '" style="border-radius:0; padding:3px 10px;">' + label + '</button>';
  return '<span class="muted small" style="margin-right:4px;">bots</span><span class="seg" style="display:inline-flex; border:1px solid var(--border); border-radius:6px; overflow:hidden;">' +
    seg("realistic", "Realistic") + seg("fast", "Fast") + '</span>';
}
function _mfUpdateStatus() {
  const el = (typeof document !== "undefined") ? document.getElementById("mf-status") : null;
  if (el) el.innerHTML = _mfStatusText();
  const cmp = (typeof document !== "undefined") ? document.getElementById("mf-status-compact") : null;
  if (cmp && _mockFeed.script) cmp.textContent = _mockFeed.soldLots + "/" + _mockFeed.script.totalLots;
}

function _mfSpeedSeg() {
  const seg = (val, label) => '<button class="btn' + (_mockFeed.speed === val ? ' primary' : ' ghost') +
    '" data-mockspeed="' + val + '" style="border-radius:0; padding:3px 10px;">' + label + '</button>';
  return '<span class="seg" style="display:inline-flex; border:1px solid var(--border); border-radius:6px; overflow:hidden;">' +
    seg("1x", "1×") + seg("4x", "4×") + seg("instant", "Instant") + '</span>';
}

// Fast-forward buttons — only while a mock is RUNNING (hidden when paused so a
// paused feed can't emit picks behind a "⏸ Paused" label). Preset skip-counts
// (not a free-type input, which a per-pick re-render would steal focus from).
function _mfSkipControls(compact) {
  if (!_mockFeed.active || _mockFeed.paused || _mockFeed.finished) return "";
  const pad = compact ? "3px 8px" : "5px 10px";
  const ff = (act, label) => '<button class="btn ghost" data-mockfeed="' + act + '" style="width:auto; padding:' + pad + ';">' + label + '</button>';
  const sk = (n) => '<button class="btn ghost" data-mockskip="' + n + '" style="width:auto; padding:' + pad + ';">⏭ ' + n + '</button>';
  // Interactive practice draft: the same flow controls, routed to the live
  // engine. "⏭ Pick" finishes the current pick; presets skip N; "⏭⏭ To end"
  // fast-forwards the rest of the draft.
  if (_mockFeed.interactive) {
    const presets = compact ? [5, 10, 25] : [5, 10, 25];
    return ff("skipnom", "⏭ Pick") + presets.map(sk).join("") + ff("skipend", "⏭⏭ To end");
  }
  const presets = compact ? [10, 25] : [5, 10, 25, 50];
  return ff("skipnom", "⏭ Lot") + presets.map(sk).join("") + ff("skipend", "⏭⏭ To end");
}

// compact=true → an inline cluster for the Draft Mode top bar.
function renderMockFeedControls(compact) {
  const active = _mockFeed.active, paused = _mockFeed.paused, finished = _mockFeed.finished;
  const interactive = _mockFeed.interactive;
  const btn = (act, label, cls) => '<button class="btn ' + (cls || "ghost") + '" data-mockfeed="' + act +
    '" style="width:auto; padding:' + (compact ? "3px 10px" : "6px 14px") + ';">' + label + '</button>';

  // A mock is ephemeral + non-destructive, so Start is always available (even in
  // Real mode — the real draft is safe on disk and reloads when the mock clears).
  let controls = "";
  if (!active) {
    controls += btn("start", (compact ? "🤖 Practice" : "🤖 Start practice draft"), "primary");
  } else if (finished) {
    controls += btn("saveclear", (compact ? "💾 Save" : "💾 Save & clear"), "primary");
    controls += btn("clear", (compact ? "🗑 Clear" : "🗑 Clear (discard)"));
    controls += btn("start", (compact ? "🔄" : "🔄 New draft"));
  } else if (interactive) {
    // Interactive practice draft: engine-aware Pause/Resume + End.
    controls += paused ? btn("resume", "▶ Resume", "primary") : btn("pause", "⏸ Pause");
    controls += btn("stop", (compact ? "■ End" : "■ End practice draft"), "ghost");
  } else {
    // watch-only playback (legacy / direct startMockFeed)
    controls += paused ? btn("resume", "▶ Resume", "primary") : btn("pause", "⏸ Pause");
    controls += btn("stop", "■ Stop");
  }

  // Interactive → bot-pacing selector; watch mode → playback-speed segment.
  const speedSeg = finished ? "" : (interactive || !active ? _mfBotSpeedSeg() : _mfSpeedSeg());
  if (compact) {
    let s = '<span class="small" style="display:inline-flex; gap:6px; align-items:center; flex-wrap:wrap;">';
    if (active) s += '<span class="muted">🤖 mock <b id="mf-status-compact">' + _mockFeed.soldLots + (interactive ? '' : '/' + (_mockFeed.script ? _mockFeed.script.totalLots : 0)) + '</b></span>';
    s += controls + (active ? _mfSkipControls(true) : "") + speedSeg + '</span>';
    return s;
  }

  let html = '<div class="card">';
  html += '<div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">';
  html += '<h3 style="margin:0;">🤖 Practice draft vs bots</h3>';
  html += '<span class="muted small">You bid live against UD\'s own auction engine — no ESPN tab needed</span>';
  html += '<span style="flex:1;"></span>';
  html += speedSeg;
  html += controls;
  html += '</div>';
  if (active) html += '<div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-top:8px;">' + _mfSkipControls(false) + '</div>';
  html += '<p class="muted small" style="margin:6px 0 0;">Start jumps you into the cockpit and the draft begins. Bots nominate and bid using each owner\'s tendencies; <b>you nominate on your turn and bid or pass from Your Call</b>. Nothing advances until the lot resolves — hero, ticker, budgets, projected standings and Debrief all run live.</p>';
  html += '<div class="small" id="mf-status" style="margin-top:6px;">' + _mfStatusText() + '</div>';
  html += '</div>';
  return html;
}

// Top-bar hook used by draft-mode.js _dmTopBar.
function _mfTopbarHtml() { return renderMockFeedControls(true); }

// "Saved mocks" archive card for the Draft Setup lobby. Reuses the Mock Draft
// tab's store (getSavedMocks) + review renderer (renderSavedReview) so practice
// and interactive mocks share one list.
function renderMockArchive() {
  if (typeof getSavedMocks !== "function") return "";
  const list = getSavedMocks();
  if (!list.length) return "";
  const gc = (typeof _gradeColor === "function") ? _gradeColor : () => "inherit";
  const ord = (typeof _ord === "function") ? _ord : (n) => String(n);
  let html = '<div class="card"><h3 style="margin:0 0 6px;">📋 Saved mocks (' + list.length + ')</h3>';
  html += '<p class="muted small" style="margin:0 0 6px;">Results from finished practice mocks (and the Mock Draft tab). The working slate is wiped after each — these are the keepsakes.</p>';
  html += '<table style="font-size:12px;"><tbody>';
  for (const m of list) {
    const grade = m.grade || "—";
    html += '<tr><td><b>' + esc(m.label) + '</b></td>';
    html += '<td class="num" style="color:' + gc(grade) + ';">' + esc(grade) + '</td>';
    html += '<td class="num dim">' + (m.myRank ? ord(m.myRank) + '/' + m.n : "—") + '</td>';
    html += '<td><button class="btn ghost" data-mockarchive="review:' + esc(m.id) + '" style="width:auto; padding:2px 10px; font-size:11px;">Review</button> ';
    html += '<button class="btn ghost" data-mockarchive="del:' + esc(m.id) + '" style="width:auto; padding:2px 8px; font-size:11px; color:var(--bad);">✕</button></td></tr>';
  }
  html += '</tbody></table>';
  if (_mockFeed.reviewId && typeof renderSavedReview === "function") {
    const rec = list.find(m => m.id === _mockFeed.reviewId);
    if (rec) html += renderSavedReview(rec);
  }
  html += '</div>';
  return html;
}

if (typeof document !== "undefined" && document.addEventListener) {
  document.addEventListener("click", (e) => {
    const t = e.target && e.target.closest ? e.target.closest("[data-mockfeed],[data-mockspeed],[data-mockskip],[data-mockbotspeed],[data-mockarchive],#im-review-close") : null;
    if (!t || !t.closest || !t.closest("#view-root")) return;
    if (t.id === "im-review-close") { _mockFeed.reviewId = null; _mfRender(); return; }
    if (t.dataset.mockarchive) {
      const s = String(t.dataset.mockarchive), i = s.indexOf(":"), act = s.slice(0, i), id = s.slice(i + 1);
      if (act === "review") _mockFeed.reviewId = (_mockFeed.reviewId === id ? null : id);
      else if (act === "del") { if (typeof deleteSavedMock === "function") deleteSavedMock(id); if (_mockFeed.reviewId === id) _mockFeed.reviewId = null; }
      _mfRender();
      return;
    }
    if (t.dataset.mockfeed) {
      const a = t.dataset.mockfeed;
      // "start" now launches the INTERACTIVE cockpit mock (you bid vs the bots).
      if (a === "start") startInteractiveCockpitMock();
      else if (a === "pause") pauseMockFeed();
      else if (a === "resume") resumeMockFeed();
      else if (a === "stop") { if (_mockFeed.interactive) endInteractiveCockpitMock(); else stopMockFeed(); }
      else if (a === "saveclear") saveAndClearMock();
      else if (a === "clear") clearMockDraft();
      else if (a === "skipnom") { if (_mockFeed.interactive) finishInteractivePick(); else skipMockNomination(); }
      else if (a === "skipend") { if (_mockFeed.interactive) skipInteractiveToEnd(); else skipMockToEnd(); }
    } else if (t.dataset.mockskip) {
      if (_mockFeed.interactive) skipInteractivePicks(t.dataset.mockskip);
      else skipMockPicks(t.dataset.mockskip);
    } else if (t.dataset.mockspeed) {
      setMockFeedSpeed(t.dataset.mockspeed);
    } else if (t.dataset.mockbotspeed) {
      if (typeof setMockBidSpeed === "function") setMockBidSpeed(t.dataset.mockbotspeed);
      _mfRender();
    }
  });
}

// Interactive cockpit mock: mirror engine phase changes the emitted frames don't
// carry (your nominate turn, a pass, the draft finishing) into the cockpit.
if (typeof onInteractiveChange === "function") {
  onInteractiveChange((s) => {
    if (!(_mockFeed.active && _mockFeed.interactive)) return;
    if (s.phase === "done" && !_mockFeed.finished) {
      _mockFeed.finished = true;
      if (typeof stopInteractiveMock === "function") stopInteractiveMock();
    }
    if (typeof currentView === "undefined" || currentView !== "draft") return;
    if (typeof _draftModeOn === "function" && !_draftModeOn()) return;
    _icCockpitRefresh(s);
  });
}

// Node/test export (no-op in the browser where `module` is undefined).
if (typeof module !== "undefined" && module.exports) {
  module.exports = { buildMockFeedScript, _mfBidTrace, _mfSampleIncrement };
}
