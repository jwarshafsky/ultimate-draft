// R15 EPHEMERAL-GUARANTEES instrumented sandbox (shared harness).
//
// Loads the REAL engine files PLUS the REAL cloud-sync.js into one vm sandbox
// (the browser's single shared scope), then wraps localStorage.setItem /
// removeItem and the Supabase stub to RECORD every write with a stack. Because
// cloud-sync.js's real Storage.prototype patch runs, the log also captures which
// keys the REAL sync logic enqueued for a Cloudflare-KV push (dirty set) — i.e.
// which writes would cross devices. This is the proof surface for R15.
//
// Not a test file itself: exported for r15-eph-<n>.js repros and the inventory
// runner. Zero deps. No app source touched.

const fs = require("fs");
const vm = require("vm");
const path = require("path");

const APP = path.resolve(__dirname, "../..");

// deterministic PRNG (mulberry32) — matches ud-mock.test.js
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// synthetic pool (same shape as ud-mock.test.js buildPool)
function buildPool() {
  const plan = [["C", 20], ["1B", 20], ["2B", 20], ["SS", 20], ["3B", 20], ["OF", 80], ["SP", 95], ["RP", 55]];
  const types = { C: "H", "1B": "H", "2B": "H", SS: "H", "3B": "H", OF: "H", SP: "P", RP: "P" };
  const slots = [];
  for (const [pos, n] of plan) for (let i = 0; i < n; i++) slots.push(pos);
  slots.sort((a, b) => a.localeCompare(b));
  const total = slots.length, players = [];
  for (let i = 0; i < total; i++) {
    const pos = slots[i];
    const value = Math.max(1, Math.round(60 * Math.pow(1 - i / total, 4)));
    players.push({ name: "Player " + (100000 + i), posKey: pos, type: types[pos], value, elig: [pos] });
  }
  players.sort((a, b) => b.value - a.value);
  return players;
}

function extractFunction(src, name) {
  const start = src.indexOf("function " + name);
  if (start < 0) throw new Error("extractFunction: " + name + " not found");
  const braceOpen = src.indexOf("{", start);
  let depth = 0, i = braceOpen;
  for (; i < src.length; i++) { const c = src[i]; if (c === "{") depth++; else if (c === "}") { depth--; if (depth === 0) { i++; break; } } }
  return src.slice(start, i);
}

// Build a fully-instrumented sandbox. Returns { sandbox, ud, writeLog, cloudPushes,
// supabaseWrites, resetLog }.
function makeSandbox(seed) {
  seed = seed || 7;
  let CLOCK = 1_700_000_000_000;
  const nowFn = () => CLOCK;

  const M = Object.create(Math);
  M.random = mulberry32(seed);

  const pool = buildPool();
  const localStore = {};
  const winListeners = [];

  // --- write log ---------------------------------------------------------
  const writeLog = [];       // { op:'set'|'remove', key, val, stack }
  const cloudPushes = [];     // keys the REAL cloud-sync patch queued for KV push
  const cloudDeletes = [];
  const supabaseWrites = [];   // any call reaching the supabase stub (should be none)
  let recording = false;
  function stackHere() {
    const e = {}; Error.captureStackTrace ? Error.captureStackTrace(e, stackHere) : (e.stack = new Error().stack);
    return (e.stack || "").split("\n").slice(1, 6).map(s => s.trim()).join(" | ");
  }

  const sandbox = {};
  sandbox.console = { log() {}, error() {}, warn() {} };
  // Real Date constructor (Save-to-archive builds a label via new Date().toLocale*),
  // but Date.now() is our controllable clock.
  const RealDate = Date;
  function ShimDate(...args) {
    if (!(this instanceof ShimDate)) return new RealDate(nowFn()).toString();
    return args.length ? new RealDate(...args) : new RealDate(nowFn());
  }
  ShimDate.now = nowFn;
  ShimDate.prototype = RealDate.prototype;
  sandbox.Date = ShimDate;
  sandbox.Math = M;
  sandbox.JSON = JSON; sandbox.Set = Set; sandbox.Map = Map;
  sandbox.Array = Array; sandbox.Object = Object; sandbox.Number = Number; sandbox.String = String;
  sandbox.Boolean = Boolean; sandbox.RegExp = RegExp; sandbox.isFinite = isFinite; sandbox.Error = Error;
  sandbox.parseInt = parseInt; sandbox.parseFloat = parseFloat; sandbox.isNaN = isNaN;
  sandbox.setTimeout = () => 0; sandbox.clearTimeout = () => {};
  sandbox.setInterval = () => 0; sandbox.clearInterval = () => {};
  sandbox.alert = () => {};
  sandbox.__confirmYes = false;
  sandbox.confirm = () => !!sandbox.__confirmYes;
  sandbox.location = { origin: "https://jwarshafsky.github.io", pathname: "/ultimate-draft/", search: "" };
  sandbox.fetch = async () => ({ ok: true, json: async () => ({}) });
  sandbox.URL = { createObjectURL: () => "", revokeObjectURL: () => {} };
  sandbox.Blob = function () {};

  // --- instrumented localStorage via a real Storage-like class so cloud-sync's
  //     Storage.prototype patch has a prototype to override. ------------------
  function StorageClass() {}
  StorageClass.prototype.getItem = function (k) { return Object.prototype.hasOwnProperty.call(localStore, k) ? localStore[k] : null; };
  StorageClass.prototype.setItem = function (k, v) {
    if (recording) writeLog.push({ op: "set", key: String(k), val: String(v), stack: stackHere() });
    localStore[k] = String(v);
  };
  StorageClass.prototype.removeItem = function (k) {
    if (recording) writeLog.push({ op: "remove", key: String(k), stack: stackHere() });
    delete localStore[k];
  };
  sandbox.Storage = StorageClass;
  const ls = new StorageClass();
  sandbox.localStorage = ls;

  // Permissive element: renders write textContent/innerHTML/className freely;
  // the harness only cares about STORAGE writes, so absorb all DOM traffic.
  const _mkEl = () => ({ textContent: "", innerHTML: "", className: "", value: "", title: "", hidden: false,
    style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, appendChild() {}, click() {}, remove() {}, focus() {}, setAttribute() {},
    getAttribute() { return null; }, closest() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; } });
  sandbox.document = {
    getElementById() { return _mkEl(); },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    addEventListener() {},
    body: { classList: { add() {}, remove() {}, toggle() {} } },
    createElement() { return { style: {}, appendChild() {}, click() {}, remove() {}, setAttribute() {} }; },
    activeElement: null,
  };
  sandbox.window = {
    localStorage: ls,
    postMessage(msg) { const ev = { source: sandbox.window, data: msg }; winListeners.forEach(fn => { try { fn(ev); } catch (e) {} }); },
    addEventListener(type, fn) { if (type === "message") winListeners.push(fn); },
    removeEventListener() {},
    location: sandbox.location,
  };
  sandbox.self = sandbox.window;
  sandbox.globalThis = sandbox;

  // --- Supabase stub — every method records to supabaseWrites (should stay empty
  //     for a UD-native mock). Mirrors the surface draft-log.js touches. -------
  function sbTable(name) {
    const rec = (op, args) => { if (recording) supabaseWrites.push({ table: name, op, args: JSON.stringify(args).slice(0, 200), stack: stackHere() }); };
    const chain = {
      insert(v) { rec("insert", v); return Promise.resolve({ data: null, error: null }); },
      upsert(v) { rec("upsert", v); return Promise.resolve({ data: null, error: null }); },
      update(v) { rec("update", v); return chain; },
      delete() { rec("delete", {}); return chain; },
      select() { return Promise.resolve({ data: [], error: null }); },
      eq() { return chain; }, in() { return chain; }, single() { return Promise.resolve({ data: null, error: null }); },
    };
    return chain;
  }
  sandbox.getSupabase = () => ({ from: sbTable, auth: { getSession: async () => ({ data: { session: null } }) } });
  sandbox.supabase = sandbox.getSupabase();
  // cloud-sync.js init-time hooks
  sandbox.onAuthChange = () => {};
  sandbox.syncPullNow = () => {};

  // --- data-layer stubs ---------------------------------------------------
  sandbox.LEAGUE = {
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
  sandbox.getKeeperSelections = () => ({});
  sandbox.getEffectiveKeeperSelections = () => ({});
  sandbox.getCurrentKeeperSalary = () => null;
  sandbox.getLeagueContractByName = () => null;
  sandbox.getBudgetAdjustment = () => 0;
  sandbox.getDraftDollarAdjustment = () => 0;
  sandbox.getFlaggedPlayers = () => [];
  sandbox.getMyRoster = () => [];
  sandbox.projectTeamCategories = () => ({});
  sandbox.esc = (s) => String(s == null ? "" : s);
  sandbox.setStatus = () => {};
  sandbox.getNfbc = () => null;
  sandbox.getStatcast = () => null;
  sandbox.statcastBuySell = () => null;
  sandbox.classifyPriceVsTargets = () => null;
  sandbox.renderTagIcons = () => "";
  sandbox.renderTargetBadge = () => "";
  // draft-log.js is loaded for real; it will try to reach supabase via getSupabase.
  sandbox.recordInflationSnapshot = () => {};
  sandbox.ensureRotowireNews = () => {};
  sandbox.fetchEspnPlayers = null;
  sandbox.getNote = () => null;
  sandbox.getSavedMocks = () => { try { return JSON.parse(ls.getItem("ud_saved_mocks_v1") || "[]"); } catch (e) { return []; } };
  sandbox._writeSavedMocks = (l) => { ls.setItem("ud_saved_mocks_v1", JSON.stringify(l)); };
  sandbox.deleteSavedMock = (id) => { const l = sandbox.getSavedMocks().filter(m => m.id !== id); sandbox._writeSavedMocks(l); };
  sandbox.computeMockStandings = () => ({ teams: [], N: 12, anyData: false });
  sandbox._mockGrade = () => "B";
  sandbox._gradeColor = () => "inherit";
  sandbox._ord = (n) => String(n);
  sandbox.renderSavedReview = () => "";
  sandbox.draftTeams = () => sandbox.LEAGUE.teams;
  sandbox.draftTeamLabel = (id) => String(id);

  const ESPN_TEAM_ID_MAP = { 1: "matt", 2: "saxton", 3: "sam", 4: "glix", 5: "jeff", 6: "aj", 7: "corey", 8: "jd", 9: "wein", 10: "klin", 11: "dave", 12: "jtl" };
  sandbox.espnTeamIdToOwnerId = (id) => ESPN_TEAM_ID_MAP[id] || null;
  sandbox.ESPN = { leagueId: 1200, listeners: [], polling: false, proxyUrl: "" };
  sandbox.leagueOverrideActive = () => sandbox.ESPN.leagueId !== sandbox.UD_HOME_LEAGUE_ID;
  sandbox.setLeagueOverride = (id) => {
    const n = Number(id);
    if (isFinite(n) && n > 0 && n !== sandbox.UD_HOME_LEAGUE_ID) { sandbox.ESPN.leagueId = n; ls.setItem("ud_league_override", String(n)); }
    else { sandbox.ESPN.leagueId = sandbox.UD_HOME_LEAGUE_ID; ls.removeItem("ud_league_override"); }
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
  // "overview" so the mock's renderDraft() guards (currentView==="draft") no-op —
  // we drive skips explicitly and probe persistence, not the DOM. Scenarios that
  // need "draft" set it via ud.eval and provide a benign getElementById.
  sandbox.currentView = "overview";
  // cloud-sync needs a signed-in user for _syncPush to actually run; give it one so
  // the dirty-set → push decision is exercised (fetch is stubbed ok).
  sandbox._syncUser = { id: "jeff" };

  vm.createContext(sandbox);

  const files = [
    "js/data/cloud-sync.js",
    "js/core/inflation.js",
    "js/core/mock-engine.js",
    "js/features/endgame.js",
    "js/features/draft-mode.js",
    "js/features/draft.js",
    "js/data/draft-log.js",
    "js/core/invariants.js",
    "js/features/ai-assistant.js",
    "js/features/mock-live-feed.js",
  ];
  let program = files.map(rel => "\n//==== " + rel + " ====\n" + fs.readFileSync(path.join(APP, rel), "utf8")).join("\n");
  program += "\n//==== spliced processEspnPicks ====\n" + extractFunction(fs.readFileSync(path.join(APP, "js/data/espn.js"), "utf8"), "processEspnPicks");
  // Wire the cloud-sync user so pushes are attempted (records into dirty set is the
  // real decision; we snapshot the dirty set after each scenario).
  program += "\ntry { if (typeof _cloudSync !== 'undefined') _cloudSync.user = _syncUser; } catch(e){}\n";
  program += "\nglobalThis.__ud = {" +
    " get liveDraft(){return _liveDraft;}," +
    " get dlog(){return _dlog;}," +
    " get feed(){return (typeof _feed!=='undefined')?_feed:null;}," +
    " get cloudSync(){return (typeof _cloudSync!=='undefined')?_cloudSync:null;}," +
    " get draftLog(){return (typeof DRAFT_LOG!=='undefined')?DRAFT_LOG:null;}," +
    " checkDraftInvariants: (typeof checkDraftInvariants==='function'?checkDraftInvariants:null)," +
    " buildMockFeedScript: (typeof buildMockFeedScript==='function'?buildMockFeedScript:null)," +
    " getMyDraftEspnId: (typeof getMyDraftEspnId==='function'?getMyDraftEspnId:null)," +
    " eval: function(code){ return eval(code); }" +
    "};\n";
  vm.runInContext(program, sandbox, { filename: "r15-eph-concat.js" });

  return {
    sandbox, ud: sandbox.__ud, writeLog, cloudPushes, cloudDeletes, supabaseWrites,
    startRecording() { recording = true; },
    stopRecording() { recording = false; },
    resetLog() { writeLog.length = 0; supabaseWrites.length = 0; cloudPushes.length = 0; cloudDeletes.length = 0; },
    // Snapshot which keys the REAL cloud-sync patch has queued for a KV push/delete.
    snapshotCloud() {
      const cs = sandbox.__ud.cloudSync;
      return {
        dirty: cs ? [...cs.dirty] : [],
        deleted: cs ? [...cs.deleted] : [],
      };
    },
    clock: { get: () => CLOCK, set: (v) => { CLOCK = v; }, advance: (ms) => { CLOCK += ms; } },
    localStore,
  };
}

const drain = () => new Promise(res => setImmediate(res));

module.exports = { makeSandbox, drain, buildPool };
