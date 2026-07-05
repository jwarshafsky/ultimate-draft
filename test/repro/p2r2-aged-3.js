// P2R2 AGED-STATE FINDING 3 (HIGH)
// ---------------------------------------------------------------------------
// SCENARIO: an aged `ud_league_override` (left set by a past mock) forces Real
// mode to behave as Test — on draft day.
//
// Both `ud_league_override` AND `ud_feed_mode` are device-synced
// (SYNC_EXACT_KEYS, cloud-sync.js lines 25/37).  Path:
//   1. On the desktop Jeff runs a mock via the lobby: applying a throwaway
//      league URL calls setLeagueOverride(9999999) + setFeedMode("test").
//      `ud_league_override=9999999` is pushed to Cloudflare KV.  The override
//      key is NEVER cleared when the mock ends.
//   2. Later he opens the REAL draft flow and the feed mode is "real".
//   3. cloud-sync pulls the aged `ud_league_override=9999999` and reloads. The
//      app COLD-STARTS: espn.js reads ESPN.leagueId = 9999999 at module load,
//      so leagueOverrideActive() is true.  draftTestMode() =
//      leagueOverrideActive() || mode==="test" → TRUE, though mode === "real".
//
// setFeedMode("real")'s override-clear (draft.js:741) only runs on a button
// CLICK — nothing reconciles the aged override against Real mode at load.
//
// WHAT JEFF SEES on draft day: he is in Real mode, but the app shows generic
// "Team N" strangers, $260 flat budgets, NO keepers, and the FULL pool (his kept
// players all "available").  His actual draft is silently a mock.
//
// VIOLATED SPEC: S-003 (setFeedMode('real') MUST clear any test-league override)
// — the guarantee only holds through the button; a synced/aged override defeats
// it at load.  Also S-019 (Real mode MUST use real owners + keepers) and
// S-011/S-013 firing while mode is "real".
//
// This repro loads the REAL espn.js + engines and FAILS if draftTestMode() is
// true while ud_feed_mode === "real".

const fs = require("fs");
const { makeLocalStorageStub } = require("../helpers.js");

const APP = "/Users/jwars/Desktop/Claude/ultimate-draft/js/";
const realLog = console.log.bind(console);

function normalizePlayerName(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
}
const VALUES = [
  { name: "Aaron Judge", posKey: "OF", team: "NYY", type: "H", value: 40 },
  { name: "Mookie Betts", posKey: "SS", team: "LAD", type: "H", value: 34 },
  { name: "Jose Ramirez", posKey: "3B", team: "CLE", type: "H", value: 30 },
  { name: "Prospect Stash", posKey: "OF", team: "AAA", type: "H", value: 5 },
];
const VAL_BY_NAME = Object.fromEntries(VALUES.map(v => [v.name.toLowerCase(), v]));
const KEEPER_SELECTIONS = {
  jeff: { "Aaron Judge": { keeper: true }, "Prospect Stash": { minorKeeper: true } },
  matt: { "Jose Ramirez": { keeper: true } },
};
const KEEPER_SALARY = { "aaron judge": 10, "jose ramirez": 22 };
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

const mkEl = () => ({ addEventListener() {}, appendChild() {}, click() {}, remove() {}, setAttribute() {}, getAttribute() { return null; }, style: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, dataset: {}, focus() {}, closest() { return null; }, querySelectorAll() { return []; }, querySelector() { return null; }, innerHTML: "", textContent: "", value: "", title: "", className: "" });
const doc = { addEventListener() {}, getElementById() { return mkEl(); }, querySelectorAll() { return []; }, querySelector() { return null; }, createElement() { return mkEl(); }, body: { classList: { add() {}, remove() {}, toggle() {} }, appendChild() {} }, activeElement: null };
const win = { addEventListener() {}, removeEventListener() {}, postMessage() {}, location: { origin: "https://jwarshafsky.github.io", pathname: "/", search: "" } };

// COLD START: Real mode, aged mock override still present.
const ls = makeLocalStorageStub({
  ud_feed_mode: "real",             // draft day — Real mode
  ud_league_override: "9999999",    // aged leftover from a past mock (synced)
});

// Globals the engines expect. NOTE: we do NOT define UD_HOME_LEAGUE_ID, ESPN,
// leagueOverrideActive, processEspnPicks, espnTeamIdToOwnerId — the REAL espn.js
// provides them, so this exercises the real override→testMode wiring.
const g = {
  window: win, document: doc, localStorage: ls, location: win.location,
  console: { log() {}, warn() {}, error() {} },
  setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  URL: { createObjectURL: () => "", revokeObjectURL: () => {} }, Blob: function () {}, Date,
  fetch: async () => ({ ok: false, json: async () => ({}) }),
  LEAGUE, VALUATION: { hitBudgetPct: 0.70 },
  getValues: () => VALUES,
  getPlayerValue: (name) => VAL_BY_NAME[normalizePlayerName(name)] || null,
  normalizePlayerName, esc: (s) => String(s), setStatus() {},
  currentView: "x",
  getMyTeam: () => LEAGUE.teams.find(t => t.isMe) || null,
  getTeam: (id) => LEAGUE.teams.find(t => t.id === id) || null,
  getKeeperSelections: () => KEEPER_SELECTIONS,
  getEffectiveKeeperSelections: () => KEEPER_SELECTIONS,
  getCurrentKeeperSalary: (name) => { const v = KEEPER_SALARY[normalizePlayerName(name)]; return typeof v === "number" ? v : null; },
  getLeagueContractByName: () => null,
  getNfbc: () => null, getStatcast: () => null, statcastBuySell: () => null,
  getDraftDollarAdjustment: () => 0, getProjection: () => null, getNote: () => null,
  getFlaggedPlayers: () => [], classifyPriceVsTargets: () => null,
  renderTagIcons: () => "", renderTargetBadge: () => "", ensureRotowireNews() {},
  logDraftEvents() {}, draftLogStatus: () => ({ sessionId: null, pending: 0 }),
  coreNameKey: (s) => normalizePlayerName(s),
  renderDraftSetup() {}, renderCategoryDashboard: () => "", renderAiAssistantPanel: () => "",
  wireAiPanel() {}, renderInflationCurve: () => "", renderSpendingPace: () => "",
  renderPlayerNewsBlock: () => "", wirePlayerNewsBlock() {}, renderInvariantsLine: () => "",
  openDebrief() {}, closeDebrief() {}, openNoteEditor() {}, recordInflationSnapshot() {},
  getMyRoster: () => [], projectTeamCategories: () => null, aggregateCats: () => null,
  strategyForAi: () => null, computeMockStandings: () => null,
  updateDraftDiagnostics() {}, updateDraftModeLive() {},
  UD_DEFAULT_PROXY_URL: "https://example.invalid",
};
for (const k of Object.keys(g)) global[k] = g[k];

// Load the REAL files — espn.js FIRST (defines UD_HOME_LEAGUE_ID, ESPN,
// leagueOverrideActive, processEspnPicks, espnTeamIdToOwnerId), then the engines.
const files = [
  "data/espn.js",
  "data/budget-adjust.js", "core/inflation.js", "features/endgame.js",
  "features/nominations.js", "features/draft.js", "features/draft-mode.js",
];
let bundle = files.map(f => fs.readFileSync(APP + f, "utf8")).join("\n;\n");
bundle += "\n;globalThis._liveDraft=_liveDraft;globalThis._dlog=_dlog;globalThis._feed=_feed;globalThis.ESPN=ESPN;";
(0, eval)(bundle);

const mode = global.getFeedMode();
const overrideActive = global.leagueOverrideActive();
const test = global.draftTestMode();
const excluded = global.draftExcludedNames();
const teams = global.draftTeams();

realLog("cold-start: ud_feed_mode=" + mode +
  " ESPN.leagueId=" + global.ESPN.leagueId +
  " leagueOverrideActive=" + overrideActive +
  " draftTestMode=" + test);
realLog("draftExcludedNames size (real keepers) = " + excluded.size +
  "  (expected 3: Judge/Ramirez/Prospect Stash)");
realLog("draftTeams[0] = " + JSON.stringify(teams[0]) +
  "  (expected a REAL owner, NOT 'espn:N')");

if (mode === "real" && test === true) {
  realLog("\n\x1b[31mFAIL (bug reproduced)\x1b[0m: ud_feed_mode is 'real' but an aged " +
    "ud_league_override forces draftTestMode()=true — Real mode is silently a mock. Real keepers " +
    "excluded=" + excluded.size + " (should be 3), first team id=" + (teams[0] && teams[0].id) +
    " (should be a real owner). Spec S-003/S-019 violated at load.");
  process.exitCode = 1;
} else {
  realLog("\n\x1b[32mPASS\x1b[0m: Real mode ignored the aged override; draftTestMode()=false.");
}
