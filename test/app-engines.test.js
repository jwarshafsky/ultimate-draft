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
    const _penNk = (typeof global.normalizePlayerName === "function") ? global.normalizePlayerName : (x => String(x || "").toLowerCase());
    let added = 0;
    for (const raw of rawPicks) {
      if (existing.has(raw.playerId)) continue;
      // Manual↔feed dedup (spec Q3) — mirrors espn.js exactly.
      const manual = raw.playerName && global._liveDraft.picks.find((p) =>
        p.espnPlayerId == null && _penNk(p.player) === _penNk(raw.playerName));
      if (manual) {
        manual.espnPlayerId = raw.playerId;
        manual.espnTeamId = raw.teamId;
        manual.espnSeq = raw.seq != null ? raw.seq : null;
        existing.add(raw.playerId);
        added++;
        continue;
      }
      global._liveDraft.picks.push({
        player: raw.playerName,
        pos: global.getPlayerValue(raw.playerName)?.posKey || null,
        team: (typeof global.draftTestMode === "function" && global.draftTestMode()) ? ("espn:" + raw.teamId) : global.espnTeamIdToOwnerId(raw.teamId),
        espnTeamId: raw.teamId,
        price: (raw.bidAmount > 0 ? raw.bidAmount : 1),
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

test("currentLot: quiet >5min → idle:true; quiet >2h → null (ended)", () => {
  setRealMode(); resetDraftState();
  const old = Date.now() - 6 * 60 * 1000;   // 6 min ago
  global._dlog.events = [
    { seq: 1, at: old, cmd: "NOMINATION", teamId: 6, playerId: 39832 },
    { seq: 2, at: old, cmd: "BID", teamId: 6, playerId: 39832, amount: 5 },
  ];
  const idleLot = global.currentLotFromEvents();
  assert(idleLot && idleLot.idle === true, "6-min-quiet lot goes idle, not blank");

  const ancient = Date.now() - 121 * 60 * 1000;
  global._dlog.events = [
    { seq: 1, at: ancient, cmd: "NOMINATION", teamId: 6, playerId: 39832 },
    { seq: 2, at: ancient, cmd: "BID", teamId: 6, playerId: 39832, amount: 5 },
  ];
  assertEq(global.currentLotFromEvents(), null, "121-min-quiet lot treated as ended");
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
section("App engines — roster slot assignment (draft-mode.js)");
// =====================================================================

test("fixed 26-slot template in Jeff's canonical order", () => {
  const slots = global._dmAssignRoster([], {}).slots;   // (const template isn't a global; read it off the result)
  assertEq(slots.length, 26, "26 slots");
  assertEq(slots.map(s => s.type).join(" "),
    "C 1B 2B SS 3B CI MI OF OF OF OF OF Util P P P P P P P P P BN BN BN BN",
    "exact slot order");
});

test("_dmSlotAccepts: eligibility, flex, Util/P/BN rules", () => {
  const of = { elig: ["OF", "UTIL"], type: "H" };
  const firstBase = { elig: ["1B", "CI", "UTIL"], type: "H" };
  const sp = { elig: ["SP"], type: "P" };
  assert(global._dmSlotAccepts("OF", of), "OF fits OF");
  assert(!global._dmSlotAccepts("P", of), "hitter does NOT fit P");
  assert(global._dmSlotAccepts("Util", of), "any hitter fits Util");
  assert(global._dmSlotAccepts("CI", firstBase), "1B fits CI");
  assert(!global._dmSlotAccepts("MI", firstBase), "1B does NOT fit MI");
  assert(global._dmSlotAccepts("P", sp), "pitcher fits P");
  assert(!global._dmSlotAccepts("C", sp), "pitcher does NOT fit C");
  assert(global._dmSlotAccepts("BN", sp) && global._dmSlotAccepts("BN", of), "BN accepts anyone");
});

test("autofill places everyone in an eligible slot; overflow past 26 flagged", () => {
  const mk = (elig, type, value) => ({ elig, type, value });
  const db = {
    "Cat": mk(["C", "UTIL"], "H", 15), "Mookie": mk(["SS", "MI", "2B", "UTIL"], "H", 30),
    "FB": mk(["1B", "CI", "UTIL"], "H", 20), "TB": mk(["3B", "CI", "UTIL"], "H", 18),
    "OF1": mk(["OF", "UTIL"], "H", 25), "Ohtani": mk(["UTIL"], "H", 40),
    "SP1": mk(["SP"], "P", 35), "RP1": mk(["RP"], "P", 10),
  };
  const entries = Object.entries(db).map(([name, val]) => ({ name, how: "$1", val, value: val.value }));
  const { slots, overflow } = global._dmAssignRoster(entries, {});
  assertEq(overflow.length, 0, "nobody overflows an 8-man roster");
  for (const s of slots) if (s.player) assert(global._dmSlotAccepts(s.type, s.player.val), s.player.name + " sits in an eligible " + s.type);
  assert(slots.find(s => s.type === "P" && s.player && s.player.name === "SP1"), "SP1 in a P slot");
  assert(slots.find(s => s.type === "Util" && s.player && s.player.name === "Ohtani"), "Ohtani (UTIL-only) in Util");
});

test("manual pin wins over autofill and reroutes the rest", () => {
  const mk = (elig, type, value) => ({ elig, type, value });
  const db = { "FB": mk(["1B", "CI", "UTIL"], "H", 20), "Mookie": mk(["SS", "MI", "2B", "UTIL"], "H", 30) };
  const entries = Object.entries(db).map(([name, val]) => ({ name, how: "$1", val, value: val.value }));
  const ci = global._dmAssignRoster([], {}).slots.findIndex(s => s.type === "CI");
  const { slots } = global._dmAssignRoster(entries, { "FB": ci });
  assertEq(slots[ci].player.name, "FB", "FB pinned to CI, not autofilled to 1B");
  assert(!slots.find(s => s.type === "1B" && s.player), "1B now empty (FB took its pin)");
});

// =====================================================================
section("App engines — freeform panel canvas (draft-mode.js)");
// =====================================================================

test("_dmPanelOrder: all panels once, canonical order by default", () => {
  const order = global._dmPanelOrder();
  assertEq(order.length, 10, "10 panels");
  assertEq(order[0], "hero", "hero first");
  assertEq(new Set(order).size, order.length, "no duplicates");
  ["hero", "board", "roster", "budgets", "standings", "noms", "history", "cats", "ai", "plan"]
    .forEach(id => assert(order.includes(id), id + " present"));
});

test("_dmSizesFromHeights: legacy heights fold into {h}, non-numbers dropped", () => {
  const s = global._dmSizesFromHeights({ board: 400, roster: 300, junk: "x" });
  assertEq(s.board.h, 400, "board height carried");
  assertEq(s.roster.h, 300, "roster height carried");
  assertEq("junk" in s, false, "non-numeric dropped");
});

test("_dmShelfPack: tiles left→right, wraps at the width, rows clear the tallest card", () => {
  // width 1000: a(400) b(400) fit one row (400+12+400=812); c(400) wraps under
  // the taller of a/b (h 300) + 12 gap → y=312. A full-width card takes its own row.
  const p = global._dmShelfPack([
    { id: "a", w: 400, h: 300 }, { id: "b", w: 400, h: 200 },
    { id: "c", w: 400, h: 200 }, { id: "wide", w: 1000, h: 150 },
  ], 1000);
  assertEq(p.a.x, 0, "a at x0"); assertEq(p.a.y, 0, "a at y0");
  assertEq(p.b.x, 412, "b beside a");
  assertEq(p.c.x, 0, "c wraps to x0"); assertEq(p.c.y, 312, "c under the tallest of row 1");
  assertEq(p.wide.y, 524, "wide card on its own next row");
  // startY offsets the whole packing (new cards go below pinned ones)
  assertEq(global._dmShelfPack([{ id: "z", w: 300, h: 100 }], 1000, 500).z.y, 500, "startY respected");
});

test("_dmSnapAxis: magnetic within radius, untouched outside", () => {
  assertEq(global._dmSnapAxis(103, [100, 200]), 100, "3px off → snaps to 100");
  assertEq(global._dmSnapAxis(115, [100, 200]), 115, "15px off → no snap");
  assertEq(global._dmSnapAxis(196, [100, 200]), 200, "nearest target wins");
  assertEq(global._dmSnapAxis(50, []), 50, "no targets → passthrough");
});

test("_dmSnapTargets: edge-align + 12px-gutter adjacency + canvas edges", () => {
  // one neighbor at (100,50) sized 300×200; dragged card 200×100; canvas 1000
  const t = global._dmSnapTargets(200, 100, [{ x: 100, y: 50, w: 300, h: 200 }], 1000);
  assert(t.x.includes(0) && t.x.includes(800), "canvas left + right edges");
  assert(t.x.includes(100), "left-align with neighbor");
  assert(t.x.includes(200), "right-align (400 − 200)");
  assert(t.x.includes(412), "butt against right side (400 + 12)");
  assert(t.x.includes(-112), "butt against left side (100 − 12 − 200)");
  assert(t.y.includes(50) && t.y.includes(150), "top-align + bottom-align");
  assert(t.y.includes(262) && t.y.includes(-62), "below + above with gutter");
});

test("_dmFitWidth: bounces back over clipped text, capped at canvas width", () => {
  assertEq(global._dmFitWidth(300, 0, 1000), 300, "no overflow → keep the chosen width");
  assertEq(global._dmFitWidth(300, 80, 1000), 380, "80px clipped → grow back 80");
  assertEq(global._dmFitWidth(300, -20, 1000), 300, "slack is not shrinkage");
  assertEq(global._dmFitWidth(950, 200, 1000), 1000, "growth capped at the canvas");
});

test("stats cells round counting stats; rates keep decimals", () => {
  const origProj = global.getProjection;
  global.getProjection = () => ({ type: "H", R: 62.1184, HR: 21.4417, RBI: 49.8923, SB: 9.4288, OBP: 0.387282 });
  let cells = global._dmStatCells("x");
  assert(cells.includes(">62<"), "R rounded to 62 (was 62.1184)");
  assert(cells.includes(">21<"), "HR rounded");
  assert(cells.includes(">0.387<"), "OBP keeps 3 decimals");
  global.getProjection = () => ({ type: "P", QS: 9.9994, K: 106.449, SV_HLD: 0, ERA: 2.81233, WHIP: 1.02246 });
  cells = global._dmStatCells("x");
  assert(cells.includes(">10<"), "QS rounded to 10");
  assert(cells.includes(">106<"), "K rounded");
  assert(cells.includes(">2.81<"), "ERA keeps 2 decimals");
  global.getProjection = origProj;
});

test("_dmSortByStat: sorts by the column's stat per player type; no projection sinks", () => {
  const origProj = global.getProjection;
  const PROJ = {
    "Hi R": { type: "H", R: 100, HR: 10 }, "Lo R": { type: "H", R: 50, HR: 30 },
    "Ace": { type: "P", QS: 25, ERA: 2.5 }, "Mid": { type: "P", QS: 12, ERA: 4.0 },
  };
  global.getProjection = (n) => PROJ[n] || null;
  const H = [{ name: "Lo R", value: 40, posKey: "OF" }, { name: "Hi R", value: 20, posKey: "OF" }, { name: "NoProj", value: 99, posKey: "OF" }];
  // col 0 = R for hitters: desc → Hi R first despite lower $; NoProj last despite top $
  let s = global._dmSortByStat(H, 0, "desc");
  assertEq(s.map(p => p.name).join(","), "Hi R,Lo R,NoProj", "R desc, missing last");
  s = global._dmSortByStat(H, 0, "asc");
  assertEq(s.map(p => p.name).join(","), "Lo R,Hi R,NoProj", "asc flips, missing still last");
  // col 1 = HR: Lo R (30) beats Hi R (10)
  s = global._dmSortByStat(H, 1, "desc");
  assertEq(s[0].name, "Lo R", "HR column uses the HR stat");
  // pitchers use the pitching key for the same column index (col 0 = QS)
  const P = [{ name: "Mid", value: 30, posKey: "SP" }, { name: "Ace", value: 10, posKey: "SP" }];
  s = global._dmSortByStat(P, 0, "desc");
  assertEq(s[0].name, "Ace", "QS column sorts pitchers by QS");
  global.getProjection = origProj;
});

test("stats header: sortable columns, ERA/WHIP default ascending, arrow on active", () => {
  let h = global._dmStatHead("P", null);
  assert(h.includes('data-dm-statsort="0"') && h.includes('data-dm-statsort="4"'), "all 5 columns sortable");
  assert(/data-dm-statsort="3" data-dm-sdef="asc"/.test(h), "ERA defaults ascending (lower is better)");
  assert(/data-dm-statsort="1" data-dm-sdef="desc"/.test(h), "K defaults descending");
  const hH = global._dmStatHead("H", null);
  assert(/data-dm-statsort="4" data-dm-sdef="desc"/.test(hH), "OBP (hitter col 4) defaults descending");
  assert(global._dmStatHead("H", { col: 2, dir: "desc" }).includes("RBI ▼"), "active column shows the arrow");
  assert(global._dmStatHead("P", { col: 3, dir: "asc" }).includes("ERA ▲"), "asc arrow on active");
});

test("stats header names the kind's stats; slash form only for mixed", () => {
  assert(global._dmStatHead("H").includes(">R<") && global._dmStatHead("H").includes(">OBP<"), "hitter header uses hitting names");
  assert(!global._dmStatHead("H").includes("R/QS"), "hitter header has no combined slash labels");
  assert(global._dmStatHead("P").includes(">QS<") && global._dmStatHead("P").includes(">WHIP<"), "pitcher header uses pitching names");
  assert(global._dmStatHead(null).includes("R/QS"), "mixed falls back to the slash form");
  assertEq(global._dmKindForMode("SS"), "H", "position mode → hitter header");
  assertEq(global._dmKindForMode("PIT"), "P", "PIT mode → pitcher header");
  assertEq(global._dmKindForMode("BPA"), null, "BPA → mixed (its two tables pass kind explicitly)");
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


// --------------------------------------------------------------------------
// Pause-safe watchdog (_feedStallState) — spec Q4 revision 2026-07-05:
// red "stalled" ONLY when silence began mid-lot; post-SOLD silence = pause.
// --------------------------------------------------------------------------
section("App engines — pause-safe watchdog (_feedStallState)");

test("watchdog: >30s silence after a SOLD reads as quiet/pause, not stalled", () => {
  const now = Date.now();
  global._feed.tabAt = now;                  // ESPN tab open (beat fresh)
  global._feed.lastFrameAt = now - 120000;   // 2 min of silence
  global._dlog.events = [
    { seq: 1, cmd: "NOMINATION", teamId: 2, playerId: 11, at: now - 200000 },
    { seq: 2, cmd: "BID", teamId: 2, playerId: 11, amount: 5, at: now - 190000 },
    { seq: 3, cmd: "SOLD", teamId: 2, playerId: 11, amount: 5, at: now - 120000 },
  ];
  global._dlog.lastEventAt = now - 120000;
  const st = global._feedStallState();
  assertEq(st.level, "quiet", "post-SOLD silence must be quiet");
  assertEq(st.midLot, false, "not mid-lot");
});

test("watchdog: >30s silence mid-bidding is stalled (red)", () => {
  const now = Date.now();
  global._feed.tabAt = now;
  global._feed.lastFrameAt = now - 45000;
  global._dlog.events = [
    { seq: 1, cmd: "NOMINATION", teamId: 2, playerId: 12, at: now - 60000 },
    { seq: 2, cmd: "BID", teamId: 3, playerId: 12, amount: 7, at: now - 45000 },
  ];
  global._dlog.lastEventAt = now - 45000;
  const st = global._feedStallState();
  assertEq(st.level, "stalled", "mid-lot silence must be stalled");
  assertEq(st.midLot, true, "mid-lot flag");
});


section("App engines — manual↔feed dedup (spec Q3)");

test("a manual pick later delivered by the feed is UPGRADED, never duplicated", () => {
  resetDraftState();
  global._liveDraft.picks.push({ player: "Juan Soto", pos: "OF", team: "jeff", price: 38, ts: Date.now() });   // manual: no espnPlayerId
  global.processEspnPicks([{ playerId: 39832, teamId: 5, bidAmount: 38, seq: 12, playerName: "Juan Soto" }]);
  assertEq(global._liveDraft.picks.length, 1, "no duplicate pick");
  assertEq(global._liveDraft.picks[0].espnPlayerId, 39832, "manual pick upgraded with ESPN id");
  assertEq(global._liveDraft.picks[0].espnSeq, 12, "lot seq attached");
});


section("App engines — stale heartbeat must not trigger transition/heal (Jul 5 render storm)");

test("hours-old stored beat: no renderDraft transition, no heal ping, staleInfo untouched", () => {
  resetDraftState();
  let renders = 0, pings = 0;
  const origRender = global.renderDraft;
  global.renderDraft = () => { renders++; };
  const origPost = global.window.postMessage;
  global.window.postMessage = (m) => { if (m && m.type === "ping") pings++; };
  global.currentView = "draft";
  global._feed.tabAt = 0;
  global._feed.staleInfo = { leagueId: "999", count: 5, at: Date.now() - 3600000 };
  global._feed.staleRetained = { leagueId: "999", sport: "flb", updatedAt: Date.now() - 3600000, picks: [] };
  const staleBeat = { at: Date.now() - 2 * 3600 * 1000, leagueId: 999, sport: "flb" };
  for (let i = 0; i < 50; i++) global._onDraftTabPresent(staleBeat);
  global.renderDraft = origRender;
  global.window.postMessage = origPost;
  global.currentView = "x";
  assertEq(renders, 0, "stale beats must never re-render");
  assertEq(pings, 0, "stale beats must never ping the extension");
  assert(!!global._feed.staleInfo, "stale gate stays set");
});

test("fresh beat heals ONCE (staleInfo cleared, single ping)", () => {
  let pings = 0;
  const origPost = global.window.postMessage;
  global.window.postMessage = (m) => { if (m && m.type === "ping") pings++; };
  const origRender = global.renderDraft;
  global.renderDraft = () => {};
  global._feed.tabAt = 0;
  global._feed._lastHealPing = 0;
  global._feed.staleInfo = { leagueId: "999", count: 5, at: Date.now() - 3600000 };
  global._feed.staleRetained = null;
  global._onDraftTabPresent({ at: Date.now(), leagueId: 999, sport: "flb" });
  global._onDraftTabPresent({ at: Date.now(), leagueId: 999, sport: "flb" });
  global.window.postMessage = origPost;
  global.renderDraft = origRender;
  assertEq(global._feed.staleInfo, null, "gate cleared by the fresh beat");
  assertEq(pings, 1, "heal pings once (debounced)");
});


section("App engines — mock leftovers purged on entering Real mode");

test("setFeedMode('real') clears picks from a non-home stream; manual picks survive", () => {
  const prevMode = global.getFeedMode();   // async suite may be mid-flight — restore its mode
  resetDraftState();
  // Reconcile now DISCARDS mock/foreign picks and RELOADS the real draft from
  // its own (synced) key (never writes an empty list there — that would clobber
  // the cloud copy, R9). Clear the real key so the reload finds nothing → 0.
  global.localStorage.removeItem("ud_live_draft_v1");
  global.localStorage.removeItem("ud_live_draft_bk_v1");
  global._liveDraft.streamKey = "999777:12345";   // a mock stream
  global._liveDraft.picks.push({ player: "Paul Skenes", team: "espn:3", espnTeamId: 3, price: 40, espnPlayerId: 111, espnSeq: 1 });
  global.setFeedMode("real");
  assertEq(global._liveDraft.picks.length, 0, "mock-stream picks purged (real key empty)");
  assertEq(global._liveDraft.streamKey, null, "stream identity reset");
  // manual picks with no stream identity are kept
  global._liveDraft.picks.push({ player: "Manual Guy", team: "jeff", price: 5 });
  global.setFeedMode("real");
  assertEq(global._liveDraft.picks.length, 1, "manual (no-stream) picks kept");
  resetDraftState();   // don't leak state into the async suite still in flight
  global.setFeedMode(prevMode);
});
