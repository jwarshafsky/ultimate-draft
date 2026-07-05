// App engine tests — loads the REAL Ultimate Draft engine files into a stubbed
// browser-ish global (document / localStorage / window / data globals) and
// asserts pure-logic outcomes: keeper exclusions, keeper costs, live team states
// (real + test mode), the tombstone matrix, event dedup + stream reset, the
// staleness gate, current-lot detection, recommendBid caps, draftTeams discovery,
// and processEspnPicks attribution.
//
// The app is ONE global namespace of plain <script> files (no modules), so we
// eval the real files into node's global after installing the data globals they
// call. Nothing here modifies app source.

const fs = require("fs");
const {
  test, section, summary, assert, assertEq, assertDeep,
  makeLocalStorageStub,
} = require("./helpers.js");

const APP = "/Users/jwars/Desktop/Claude/ultimate-draft/js/";

// ---------------------------------------------------------------------------
// Shared test data: a small deterministic value pool + keeper fixtures.
// ---------------------------------------------------------------------------
// posKey values the engines understand: C/1B/2B/SS/3B/OF/UTIL/SP/RP.
const VALUES = [
  { name: "Aaron Judge", posKey: "OF", team: "NYY", type: "H", value: 40 },
  { name: "Mookie Betts", posKey: "SS", team: "LAD", type: "H", value: 34 },
  { name: "Bobby Witt Jr.", posKey: "SS", team: "KC", type: "H", value: 32 },
  { name: "Freddie Freeman", posKey: "1B", team: "LAD", type: "H", value: 25 },
  { name: "Jose Ramirez", posKey: "3B", team: "CLE", type: "H", value: 30 },
  { name: "Will Smith", posKey: "C", team: "LAD", type: "H", value: 18 },
  { name: "Corbin Carroll", posKey: "OF", team: "ARI", type: "H", value: 22 },
  { name: "Gerrit Cole", posKey: "SP", team: "NYY", type: "P", value: 28 },
  { name: "Tarik Skubal", posKey: "SP", team: "DET", type: "P", value: 26 },
  { name: "Emmanuel Clase", posKey: "RP", team: "CLE", type: "P", value: 16 },
  { name: "Jose Alvarado", posKey: "RP", team: "PHI", type: "P", value: 8 },
  { name: "Filler One", posKey: "OF", team: "AAA", type: "H", value: 3 },
  { name: "Filler Two", posKey: "SP", team: "AAA", type: "P", value: 2 },
  { name: "Prospect Stash", posKey: "OF", team: "AAA", type: "H", value: 5 },
];
const VAL_BY_NAME = Object.fromEntries(VALUES.map((v) => [v.name.toLowerCase(), v]));

// Keeper selections keyed by internal team id (real-league mode).
// jeff keeps a major (Judge @ $10) + a minor stash (Prospect Stash).
const KEEPER_SELECTIONS = {
  jeff: {
    "Aaron Judge": { keeper: true },
    "Prospect Stash": { minorKeeper: true },
  },
  matt: {
    "Jose Ramirez": { keeper: true },
  },
};
const KEEPER_SALARY = { "aaron judge": 10, "jose ramirez": 22 };

// Normalizer used across the app (lowercase + strip accents).
function normalizePlayerName(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
}

// The 12-team league (ids incl jeff/isMe). rosterSize 26, $260, numTeams 12.
const LEAGUE = {
  draftBudget: 260,
  rosterSize: 26,
  numTeams: 12,
  teams: [
    { id: "matt", owner: "Matt" }, { id: "saxton", owner: "Saxton" },
    { id: "sam", owner: "Sam" }, { id: "glix", owner: "Glix" },
    { id: "jeff", owner: "Jeff", isMe: true }, { id: "aj", owner: "AJ" },
    { id: "corey", owner: "Corey" }, { id: "jd", owner: "JD" },
    { id: "wein", owner: "Wein" }, { id: "klin", owner: "Klin" },
    { id: "dave", owner: "Dave" }, { id: "jtl", owner: "JTL" },
  ],
};

// ESPN team id → owner id (as in espn.js). We include a focused copy so the
// engines' espnTeamIdToOwnerId is available without loading espn.js whole.
const ESPN_TEAM_ID_MAP = {
  1: "matt", 2: "saxton", 3: "sam", 4: "glix", 5: "jeff",
  6: "aj", 7: "corey", 8: "jd", 9: "wein", 10: "klin", 12: "dave", 13: "jtl",
};

// ---------------------------------------------------------------------------
// Build the stubbed global context and load the real engine files.
// ---------------------------------------------------------------------------
function installGlobals(overrides) {
  overrides = overrides || {};
  const ls = makeLocalStorageStub(overrides.localStorage || {});

  // A document stub broad enough for draft.js / draft-mode.js LOAD-TIME code
  // (addEventListener, getElementById, querySelectorAll, createElement, body).
  // A permissive element stub: every DOM write is a harmless no-op. renderDraft
  // (called unconditionally by deletePickAt/soldCurrent) touches
  // getElementById("inflation-badge").textContent etc., so getElementById must
  // return a writable stub rather than null. currentView is set to "x" so the
  // feed pipeline's `if (currentView==="draft") renderDraft()` guards are skipped
  // (we assert engine STATE, not DOM); only the unconditional renders reach here.
  const mkEl = () => ({ addEventListener() {}, appendChild() {}, click() {}, remove() {}, setAttribute() {}, getAttribute() { return null; }, style: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, dataset: {}, focus() {}, closest() { return null; }, querySelectorAll() { return []; }, querySelector() { return null; }, innerHTML: "", textContent: "", value: "", title: "", className: "" });
  const doc = {
    addEventListener() {},
    getElementById() { return mkEl(); },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    createElement() { return mkEl(); },
    body: { classList: { add() {}, remove() {}, toggle() {} }, appendChild() {} },
    activeElement: null,
  };

  const win = {
    addEventListener() {}, removeEventListener() {}, postMessage() {},
    location: { origin: "https://jwarshafsky.github.io", pathname: "/", search: "" },
  };

  // Data globals the engines call. Overridable per test.
  const g = {
    window: win,
    document: doc,
    localStorage: ls,
    location: win.location,
    console: { log() {}, warn() {}, error() {} },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    URL: { createObjectURL: () => "", revokeObjectURL: () => {} },
    Blob: function () {},
    Date,

    // --- league + player data globals ---
    LEAGUE: overrides.LEAGUE || LEAGUE,
    UD_HOME_LEAGUE_ID: 1200,
    VALUATION: { hitBudgetPct: 0.70 },
    getValues: overrides.getValues || (() => VALUES),
    getPlayerValue: (name) => VAL_BY_NAME[normalizePlayerName(name)] || null,
    normalizePlayerName,
    esc: (s) => String(s),
    setStatus() {},
    // "x" (not "draft") so feed-pipeline renders are guarded out — we assert
    // engine STATE, and a full renderDraft() needs the whole UI stack.
    currentView: overrides.currentView != null ? overrides.currentView : "x",

    getMyTeam: () => LEAGUE.teams.find((t) => t.isMe) || null,
    getTeam: (id) => LEAGUE.teams.find((t) => t.id === id) || null,
    espnTeamIdToOwnerId: (espnId) => ESPN_TEAM_ID_MAP[espnId] || null,

    getKeeperSelections: () => KEEPER_SELECTIONS,
    getEffectiveKeeperSelections: overrides.getEffectiveKeeperSelections || (() => KEEPER_SELECTIONS),
    getCurrentKeeperSalary: (name) => {
      const v = KEEPER_SALARY[normalizePlayerName(name)];
      return typeof v === "number" ? v : null;
    },
    getLeagueContractByName: () => null,

    getNfbc: () => null,
    getStatcast: () => null,
    statcastBuySell: () => null,
    getDraftDollarAdjustment: () => 0,
    getProjection: () => null,
    getNote: () => null,
    getFlaggedPlayers: () => [],
    classifyPriceVsTargets: () => null,
    renderTagIcons: () => "",
    renderTargetBadge: () => "",
    ensureRotowireNews() {},
    fetchEspnPlayers: async () => ({ players: [] }),
    logDraftEvents() {},
    draftLogStatus: () => ({ sessionId: null, pending: 0 }),
    coreNameKey: (s) => normalizePlayerName(s),

    // Render/UI functions from files we deliberately DON'T load (draft-setup.js,
    // category dashboard, AI panel, debrief, notes, mock standings, etc.).
    // renderDraft() is called unconditionally by deletePickAt/soldCurrent; a
    // stubbed renderDraftSetup short-circuits it (the default non-manual path is
    //   `if (!manualView && typeof renderDraftSetup==='function'){renderDraftSetup();return;}`)
    // so we never reach the heavyweight manual view. The rest are safety nets.
    renderDraftSetup() {},
    renderCategoryDashboard: () => "",
    renderAiAssistantPanel: () => "",
    wireAiPanel() {},
    renderInflationCurve: () => "",
    renderSpendingPace: () => "",
    renderPlayerNewsBlock: () => "",
    wirePlayerNewsBlock() {},
    renderInvariantsLine: () => "",
    openDebrief() {}, closeDebrief() {}, openNoteEditor() {},
    recordInflationSnapshot() {},
    getMyRoster: () => [],
    projectTeamCategories: () => null,
    aggregateCats: () => null,
    strategyForAi: () => null,
    computeMockStandings: () => null,
    getLeagueContractByName: () => null,

    // processEspnPicks lives in espn.js with load-time code; provide a focused
    // copy matching the real implementation so attribution/dedup can be tested
    // without loading espn.js whole (documented in fixtures/README + report).
  };

  // Install onto node global BEFORE loading (single shared namespace).
  for (const k of Object.keys(g)) global[k] = g[k];

  // Load the REAL engine files (order mirrors index.html dependencies). We
  // CONCATENATE them into one eval so that top-level `const`/`let` declarations
  // (which do NOT attach to globalThis, and are invisible ACROSS separate eval
  // calls) are all visible to a trailing export snippet. That snippet pins the
  // module-level state objects (_liveDraft, _dlog, _feed) onto globalThis so the
  // tests can read + mutate them. Functions already attach to globalThis.
  const files = [
    "data/budget-adjust.js",   // getBudgetAdjustment (real)
    "core/inflation.js",       // collectKeepers, draftExcludedNames, inflation math
    "features/endgame.js",     // computeLiveTeamStates, isEndgame
    "features/nominations.js", // teamOpenSlotProfile, suggestNominations
    "features/draft.js",       // _liveDraft, _dlog, _feed, feed pipeline, draftTeams
    "features/draft-mode.js",  // currentLotFromEvents, recommendBid
  ];
  let bundle = files.map((f) => fs.readFileSync(APP + f, "utf8")).join("\n;\n");
  // Trailing export: same eval scope, so these consts are in view here.
  bundle += "\n;globalThis._liveDraft=_liveDraft;globalThis._dlog=_dlog;globalThis._feed=_feed;";
  (0, eval)(bundle);

  // Provide the focused processEspnPicks (real logic from espn.js) AFTER load so
  // _applyDraftFeed can call it. Mirrors espn.js exactly.
  global.processEspnPicks = function (rawPicks) {
    const existing = new Set(global._liveDraft.picks.map((p) => p.espnPlayerId).filter(Boolean));
    let added = 0;
    for (const raw of rawPicks) {
      if (existing.has(raw.playerId)) continue;
      global._liveDraft.picks.push({
        player: raw.playerName,
        pos: global.getPlayerValue(raw.playerName)?.posKey || null,
        team: (typeof global.draftTestMode === "function" && global.draftTestMode()) ? ("espn:" + raw.teamId) : global.espnTeamIdToOwnerId(raw.teamId),
        espnTeamId: raw.teamId,
        price: raw.bidAmount || 0,
        ts: Date.now(),
        espnPlayerId: raw.playerId,
        espnSeq: raw.seq != null ? raw.seq : null,
      });
      added++;
    }
    if (added && typeof global.saveLiveDraft === "function") global.saveLiveDraft();
  };

  return { ls, doc, win };
}

// Reset the in-memory draft state between tests (engines keep module-level state).
function resetDraftState() {
  global._liveDraft.picks = [];
  global._liveDraft.deleted = {};
  global._liveDraft.current = null;
  global._liveDraft.highBid = 0;
  global._liveDraft.highBidder = null;
  global._dlog.leagueId = null;
  global._dlog.startedAt = 0;
  global._dlog.events = [];
  global._dlog.lastEventAt = 0;
  global._dlog.initState = null;
  global._feed.staleInfo = null;
  global._feed.connected = false;
  global._feed.tabAt = 0;
}

// Load once; toggle mode/localStorage via helpers between tests.
installGlobals();

function setRealMode() { global.localStorage.setItem("ud_feed_mode", "real"); global.localStorage.removeItem("ud_league_override"); }
function setTestMode() { global.localStorage.setItem("ud_feed_mode", "test"); }
function setOffMode() { global.localStorage.setItem("ud_feed_mode", "off"); }

// =====================================================================
section("App engines — keeper exclusions & costs (inflation.js)");
// =====================================================================

test("draftExcludedNames (real): checked major + minor keepers excluded", () => {
  setRealMode(); resetDraftState();
  const ex = global.draftExcludedNames();
  assert(ex.has(normalizePlayerName("Aaron Judge")), "major keeper excluded");
  assert(ex.has(normalizePlayerName("Prospect Stash")), "minor keeper excluded");
  assert(ex.has(normalizePlayerName("Jose Ramirez")), "matt's major keeper excluded");
});

test("draftExcludedNames (real): a MiL-rostered-but-UNCHECKED player is NOT excluded", () => {
  setRealMode(); resetDraftState();
  const ex = global.draftExcludedNames();
  // "Corbin Carroll" is not marked keeper anywhere → draftable.
  assert(!ex.has(normalizePlayerName("Corbin Carroll")), "unchecked player draftable");
});

test("draftExcludedNames (test mode): empty set (full pool)", () => {
  setTestMode(); resetDraftState();
  assertEq(global.draftExcludedNames().size, 0, "test mode excludes nobody");
  setRealMode();
});

test("collectKeepers costs: major = salary, minor = $0", () => {
  setRealMode(); resetDraftState();
  const kept = global.collectKeepers();
  const judge = kept.find((k) => k.name === "Aaron Judge");
  const stash = kept.find((k) => k.name === "Prospect Stash");
  assert(judge && judge.kind === "major" && judge.cost === 10, "major keeper at $10 salary");
  assert(stash && stash.kind === "minor" && stash.cost === 0, "minor keeper at $0");
});

// =====================================================================
section("App engines — computeLiveTeamStates (endgame.js)");
// =====================================================================

test("live team states (real): maxBid = budget − (slots−1); keeper cost applied", () => {
  setRealMode(); resetDraftState();
  const st = global.computeLiveTeamStates().jeff;
  // jeff: 1 major keeper (Judge $10, fills a slot), 1 minor keeper (stashed, NO slot).
  // budget = 260 − 10 (keeper) − 0 spent = 250.
  assertEq(st.keptCost, 10, "keeper cost = $10");
  assertEq(st.budget, 250, "budget after keeper");
  // slots: rosterSize 26 − kept(majors only, =1) − picks(0) = 25 → maxBid = 250 − 24 = 226
  assertEq(st.slotsRemaining, 25, "minor keeper fills NO slot");
  assertEq(st.maxBid, 226, "maxBid = budget − (slots−1)");
});

test("live team states (real): a $50 pick lowers budget, slots, and maxBid", () => {
  setRealMode(); resetDraftState();
  global._liveDraft.picks.push({ player: "Gerrit Cole", pos: "SP", team: "jeff", price: 50, ts: Date.now() });
  const st = global.computeLiveTeamStates().jeff;
  assertEq(st.spent, 50, "spent");
  assertEq(st.budget, 200, "budget = 260 − 10 − 50");
  assertEq(st.slotsRemaining, 24, "one slot used by the pick");
  assertEq(st.maxBid, 177, "maxBid = 200 − 23");
});

test("live team states (test mode): generic espn:N teams, $260, no keepers", () => {
  setTestMode(); resetDraftState();
  // Picks carry espnTeamId; a team appears from the feed ids.
  global._liveDraft.picks.push({ player: "Aaron Judge", pos: "OF", team: "espn:6", espnTeamId: 6, price: 30, ts: Date.now() });
  const states = global.computeLiveTeamStates();
  const st = states["espn:6"];
  assert(st, "generic espn:6 team exists");
  assertEq(st.keptCost, 0, "no keepers in test mode");
  assertEq(st.budget, 230, "budget = 260 − 30 spent (no keeper, no adj)");
  assertEq(st.slotsRemaining, 25, "26 − 1 pick");
  setRealMode();
});

test("live team states (test mode): picks matched by espnTeamId", () => {
  setTestMode(); resetDraftState();
  global.localStorage.setItem("ud_test_my_team", "5");
  global._liveDraft.picks.push({ player: "Mookie Betts", pos: "SS", team: "espn:6", espnTeamId: 6, price: 20, ts: Date.now() });
  global._liveDraft.picks.push({ player: "Gerrit Cole", pos: "SP", team: "espn:6", espnTeamId: 6, price: 25, ts: Date.now() });
  const st = global.computeLiveTeamStates()["espn:6"];
  assertEq(st.picksMade, 2, "both espn:6 picks counted");
  assertEq(st.spent, 45, "spent summed");
  global.localStorage.removeItem("ud_test_my_team");
  setRealMode();
});

// =====================================================================
section("App engines — tombstone matrix (_applyDraftFeed in draft.js)");
// =====================================================================

async function applyFeed(picks, extra) {
  await global._applyDraftFeed(Object.assign({ leagueId: 1200, sport: "flb", picks, updatedAt: Date.now() }, extra || {}));
}

// =====================================================================
section("App engines — current lot detection (draft-mode.js)");
// =====================================================================

function feedEvents(list) {
  global._dlog.events = list.map((e, i) => Object.assign({ seq: i + 1, at: Date.now() }, e));
}

test("currentLot: NOMINATION opens a lot; bids accumulate the high bid", () => {
  setRealMode(); resetDraftState();
  feedEvents([
    { cmd: "NOMINATION", teamId: 6, playerId: 39832 },
    { cmd: "BID", teamId: 6, playerId: 39832, amount: 5 },
    { cmd: "BID", teamId: 2, playerId: 39832, amount: 8 },
  ]);
  const lot = global.currentLotFromEvents();
  assert(lot, "lot open");
  assertEq(lot.playerId, 39832);
  assertEq(lot.highBid, 8, "high bid accumulates");
  assertEq(lot.highTeamId, 2, "high bidder");
});

test("currentLot: SOLD of a DIFFERENT player does NOT clear the lot", () => {
  setRealMode(); resetDraftState();
  feedEvents([
    { cmd: "NOMINATION", teamId: 6, playerId: 39832 },
    { cmd: "BID", teamId: 6, playerId: 39832, amount: 5 },
    { cmd: "SOLD", teamId: 2, playerId: 99999, amount: 3 },   // a different player's sale
  ]);
  const lot = global.currentLotFromEvents();
  assert(lot && lot.playerId === 39832, "on-the-clock player survives interleaved SOLD");
});

test("currentLot: SOLD of the lot's player clears it", () => {
  setRealMode(); resetDraftState();
  feedEvents([
    { cmd: "NOMINATION", teamId: 6, playerId: 39832 },
    { cmd: "BID", teamId: 6, playerId: 39832, amount: 5 },
    { cmd: "SOLD", teamId: 6, playerId: 39832, amount: 5 },
  ]);
  assertEq(global.currentLotFromEvents(), null, "lot cleared after its own SOLD");
});

test("currentLot: INIT clears the lot (reconnect boundary)", () => {
  setRealMode(); resetDraftState();
  feedEvents([
    { cmd: "NOMINATION", teamId: 6, playerId: 39832 },
    { cmd: "BID", teamId: 6, playerId: 39832, amount: 5 },
    { cmd: "INIT" },
  ]);
  assertEq(global.currentLotFromEvents(), null, "INIT resets the lot");
});

test("currentLot: quiet >5min → idle:true; quiet >60min → null (ended)", () => {
  setRealMode(); resetDraftState();
  const old = Date.now() - 6 * 60 * 1000;   // 6 min ago
  global._dlog.events = [
    { seq: 1, at: old, cmd: "NOMINATION", teamId: 6, playerId: 39832 },
    { seq: 2, at: old, cmd: "BID", teamId: 6, playerId: 39832, amount: 5 },
  ];
  const idleLot = global.currentLotFromEvents();
  assert(idleLot && idleLot.idle === true, "6-min-quiet lot goes idle, not blank");

  const ancient = Date.now() - 61 * 60 * 1000;
  global._dlog.events = [
    { seq: 1, at: ancient, cmd: "NOMINATION", teamId: 6, playerId: 39832 },
    { seq: 2, at: ancient, cmd: "BID", teamId: 6, playerId: 39832, amount: 5 },
  ];
  assertEq(global.currentLotFromEvents(), null, "61-min-quiet lot treated as ended");
});

// =====================================================================
section("App engines — recommendBid cap (draft-mode.js)");
// =====================================================================

test("recommendBid: walk/stretch capped at my maxBid", () => {
  setRealMode(); resetDraftState();
  // Shrink jeff's maxBid to a small positive number by spending most of budget.
  // budget = 260 − 10 keeper − 200 = 50; slots = 26 − 1 keeper − 1 pick = 24;
  // maxBid = 50 − 23 = 27. Judge is $40 value → walk exceeds maxBid → capped.
  global._liveDraft.picks.push({ player: "Gerrit Cole", pos: "SP", team: "jeff", price: 200, ts: Date.now() });
  const st = global.computeLiveTeamStates().jeff;
  assert(st.maxBid > 0, "precondition: positive maxBid (" + st.maxBid + ")");
  const r = global.recommendBid("Aaron Judge");   // $40 value — over maxBid
  assert(r, "reco returned");
  assert(r.walk <= r.maxBid, "walk capped at maxBid (" + r.walk + " <= " + r.maxBid + ")");
  assert(r.stretch <= r.maxBid, "stretch capped at maxBid");
  assertEq(r.maxBid, st.maxBid, "reco maxBid matches team state");
});

// =====================================================================
section("App engines — draftTeams discovery (draft.js)");
// =====================================================================

test("draftTeams (real): returns the real LEAGUE teams", () => {
  setRealMode(); resetDraftState();
  const teams = global.draftTeams();
  assertEq(teams.length, 12, "12 real teams");
  assert(teams.find((t) => t.id === "jeff" && t.isMe), "jeff is me");
});

test("draftTeams (test): discovers espn ids from picks/events + includes my seat", () => {
  setTestMode(); resetDraftState();
  global.localStorage.setItem("ud_test_my_team", "5");
  global._liveDraft.picks.push({ player: "Aaron Judge", pos: "OF", team: "espn:6", espnTeamId: 6, price: 30, ts: Date.now() });
  global._dlog.events = [{ seq: 1, at: Date.now(), cmd: "BID", teamId: 7, playerId: 111 }];
  const teams = global.draftTeams();
  const ids = teams.map((t) => t.espnTeamId).sort((a, b) => a - b);
  assert(ids.includes(6), "team 6 from picks");
  assert(ids.includes(7), "team 7 from events");
  assert(ids.includes(5), "my seat (5) included even before it bids");
  const me = teams.find((t) => t.isMe);
  assert(me && me.espnTeamId === 5, "isMe on seat 5");
  global.localStorage.removeItem("ud_test_my_team");
  setRealMode();
});

// =====================================================================
section("App engines — processEspnPicks attribution (via _applyDraftFeed)");
// =====================================================================

(async function asyncTests() {

  // --- tombstone matrix ---
  await (async () => {
    setRealMode(); resetDraftState();
    // First: feed delivers a pick for player 39832 (Aaron Judge is a keeper, so
    // use a non-keeper: Corbin Carroll, id 39832).
    global._espnIdToName = { 39832: "Corbin Carroll" };
    await applyFeed([{ playerId: 39832, teamId: 6, price: 12, seq: 10 }]);
    assertEq(global._liveDraft.picks.length, 1, "pick ingested");

    // Manually delete it → tombstone with the seq.
    const idx = global._liveDraft.picks.findIndex((p) => p.espnPlayerId === 39832);
    global.deletePickAt(idx);
    assertEq(global._liveDraft.picks.length, 0, "pick deleted");
    assertEq(String(global._liveDraft.deleted[39832]), "10", "seq tombstone recorded");

    // Same-seq feed replay must be BLOCKED by the tombstone.
    await applyFeed([{ playerId: 39832, teamId: 6, price: 12, seq: 10 }]);
    test("tombstone: same-seq re-delivery stays blocked", () => {
      assertEq(global._liveDraft.picks.length, 0, "tombstone holds");
    });

    // New-seq feed = genuine re-auction → resurrects + clears tombstone.
    await applyFeed([{ playerId: 39832, teamId: 4, price: 6, seq: 25 }]);
    test("tombstone: new-seq re-auction resurrects + clears tombstone", () => {
      assertEq(global._liveDraft.picks.length, 1, "resurrected");
      assert(global._liveDraft.deleted[39832] == null, "tombstone cleared");
    });
  })();

  // --- negative-timestamp tombstone ---
  await (async () => {
    setRealMode(); resetDraftState();
    global._espnIdToName = { 39832: "Corbin Carroll" };
    // A pick with NO seq (manual/legacy) deleted → negative-timestamp tombstone.
    const delAt = Date.now();
    global._liveDraft.deleted[39832] = -delAt;

    // Feed record written BEFORE the deletion (older ts) → stays blocked.
    await applyFeed([{ playerId: 39832, teamId: 6, price: 12, seq: null, ts: delAt - 5000 }].map((p) => ({ playerId: p.playerId, teamId: p.teamId, price: p.price, seq: p.seq, ts: p.ts })));
    test("negative-ts tombstone: an OLDER feed record stays blocked", () => {
      assertEq(global._liveDraft.picks.length, 0, "older-than-deletion record blocked");
    });

    // Feed record written AFTER the deletion (newer ts) → resurrects.
    await applyFeed([{ playerId: 39832, teamId: 6, price: 12, seq: null, ts: delAt + 5000 }]);
    test("negative-ts tombstone: a NEWER feed record resurrects", () => {
      assertEq(global._liveDraft.picks.length, 1, "newer-than-deletion record accepted");
    });
  })();

  // --- test-mode attribution: espn:N, never a real owner ---
  await (async () => {
    setTestMode(); resetDraftState();
    global._espnIdToName = { 39832: "Corbin Carroll" };
    await applyFeed([{ playerId: 39832, teamId: 6, price: 12, seq: 10 }]);
    test("test mode: pick attributed to espn:6, NOT a real owner id", () => {
      const pk = global._liveDraft.picks[0];
      assertEq(pk.team, "espn:6", "generic team id");
      assertEq(pk.espnTeamId, 6, "raw espn id kept");
      assert(!LEAGUE.teams.some((t) => t.id === pk.team), "no real owner id leaked");
    });
    setRealMode();
  })();

  // --- real-mode attribution: mapped to the real owner ---
  await (async () => {
    setRealMode(); resetDraftState();
    global._espnIdToName = { 39832: "Corbin Carroll" };
    await applyFeed([{ playerId: 39832, teamId: 6, price: 12, seq: 10 }]);
    test("real mode: pick mapped to the real owner (espn 6 → aj)", () => {
      assertEq(global._liveDraft.picks[0].team, "aj", "mapped to owner");
    });
  })();

  // =====================================================================
  section("App engines — staleness gate (_applyDraftFeed)");
  // =====================================================================

  await (async () => {
    setRealMode(); resetDraftState();
    global._espnIdToName = { 39832: "Corbin Carroll" };
    global._feed.tabAt = 0;   // no ESPN draft tab open
    const stale = Date.now() - 20 * 60 * 1000;   // 20 min ago (> 15 min gate)
    await global._applyDraftFeed({ leagueId: 1200, sport: "flb", updatedAt: stale, picks: [{ playerId: 39832, teamId: 6, price: 12, seq: 10, ts: stale }] });
    test("staleness gate: >15min old + no draft tab → NOT ingested, connected=false, staleInfo set", () => {
      assertEq(global._liveDraft.picks.length, 0, "old picks not ingested");
      assertEq(global._feed.connected, false, "not presented as live");
      assert(global._feed.staleInfo && global._feed.staleInfo.count === 1, "staleInfo recorded");
    });
  })();

  await (async () => {
    setRealMode(); resetDraftState();
    global._espnIdToName = { 39832: "Corbin Carroll" };
    global._feed.tabAt = Date.now();   // draft tab IS open → gate does not fire
    const stale = Date.now() - 20 * 60 * 1000;
    await global._applyDraftFeed({ leagueId: 1200, sport: "flb", updatedAt: stale, picks: [{ playerId: 39832, teamId: 6, price: 12, seq: 10, ts: stale }] });
    test("staleness gate: old data BUT draft tab open → ingested (live draft, not stale)", () => {
      assertEq(global._liveDraft.picks.length, 1, "ingested because tab open");
      assertEq(global._feed.connected, true, "presented as live");
    });
  })();

  // =====================================================================
  section("App engines — event dedup + stream reset (_onDraftEvents)");
  // =====================================================================

  await (async () => {
    setRealMode(); resetDraftState();
    global._onDraftEvents({
      full: true, log: { leagueId: 1200, sport: "flb", startedAt: 500 },
      events: [{ seq: 1, cmd: "NOMINATION", at: Date.now() }, { seq: 2, cmd: "BID", at: Date.now() }],
    });
    // Re-deliver seq 1-2 (dup) + new seq 3 → only seq 3 appended.
    global._onDraftEvents({
      full: false, log: { leagueId: 1200, sport: "flb", startedAt: 500 },
      events: [{ seq: 1, cmd: "NOMINATION", at: Date.now() }, { seq: 2, cmd: "BID", at: Date.now() }, { seq: 3, cmd: "SOLD", at: Date.now() }],
    });
    test("event dedup: repeated seqs ignored, only seq>last appended", () => {
      assertEq(global._dlog.events.length, 3, "3 unique events");
      assertDeep(global._dlog.events.map((e) => e.seq), [1, 2, 3]);
    });

    // A startedAt change = new stream → the event log RESETS.
    global._onDraftEvents({
      full: true, log: { leagueId: 1200, sport: "flb", startedAt: 999 },
      events: [{ seq: 1, cmd: "NOMINATION", at: Date.now() }],
    });
    test("stream reset: startedAt change wipes the old event log", () => {
      assertEq(global._dlog.events.length, 1, "reset to the new stream's events");
      assertEq(global._dlog.startedAt, 999, "startedAt updated");
    });
  })();

  // =====================================================================
  section("Round-4 regression seeds (.agentreview-history.md, Round 4)");
  // =====================================================================

  // R4: stale feed must not present as Live.
  await (async () => {
    setRealMode(); resetDraftState();
    global._espnIdToName = { 39832: "Corbin Carroll" };
    global._feed.tabAt = 0;
    const stale = Date.now() - 30 * 60 * 1000;
    await global._applyDraftFeed({ leagueId: 1200, sport: "flb", updatedAt: stale, picks: [{ playerId: 39832, teamId: 6, price: 12, seq: 10, ts: stale }] });
    test("R4: stale feed must not present as Live", () => {
      assertEq(global._feed.connected, false, "connected stays false for stale capture");
      assert(global._feed.staleInfo, "surfaced as 'Last capture', not live");
    });
  })();

  // R4: mock picks must NOT land on real owners' ledgers.
  await (async () => {
    setTestMode(); resetDraftState();
    global._espnIdToName = { 39832: "Corbin Carroll" };
    await applyFeed([{ playerId: 39832, teamId: 6, price: 12, seq: 10 }]);
    test("R4: test-mode picks never attributed to a real owner", () => {
      const pk = global._liveDraft.picks[0];
      assert(pk.team === "espn:6" && !LEAGUE.teams.some((t) => t.id === pk.team), "generic espn team only");
    });
    setRealMode();
  })();

  // R4: hidden pool — test mode must expose the FULL player pool (no keeper excl).
  await (async () => {
    setTestMode(); resetDraftState();
    test("R4: test mode exposes the full pool (no keeper exclusions)", () => {
      assertEq(global.draftExcludedNames().size, 0, "no exclusions in mock");
    });
    setRealMode();
  })();

  // R4: live max bids must include traded draft dollars / budget adjustments.
  await (async () => {
    setRealMode(); resetDraftState();
    global.localStorage.setItem("ud_budget_adj_v1", JSON.stringify({ jeff: 15 }));
    global.replaceBudgetAdjustments({ jeff: 15 });   // +$15 traded in
    const st = global.computeLiveTeamStates().jeff;
    test("R4: live max bid includes budget adjustment (traded draft dollars)", () => {
      // budget = 260 + 15 − 10 keeper = 265; maxBid = 265 − 24 = 241
      assertEq(st.budget, 265, "adj applied to budget");
      assertEq(st.maxBid, 241, "maxBid reflects the extra $15");
    });
    global.replaceBudgetAdjustments({});
    global.localStorage.removeItem("ud_budget_adj_v1");
  })();

  // R4: seq reuse — a same-seq feed replay of a deleted pick must not resurrect
  // (covered in tombstone matrix; restate as an explicit regression case).
  await (async () => {
    setRealMode(); resetDraftState();
    global._espnIdToName = { 39832: "Corbin Carroll" };
    await applyFeed([{ playerId: 39832, teamId: 6, price: 12, seq: 10 }]);
    global.deletePickAt(global._liveDraft.picks.findIndex((p) => p.espnPlayerId === 39832));
    await applyFeed([{ playerId: 39832, teamId: 6, price: 12, seq: 10 }]);
    test("R4: seq reuse — deleted pick not resurrected by identical-seq replay", () => {
      assertEq(global._liveDraft.picks.length, 0, "tombstone survives identical replay");
    });
  })();

  // R4: SOLD/lot interleave — a SOLD for another player doesn't blank the hero.
  await (async () => {
    setRealMode(); resetDraftState();
    feedEvents([
      { cmd: "NOMINATION", teamId: 6, playerId: 39832 },
      { cmd: "BID", teamId: 6, playerId: 39832, amount: 5 },
      { cmd: "SOLD", teamId: 3, playerId: 77777, amount: 9 },
    ]);
    test("R4: SOLD/lot interleave — other player's SOLD keeps the on-the-clock player", () => {
      const lot = global.currentLotFromEvents();
      assert(lot && lot.playerId === 39832, "hero survives interleaved SOLD");
    });
  })();

  summary("App engines");
})();
