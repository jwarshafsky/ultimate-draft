// Shared app-engine loader for the p2r1 state-machine repros. Mirrors the
// stubbing/loading approach of test/app-engines.test.js (installGlobals) but as a
// reusable module so each repro script stays focused on ONE state trace.
// Nothing here modifies app/extension source — files are only READ + eval'd.

const fs = require("fs");
const { makeLocalStorageStub } = require("../helpers.js");

// install() replaces global.console with a no-op (engine IIFEs log noisily).
// Capture the REAL console up front so repros can still report findings.
const realConsole = { log: console.log.bind(console), error: console.error.bind(console) };

const APP = "/Users/jwars/Desktop/Claude/ultimate-draft/js/";

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

const KEEPER_SELECTIONS = {
  jeff: { "Aaron Judge": { keeper: true }, "Prospect Stash": { minorKeeper: true } },
  matt: { "Jose Ramirez": { keeper: true } },
};
const KEEPER_SALARY = { "aaron judge": 10, "jose ramirez": 22 };

function normalizePlayerName(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
}

const LEAGUE = {
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
const ESPN_TEAM_ID_MAP = {
  1: "matt", 2: "saxton", 3: "sam", 4: "glix", 5: "jeff",
  6: "aj", 7: "corey", 8: "jd", 9: "wein", 10: "klin", 12: "dave", 13: "jtl",
};

function install(overrides) {
  overrides = overrides || {};
  const ls = makeLocalStorageStub(overrides.localStorage || {});
  const mkEl = () => ({ addEventListener() {}, appendChild() {}, click() {}, remove() {}, setAttribute() {}, getAttribute() { return null; }, style: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, dataset: {}, focus() {}, closest() { return null; }, querySelectorAll() { return []; }, querySelector() { return null; }, innerHTML: "", textContent: "", value: "", title: "", className: "" });
  const doc = { addEventListener() {}, getElementById() { return mkEl(); }, querySelectorAll() { return []; }, querySelector() { return null; }, createElement() { return mkEl(); }, body: { classList: { add() {}, remove() {}, toggle() {} }, appendChild() {} }, activeElement: null };
  const win = { addEventListener() {}, removeEventListener() {}, postMessage() {}, location: { origin: "https://jwarshafsky.github.io", pathname: "/", search: "" } };

  const g = {
    window: win, document: doc, localStorage: ls, location: win.location,
    console: { log() {}, warn() {}, error() {} },
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    URL: { createObjectURL: () => "", revokeObjectURL: () => {} }, Blob: function () {}, Date,
    LEAGUE: overrides.LEAGUE || LEAGUE, UD_HOME_LEAGUE_ID: 1200,
    VALUATION: { hitBudgetPct: 0.70 },
    getValues: overrides.getValues || (() => VALUES),
    getPlayerValue: (name) => VAL_BY_NAME[normalizePlayerName(name)] || null,
    normalizePlayerName, esc: (s) => String(s), setStatus() {},
    currentView: overrides.currentView != null ? overrides.currentView : "x",
    getMyTeam: () => LEAGUE.teams.find((t) => t.isMe) || null,
    getTeam: (id) => LEAGUE.teams.find((t) => t.id === id) || null,
    espnTeamIdToOwnerId: (espnId) => ESPN_TEAM_ID_MAP[espnId] || null,
    getKeeperSelections: () => KEEPER_SELECTIONS,
    getEffectiveKeeperSelections: overrides.getEffectiveKeeperSelections || (() => KEEPER_SELECTIONS),
    getCurrentKeeperSalary: (name) => { const v = KEEPER_SALARY[normalizePlayerName(name)]; return typeof v === "number" ? v : null; },
    getLeagueContractByName: () => null,
    getNfbc: () => null, getStatcast: () => null, statcastBuySell: () => null,
    getDraftDollarAdjustment: () => 0, getProjection: () => null, getNote: () => null,
    getFlaggedPlayers: () => [], classifyPriceVsTargets: () => null,
    renderTagIcons: () => "", renderTargetBadge: () => "", ensureRotowireNews() {},
    fetchEspnPlayers: overrides.fetchEspnPlayers || (async () => ({ players: [] })),
    logDraftEvents: overrides.logDraftEvents || function () {},
    draftLogStatus: () => ({ sessionId: null, pending: 0 }),
    coreNameKey: (s) => normalizePlayerName(s),
    renderDraftSetup() {}, renderCategoryDashboard: () => "", renderAiAssistantPanel: () => "",
    wireAiPanel() {}, renderInflationCurve: () => "", renderSpendingPace: () => "",
    renderPlayerNewsBlock: () => "", wirePlayerNewsBlock() {}, renderInvariantsLine: () => "",
    openDebrief() {}, closeDebrief() {}, openNoteEditor() {}, recordInflationSnapshot() {},
    getMyRoster: () => [], projectTeamCategories: () => null, aggregateCats: () => null,
    strategyForAi: () => null, computeMockStandings: () => null,
    updateDraftDiagnostics() {}, updateDraftModeLive() {},
  };
  for (const k of Object.keys(g)) global[k] = g[k];

  const files = [
    "data/budget-adjust.js", "core/inflation.js", "features/endgame.js",
    "features/nominations.js", "features/draft.js", "features/draft-mode.js",
  ];
  let bundle = files.map((f) => fs.readFileSync(APP + f, "utf8")).join("\n;\n");
  bundle += "\n;globalThis._liveDraft=_liveDraft;globalThis._dlog=_dlog;globalThis._feed=_feed;";
  (0, eval)(bundle);

  // processEspnPicks (real logic from espn.js) — mirrors the source exactly.
  global.processEspnPicks = function (rawPicks) {
    const existing = new Set(global._liveDraft.picks.map((p) => p.espnPlayerId).filter(Boolean));
    const _penNk = global.normalizePlayerName;
    let added = 0;
    for (const raw of rawPicks) {
      if (existing.has(raw.playerId)) continue;
      const manual = raw.playerName && global._liveDraft.picks.find((p) =>
        p.espnPlayerId == null && _penNk(p.player) === _penNk(raw.playerName));
      if (manual) {
        manual.espnPlayerId = raw.playerId; manual.espnTeamId = raw.teamId;
        manual.espnSeq = raw.seq != null ? raw.seq : null; existing.add(raw.playerId); added++; continue;
      }
      global._liveDraft.picks.push({
        player: raw.playerName, pos: global.getPlayerValue(raw.playerName)?.posKey || null,
        team: (typeof global.draftTestMode === "function" && global.draftTestMode()) ? ("espn:" + raw.teamId) : global.espnTeamIdToOwnerId(raw.teamId),
        espnTeamId: raw.teamId, price: (raw.bidAmount > 0 ? raw.bidAmount : 1),
        ts: Date.now(), espnPlayerId: raw.playerId, espnSeq: raw.seq != null ? raw.seq : null,
      });
      added++;
    }
    if (added && global.saveLiveDraft) global.saveLiveDraft();
    return added;
  };

  return { VALUES, LEAGUE };
}

function setRealMode() { global.localStorage.setItem("ud_feed_mode", "real"); global.localStorage.removeItem("ud_league_override"); }
function setTestMode() { global.localStorage.setItem("ud_feed_mode", "test"); }
function setOffMode() { global.localStorage.setItem("ud_feed_mode", "off"); }

function resetDraftState() {
  global._liveDraft.picks = []; global._liveDraft.deleted = {}; global._liveDraft.current = null;
  global._liveDraft.highBid = 0; global._liveDraft.highBidder = null;
  global._dlog.leagueId = null; global._dlog.startedAt = 0; global._dlog.events = [];
  global._dlog.lastEventAt = 0; global._dlog.initState = null;
  global._feed.staleInfo = null; global._feed.connected = false; global._feed.tabAt = 0;
  global._feed.leagueId = null;
}

module.exports = { install, setRealMode, setTestMode, setOffMode, resetDraftState, normalizePlayerName, realConsole };
