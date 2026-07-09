// r16 shared harness — loads the REAL engine files into a vm sandbox, exactly
// like test/ud-mock.test.js makeSandbox(), but with a CONTROLLABLE clock and a
// setTimeout that CAPTURES callbacks into a queue so timer-driven paths (pause,
// user clock, AI churn) can be driven manually. Nothing here edits app source.

const fs = require("fs");
const vm = require("vm");
const path = require("path");

const APP = path.resolve(__dirname, "../..");

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildPool() {
  // Enough per position to fill twelve 26-man rosters. Values descend.
  const plan = [
    ["C", 30], ["1B", 30], ["2B", 30], ["SS", 30], ["3B", 30],
    ["OF", 90], ["SP", 110], ["RP", 70],
  ];
  const pool = [];
  let v = 45;
  for (const [pos, n] of plan) {
    for (let i = 0; i < n; i++) {
      const value = Math.max(1, v - i * 1.3);
      const type = (pos === "SP" || pos === "RP") ? "P" : "H";
      pool.push({ name: pos + "_" + i, value: Math.round(value), posKey: pos, elig: [pos], type });
    }
  }
  return pool;
}

function makeSandbox(seed, opts) {
  opts = opts || {};
  const M = Object.create(Math);
  M.random = mulberry32(seed);

  const pool = buildPool();
  const localStore = {};
  const winListeners = [];
  const logCalls = [];

  // --- controllable clock + capturing timer queue ---
  const clock = { t: 1_700_000_000_000 };
  const timers = [];           // {id, fn, at}
  let timerId = 1;
  const sandbox = {};
  sandbox.console = { log() {}, error() {}, warn() {} };
  sandbox.Date = { now: () => clock.t };
  sandbox.Math = M;
  sandbox.JSON = JSON; sandbox.Set = Set; sandbox.Map = Map;
  sandbox.Array = Array; sandbox.Object = Object; sandbox.Number = Number; sandbox.String = String;
  sandbox.Boolean = Boolean; sandbox.RegExp = RegExp; sandbox.isFinite = isFinite;
  sandbox.parseInt = parseInt; sandbox.parseFloat = parseFloat; sandbox.isNaN = isNaN;
  sandbox.Error = Error;
  if (opts.captureTimers) {
    sandbox.setTimeout = (fn, ms) => { const id = timerId++; timers.push({ id, fn, at: clock.t + (ms || 0) }); return id; };
    sandbox.clearTimeout = (id) => { const i = timers.findIndex(x => x.id === id); if (i >= 0) timers.splice(i, 1); };
  } else {
    sandbox.setTimeout = () => 0; sandbox.clearTimeout = () => {};
  }
  sandbox.setInterval = () => 0; sandbox.clearInterval = () => {};
  sandbox.alert = () => {};
  sandbox.confirm = () => false;
  sandbox.location = { origin: "https://app.test", pathname: "/", search: "" };

  sandbox.localStorage = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(localStore, k) ? localStore[k] : null; },
    setItem(k, v) { localStore[k] = String(v); },
    removeItem(k) { delete localStore[k]; },
  };
  sandbox.document = {
    getElementById() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    body: { classList: { add() {}, remove() {}, toggle() {} } },
    createElement() { return { style: {}, appendChild() {}, click() {}, remove() {} }; },
  };
  sandbox.window = {
    postMessage(msg) { const ev = { source: sandbox.window, data: msg }; winListeners.forEach(fn => { try { fn(ev); } catch (e) {} }); },
    addEventListener(type, fn) { if (type === "message") winListeners.push(fn); },
  };
  sandbox.self = sandbox.window;
  sandbox.globalThis = sandbox;

  sandbox.LEAGUE = opts.LEAGUE || {
    teams: [
      { id: "matt", name: "Matt", owner: "Matt" }, { id: "saxton", name: "Saxton", owner: "Saxton" },
      { id: "sam", name: "Sam", owner: "Sam" }, { id: "glix", name: "Glix", owner: "Glix" },
      { id: "jeff", name: "Jeff", owner: "Jeff", isMe: true }, { id: "aj", name: "AJ", owner: "AJ" },
      { id: "corey", name: "Corey", owner: "Corey" }, { id: "jd", name: "JD", owner: "JD" },
      { id: "wein", name: "Wein", owner: "Wein" }, { id: "klin", name: "Klin", owner: "Klin" },
      { id: "dave", name: "Dave", owner: "Dave" }, { id: "jtl", name: "JTL", owner: "JTL" },
    ],
    draftBudget: 260, numTeams: 12, luxuryTax: 350, rosterSize: 26,
    hitCats: ["R", "HR", "RBI", "SB", "OBP"], pitCats: ["QS", "K", "SV_HLD", "ERA", "WHIP"],
  };
  sandbox.VALUATION = { hitBudgetPct: 0.66, minDollar: 1 };
  sandbox.UD_HOME_LEAGUE_ID = 1200;

  sandbox.getMyTeam = () => sandbox.LEAGUE.teams.find(t => t.isMe);
  sandbox.getTeam = (id) => sandbox.LEAGUE.teams.find(t => t.id === id);
  sandbox.getKeeperSelections = opts.getKeeperSelections || (() => ({}));
  sandbox.getEffectiveKeeperSelections = opts.getEffectiveKeeperSelections || (() => ({}));
  sandbox.getCurrentKeeperSalary = opts.getCurrentKeeperSalary || (() => null);
  sandbox.getLeagueContractByName = opts.getLeagueContractByName || (() => null);
  sandbox.getBudgetAdjustment = opts.getBudgetAdjustment || (() => 0);
  sandbox.getDraftDollarAdjustment = () => 0;
  sandbox.getFlaggedPlayers = () => [];
  sandbox.getMyRoster = () => [];
  sandbox.projectTeamCategories = () => ({ ranks: {} });
  sandbox.esc = (s) => String(s == null ? "" : s);
  sandbox.setStatus = () => {};
  sandbox.getNfbc = () => null;
  sandbox.getStatcast = () => null;
  sandbox.statcastBuySell = () => null;
  sandbox.classifyPriceVsTargets = () => null;
  sandbox.renderTagIcons = () => "";
  sandbox.renderTargetBadge = () => "";
  sandbox.logDraftEvents = (meta, events, isMock) => { logCalls.push({ isMock, n: (events || []).length }); };
  sandbox.draftLogStatus = () => ({ sessionId: null, pending: 0, uploadedSeq: 0, isMock: true });
  sandbox.recordInflationSnapshot = () => {};
  sandbox.ensureRotowireNews = () => {};
  sandbox.fetchEspnPlayers = null;

  const ESPN_TEAM_ID_MAP = { 1: "matt", 2: "saxton", 3: "sam", 4: "glix", 5: "jeff", 6: "aj", 7: "corey", 8: "jd", 9: "wein", 10: "klin", 11: "dave", 12: "jtl" };
  sandbox.ESPN_TEAM_ID_MAP = ESPN_TEAM_ID_MAP;
  sandbox.espnTeamIdToOwnerId = (id) => ESPN_TEAM_ID_MAP[id] || null;
  sandbox.renderNominationsPanel = () => "";
  sandbox.wireNominationsPanel = () => {};
  sandbox.renderCategoryDashboard = () => "";
  sandbox.ESPN = { leagueId: 1200, listeners: [], polling: false, proxyUrl: "" };
  sandbox.leagueOverrideActive = () => sandbox.ESPN.leagueId !== sandbox.UD_HOME_LEAGUE_ID;
  sandbox.setLeagueOverride = (id) => {
    const n = Number(id);
    if (isFinite(n) && n > 0 && n !== sandbox.UD_HOME_LEAGUE_ID) { sandbox.ESPN.leagueId = n; localStore["ud_league_override"] = String(n); }
    else { sandbox.ESPN.leagueId = sandbox.UD_HOME_LEAGUE_ID; delete localStore["ud_league_override"]; }
  };

  const byName = new Map(pool.map(p => [p.name, p]));
  const valuesList = pool.slice().sort((a, b) => b.value - a.value);
  sandbox.getValues = () => valuesList;
  sandbox.getPlayerValue = (name) => byName.get(name) || null;
  sandbox.normalizePlayerName = (s) => {
    if (!s) return "";
    let n = String(s).normalize("NFD").replace(/[̀-ͯ]/g, "");
    n = n.toLowerCase().replace(/[.'`’]/g, "").replace(/[^a-z0-9 ]/g, " ");
    n = n.replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "");
    return n.replace(/\s+/g, " ").trim();
  };
  sandbox.coreNameKey = (name) => sandbox.normalizePlayerName(name);
  sandbox.currentView = "overview";

  vm.createContext(sandbox);

  const files = [
    "js/core/inflation.js",
    "js/core/mock-engine.js",
    "js/core/mock-interactive.js",
    "js/features/endgame.js",
    "js/features/draft-mode.js",
    "js/features/draft.js",
    "js/core/invariants.js",
    "js/features/ai-assistant.js",
    "js/features/mock-live-feed.js",
  ];
  let program = files.map(rel => "\n//==== " + rel + " ====\n" + fs.readFileSync(path.join(APP, rel), "utf8")).join("\n");
  program += "\n//==== spliced processEspnPicks ====\n" + extractFunction(fs.readFileSync(path.join(APP, "js/data/espn.js"), "utf8"), "processEspnPicks");
  program += "\nglobalThis.__ud = {" +
    " get liveDraft(){return _liveDraft;}," +
    " get dlog(){return _dlog;}," +
    " eval: function(code){ return eval(code); }" +
    "};\n";
  vm.runInContext(program, sandbox, { filename: "r16-concat.js" });

  return { sandbox, ud: sandbox.__ud, logCalls, clock, timers };
}

function extractFunction(src, name) {
  const start = src.indexOf("function " + name);
  if (start < 0) throw new Error("extractFunction: " + name + " not found");
  const braceOpen = src.indexOf("{", start);
  let depth = 0, i = braceOpen;
  for (; i < src.length; i++) { const c = src[i]; if (c === "{") depth++; else if (c === "}") { depth--; if (depth === 0) { i++; break; } } }
  return src.slice(start, i);
}

module.exports = { makeSandbox, buildPool };
