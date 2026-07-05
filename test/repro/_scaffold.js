// Shared scaffold for p2r1 repro scripts. Mirrors test/app-engines.test.js's
// installGlobals so each repro loads the REAL engine files into a stubbed
// global. Overrides let a repro inject data-global behavior (keeper salaries,
// contracts, value pools) to drive a specific edge case.
//
// Nothing here modifies app source. Exports installGlobals + a few helpers.

const fs = require("fs");
const { makeLocalStorageStub } = require("../helpers.js");

const APP = "/Users/jwars/Desktop/Claude/ultimate-draft/js/";

function normalizePlayerName(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
}

function mkEl() {
  return { addEventListener() {}, appendChild() {}, click() {}, remove() {}, setAttribute() {}, getAttribute() { return null; }, style: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, dataset: {}, focus() {}, closest() { return null; }, querySelectorAll() { return []; }, querySelector() { return null; }, innerHTML: "", textContent: "", value: "", title: "", className: "" };
}

function installGlobals(overrides) {
  overrides = overrides || {};
  const ls = makeLocalStorageStub(overrides.localStorage || {});
  const doc = {
    addEventListener() {}, getElementById() { return mkEl(); },
    querySelectorAll() { return []; }, querySelector() { return null; },
    createElement() { return mkEl(); },
    body: { classList: { add() {}, remove() {}, toggle() {} }, appendChild() {} },
    activeElement: null,
  };
  const win = { addEventListener() {}, removeEventListener() {}, postMessage() {},
    location: { origin: "https://jwarshafsky.github.io", pathname: "/", search: "" } };

  const LEAGUE = overrides.LEAGUE || {
    draftBudget: 260, rosterSize: 26, numTeams: 12,
    teams: [
      { id: "matt", owner: "Matt" }, { id: "saxton", owner: "Saxton" },
      { id: "sam", owner: "Sam" }, { id: "glix", owner: "Glix" },
      { id: "jeff", owner: "Jeff", isMe: true }, { id: "aj", owner: "AJ" },
      { id: "corey", owner: "Corey" }, { id: "jd", owner: "JD" },
      { id: "wein", owner: "Wein" }, { id: "klin", owner: "Klin" },
      { id: "dave", owner: "Dave" }, { id: "jtl", owner: "JTL" },
    ],
  };
  const ESPN_TEAM_ID_MAP = { 1: "matt", 2: "saxton", 3: "sam", 4: "glix", 5: "jeff",
    6: "aj", 7: "corey", 8: "jd", 9: "wein", 10: "klin", 12: "dave", 13: "jtl" };

  const VALUES = overrides.VALUES || [];
  const VAL_BY_NAME = Object.fromEntries(VALUES.map(v => [normalizePlayerName(v.name), v]));

  const g = {
    window: win, document: doc, localStorage: ls, location: win.location,
    console: { log() {}, warn() {}, error() {} },
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    URL: { createObjectURL: () => "", revokeObjectURL: () => {} }, Blob: function () {}, Date,

    LEAGUE, UD_HOME_LEAGUE_ID: 1200,
    VALUATION: overrides.VALUATION || { hitBudgetPct: 0.70 },
    getValues: overrides.getValues || (() => VALUES),
    getPlayerValue: overrides.getPlayerValue || ((name) => VAL_BY_NAME[normalizePlayerName(name)] || null),
    normalizePlayerName, esc: (s) => String(s), setStatus() {},
    currentView: overrides.currentView != null ? overrides.currentView : "x",

    getMyTeam: () => LEAGUE.teams.find(t => t.isMe) || null,
    getTeam: (id) => LEAGUE.teams.find(t => t.id === id) || null,
    espnTeamIdToOwnerId: (espnId) => ESPN_TEAM_ID_MAP[espnId] || null,

    getKeeperSelections: overrides.getKeeperSelections || (() => overrides.KEEPER_SELECTIONS || {}),
    getEffectiveKeeperSelections: overrides.getEffectiveKeeperSelections || (() => overrides.KEEPER_SELECTIONS || {}),
    getCurrentKeeperSalary: overrides.getCurrentKeeperSalary || (() => null),
    getLeagueContractByName: overrides.getLeagueContractByName || (() => null),

    getNfbc: overrides.getNfbc || (() => null), getStatcast: () => null, statcastBuySell: () => null,
    getDraftDollarAdjustment: overrides.getDraftDollarAdjustment || (() => 0),
    getProjection: overrides.getProjection || (() => null), getNote: () => null,
    getFlaggedPlayers: () => [], classifyPriceVsTargets: () => null,
    renderTagIcons: () => "", renderTargetBadge: () => "", ensureRotowireNews() {},
    fetchEspnPlayers: async () => ({ players: [] }), logDraftEvents() {},
    draftLogStatus: () => ({ sessionId: null, pending: 0 }),
    coreNameKey: (s) => normalizePlayerName(s),

    renderDraftSetup() {}, renderCategoryDashboard: () => "", renderAiAssistantPanel: () => "",
    wireAiPanel() {}, renderInflationCurve: () => "", renderSpendingPace: () => "",
    renderPlayerNewsBlock: () => "", wirePlayerNewsBlock() {}, renderInvariantsLine: () => "",
    openDebrief() {}, closeDebrief() {}, openNoteEditor() {}, recordInflationSnapshot() {},
    getMyRoster: () => [], projectTeamCategories: overrides.projectTeamCategories || (() => null),
    aggregateCats: overrides.aggregateCats || (() => null), strategyForAi: () => null,
    computeMockStandings: overrides.computeMockStandings || (() => null),
    leagueOverrideActive: overrides.leagueOverrideActive || (() => false),
    setLeagueOverride: () => {},
  };
  for (const k of Object.keys(g)) global[k] = g[k];

  const files = [
    "data/budget-adjust.js", "core/inflation.js", "features/endgame.js",
    "features/nominations.js", "features/draft.js", "features/draft-mode.js",
  ];
  let bundle = files.map(f => fs.readFileSync(APP + f, "utf8")).join("\n;\n");
  bundle += "\n;globalThis._liveDraft=_liveDraft;globalThis._dlog=_dlog;globalThis._feed=_feed;";
  (0, eval)(bundle);

  return { ls, doc, win, LEAGUE, VALUES, ESPN_TEAM_ID_MAP };
}

function resetDraftState() {
  global._liveDraft.picks = []; global._liveDraft.deleted = {};
  global._liveDraft.current = null; global._liveDraft.highBid = 0; global._liveDraft.highBidder = null;
  global._dlog.leagueId = null; global._dlog.startedAt = 0; global._dlog.events = [];
  global._dlog.lastEventAt = 0; global._dlog.initState = null;
  global._feed.staleInfo = null; global._feed.connected = false; global._feed.tabAt = 0;
}

module.exports = { installGlobals, resetDraftState, normalizePlayerName };
