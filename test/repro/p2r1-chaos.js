#!/usr/bin/env node
// ===========================================================================
// Ultimate Draft — Phase 2 Round 1 CHAOS scenarios (chaos-engineer lens).
//
// Self-contained disaster scripts the existing 9-flag simulator
// (test/simulate-draft.js) does NOT cover. Each drives the REAL extension →
// chrome.storage → app pipeline (draft-socket-capture.js + draft-bridge.js +
// ud-bridge.js + the app engines) through two vm sandboxes, exactly the way
// simulate-draft.js does, then asserts a spec statement (S-###). A scenario
// FAILS (nonzero exit) when the real code violates the spec — a genuine
// draft-day-harm finding.
//
// Does NOT edit simulate-draft.js or any app/extension source. Only READS +
// evals it. May reuse test/helpers.js (not required — this file is standalone).
//
// CLI:
//   node test/repro/p2r1-chaos.js                 # run every scenario
//   node test/repro/p2r1-chaos.js --scenario NAME # run one
//   node test/repro/p2r1-chaos.js --list          # list scenario names
// Exit: 0 all pass, 1 any spec violation (finding), 2 bad usage, 3 crash.
// ===========================================================================

const fs = require("fs");
const vm = require("vm");
const path = require("path");

const APP = path.resolve(__dirname, "..", "..");                    // ultimate-draft/
const EXT = path.resolve(__dirname, "..", "..", "..", "keeper-edge-extension");

// --------------------------------------------------------------------------
// Shared controllable clock (both sandboxes + driver read the SAME now()).
// Scenarios that jump the clock mutate CLOCK directly.
// --------------------------------------------------------------------------
let CLOCK = 1_700_000_000_000;
const nowFn = () => CLOCK;
function advance(ms) { CLOCK += ms; }
function setClock(ms) { CLOCK = ms; }

// --------------------------------------------------------------------------
// Synthetic pool (same shape as simulate-draft.js so names always resolve).
// --------------------------------------------------------------------------
function buildPool() {
  const players = [];
  const posCycle = ["C", "1B", "2B", "SS", "3B", "OF", "OF", "OF", "SP", "SP", "RP"];
  const types = { C: "H", "1B": "H", "2B": "H", SS: "H", "3B": "H", OF: "H", SP: "P", RP: "P" };
  for (let i = 0; i < 400; i++) {
    const espnId = 100000 + i;
    const posKey = posCycle[i % posCycle.length];
    const value = Math.max(1, Math.round(60 * Math.pow(1 - i / 400, 2)));
    players.push({ espnId, name: "Player " + espnId, posKey, type: types[posKey], value });
  }
  return players;
}

// --------------------------------------------------------------------------
// INIT binary encoder (mirrors parseInitPicks' layout; from simulate-draft.js).
// --------------------------------------------------------------------------
function encodeInitB64(leagueId, picks) {
  const rec = 24;
  const buf = Buffer.alloc(rec * picks.length);
  const lid = (Number(leagueId) >>> 0);
  picks.forEach((p, i) => {
    const o = i * rec;
    buf.writeUInt32BE(lid, o);
    buf.writeInt32BE(p.teamId, o + 4);
    buf.writeInt32BE(p.seq, o + 8);
    buf.writeInt32BE(p.playerId, o + 12);
    buf.writeInt32BE(0, o + 16);
    buf.writeInt32BE(p.price, o + 20);
  });
  return buf.toString("base64");
}

function extractFunction(src, name) {
  const start = src.indexOf("function " + name);
  if (start < 0) throw new Error("extractFunction: " + name + " not found");
  const braceOpen = src.indexOf("{", start);
  let depth = 0, i = braceOpen;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

// --------------------------------------------------------------------------
// Extension sandbox (draft-socket-capture.js + draft-bridge.js).
// `storageThrows` optionally makes chrome.storage.local.set throw (quota).
// --------------------------------------------------------------------------
function makeExtensionSandbox(leagueId, storageBacking, onStorageChange, o) {
  o = o || {};
  const wsListeners = {};
  const winListeners = [];
  let intervalFns = [];
  const sandbox = {};
  sandbox.console = { log() {}, error() {}, warn() {} };
  sandbox.Date = { now: nowFn };
  sandbox.Buffer = Buffer;
  sandbox.URLSearchParams = URLSearchParams;
  sandbox.atob = (b) => Buffer.from(b, "base64").toString("binary");
  sandbox.TextDecoder = TextDecoder;
  sandbox.Uint8Array = Uint8Array;
  sandbox.DataView = DataView;
  sandbox.ArrayBuffer = ArrayBuffer;
  sandbox.setInterval = (fn) => { intervalFns.push(fn); return intervalFns.length; };
  sandbox.clearInterval = () => {};
  sandbox.setTimeout = (fn) => { try { fn(); } catch (e) {} return 0; };
  sandbox.clearTimeout = () => {};
  sandbox.location = { pathname: "/baseball/draft", search: "?leagueId=" + leagueId };

  sandbox.chrome = {
    storage: {
      local: {
        get(keys, cb) {
          const out = {};
          (Array.isArray(keys) ? keys : [keys]).forEach(k => {
            if (storageBacking[k] !== undefined) out[k] = JSON.parse(JSON.stringify(storageBacking[k]));
          });
          cb(out);
        },
        set(obj, cb) {
          if (o.storageThrows && o.storageThrows()) { const e = new Error("QuotaExceededError"); e.name = "QuotaExceededError"; throw e; }
          const changes = {};
          for (const k of Object.keys(obj)) {
            const oldValue = storageBacking[k];
            storageBacking[k] = JSON.parse(JSON.stringify(obj[k]));
            changes[k] = { oldValue, newValue: JSON.parse(JSON.stringify(obj[k])) };
          }
          if (cb) cb();
          onStorageChange(changes, "local");
        },
        remove(keys, cb) {
          const changes = {};
          (Array.isArray(keys) ? keys : [keys]).forEach(k => {
            if (storageBacking[k] !== undefined) { changes[k] = { oldValue: storageBacking[k], newValue: undefined }; delete storageBacking[k]; }
          });
          if (cb) cb();
          if (Object.keys(changes).length) onStorageChange(changes, "local");
        },
      },
      onChanged: { _fns: [], addListener(fn) { this._fns.push(fn); } },
    },
  };

  function FakeWS(url) { this.url = url; }
  FakeWS.prototype.addEventListener = function (type, fn) { (wsListeners[type] = wsListeners[type] || []).push(fn); };
  FakeWS.CONNECTING = 0; FakeWS.OPEN = 1; FakeWS.CLOSING = 2; FakeWS.CLOSED = 3;

  sandbox.window = {
    WebSocket: FakeWS,
    postMessage(msg) { const ev = { source: sandbox.window, data: msg }; winListeners.forEach(fn => { try { fn(ev); } catch (e) {} }); },
    addEventListener(type, fn) { if (type === "message") winListeners.push(fn); if (type === "pagehide") sandbox.__pagehide = fn; },
  };
  sandbox.self = sandbox.window;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  vm.runInContext(fs.readFileSync(path.join(EXT, "draft-socket-capture.js"), "utf8"), sandbox, { filename: "draft-socket-capture.js" });
  vm.runInContext(fs.readFileSync(path.join(EXT, "draft-bridge.js"), "utf8"), sandbox, { filename: "draft-bridge.js" });

  new sandbox.window.WebSocket("wss://fantasydraft.espn.com/game-99/JOIN?1=99&2=" + leagueId);

  return {
    sandbox,
    emitFrame(text) { (wsListeners.message || []).forEach(fn => { try { fn({ data: text }); } catch (e) {} }); },
    tick() { intervalFns.forEach(fn => { try { fn(); } catch (e) {} }); },
    pagehide() { if (sandbox.__pagehide) try { sandbox.__pagehide(); } catch (e) {} },
    onChangedFns: sandbox.chrome.storage.onChanged._fns,
    storageBacking,
  };
}

// --------------------------------------------------------------------------
// App sandbox (real engines + ud-bridge.js). `localStorageThrows` optionally
// makes localStorage.setItem throw (quota) so persistence is exercised.
// --------------------------------------------------------------------------
function makeAppSandbox(pool, leagueOverrideId, o) {
  o = o || {};
  const sandbox = {};
  const localStore = o.localStore || {};
  const winListeners = [];
  const docListeners = {};
  const onChangedFns = [];
  const chromeBacking = {};

  sandbox.console = { log() {}, error() {}, warn() {} };
  // A real Date constructor (draft-log.js uses `new Date(startedAt)`), but with
  // Date.now() routed to the controllable clock so time stays deterministic.
  function CtrlDate(...args) {
    if (!(this instanceof CtrlDate)) return new Date(nowFn()).toString();
    return args.length ? new Date(...args) : new Date(nowFn());
  }
  CtrlDate.now = nowFn;
  CtrlDate.prototype = Date.prototype;
  sandbox.Date = new Proxy(Date, { construct(T, a) { return a.length ? new Date(...a) : new Date(nowFn()); }, get(T, p) { return p === "now" ? nowFn : T[p]; } });
  sandbox.JSON = JSON; sandbox.Math = Math; sandbox.Set = Set; sandbox.Map = Map;
  sandbox.Array = Array; sandbox.Object = Object; sandbox.Number = Number; sandbox.String = String;
  sandbox.Boolean = Boolean; sandbox.RegExp = RegExp; sandbox.isFinite = isFinite; sandbox.parseInt = parseInt;
  sandbox.parseFloat = parseFloat; sandbox.isNaN = isNaN; sandbox.Buffer = Buffer;
  sandbox.URLSearchParams = URLSearchParams;
  sandbox.atob = (b) => Buffer.from(b, "base64").toString("binary");
  sandbox.setTimeout = () => 0; sandbox.clearTimeout = () => {};
  sandbox.setInterval = () => 0; sandbox.clearInterval = () => {};
  sandbox.location = { origin: "https://app.test", pathname: "/", search: "" };

  sandbox.localStorage = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(localStore, k) ? localStore[k] : null; },
    setItem(k, v) { if (o.localStorageThrows && o.localStorageThrows(k)) { const e = new Error("QuotaExceededError"); e.name = "QuotaExceededError"; throw e; } localStore[k] = String(v); },
    removeItem(k) { delete localStore[k]; },
    _store: localStore,
  };
  if (leagueOverrideId) localStore["ud_league_override"] = String(leagueOverrideId);

  sandbox.document = {
    getElementById() { return null; },
    querySelectorAll() { return []; },
    addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
    body: { classList: { add() {}, remove() {}, toggle() {} } },
    createElement() { return { style: {}, appendChild() {}, click() {}, remove() {} }; },
  };
  sandbox.window = {
    postMessage(msg) { const ev = { source: sandbox.window, data: msg }; winListeners.forEach(fn => { try { fn(ev); } catch (e) {} }); },
    addEventListener(type, fn) { if (type === "message") winListeners.push(fn); },
  };
  sandbox.self = sandbox.window;
  sandbox.globalThis = sandbox;

  sandbox.chrome = {
    storage: {
      local: {
        get(keys, cb) {
          const out = {};
          (Array.isArray(keys) ? keys : [keys]).forEach(k => {
            if (chromeBacking[k] !== undefined) out[k] = JSON.parse(JSON.stringify(chromeBacking[k]));
          });
          cb(out);
        },
        set(obj, cb) { for (const k of Object.keys(obj)) chromeBacking[k] = JSON.parse(JSON.stringify(obj[k])); if (cb) cb(); },
        remove(keys, cb) { (Array.isArray(keys) ? keys : [keys]).forEach(k => delete chromeBacking[k]); if (cb) cb(); },
      },
      onChanged: { addListener(fn) { onChangedFns.push(fn); } },
    },
  };

  sandbox.LEAGUE = {
    teams: [
      { id: "matt", name: "Matt", owner: "Matt" }, { id: "saxton", name: "Saxton", owner: "Saxton" },
      { id: "sam", name: "Sam", owner: "Sam" }, { id: "glix", name: "Glicksmans", owner: "Glicksmans" },
      { id: "jeff", name: "Jeff", owner: "Jeff", isMe: true }, { id: "aj", name: "AJ", owner: "AJ" },
      { id: "corey", name: "Corey", owner: "Corey" }, { id: "jd", name: "Josh/Doug", owner: "Josh/Doug" },
      { id: "wein", name: "Larry", owner: "Larry" }, { id: "klin", name: "Klinger", owner: "Klinger" },
      { id: "dave", name: "Dave", owner: "Dave" }, { id: "jtl", name: "Jesse", owner: "Jesse" },
    ],
    draftBudget: 260, numTeams: 12, luxuryTax: 350, rosterSize: 26,
    hitCats: ["R", "HR", "RBI", "SB", "OBP"], pitCats: ["QS", "K", "SV_HLD", "ERA", "WHIP"],
  };
  sandbox.VALUATION = { hitBudgetPct: 0.66, minDollar: 1 };
  sandbox.POS_TARGETS = { C: 1, "1B": 1, "2B": 1, SS: 1, "3B": 1, MI: 1, CI: 1, OF: 5, UTIL: 1, SP: 6, RP: 3 };
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
  sandbox.getNfbc = () => null; sandbox.getStatcast = () => null; sandbox.statcastBuySell = () => null;
  sandbox.classifyPriceVsTargets = () => null; sandbox.renderTagIcons = () => ""; sandbox.renderTargetBadge = () => "";
  sandbox.recordInflationSnapshot = () => {}; sandbox.ensureRotowireNews = () => {};
  sandbox.fetchEspnPlayers = null;

  // Supabase mirror capture: record what draft-log.js WOULD upsert so scenarios
  // can assert mirror behavior (is_mock flips, watermark, idempotency) without a
  // real network. We load the REAL draft-log.js and give it a fake supabaseClient.
  const mirror = { sessionUpserts: [], eventUpserts: [], isMockUpdates: [], failNext: 0 };
  sandbox.__mirror = mirror;
  let _sessionSeq = 1;
  function makeQuery(table) {
    const q = {
      _table: table, _op: null, _payload: null, _onConflict: null,
      upsert(rows, opt) { q._op = "upsert"; q._payload = rows; q._onConflict = opt && opt.onConflict; return q; },
      update(patch) { q._op = "update"; q._payload = patch; return q; },
      eq() { return q; },
      select() { return q; },
      async single() {
        if (table === "draft_sessions") {
          mirror.sessionUpserts.push(q._payload);
          return { data: { id: "sess-" + (_sessionSeq++) }, error: null };
        }
        return { data: null, error: null };
      },
      then(res, rej) {
        // update path (is_mock flip) resolves as a thenable
        if (q._op === "update" && table === "draft_sessions") mirror.isMockUpdates.push(q._payload);
        if (q._op === "upsert" && table === "draft_events") {
          if (mirror.failNext > 0) { mirror.failNext--; return Promise.resolve({ error: { message: "network down" } }).then(res, rej); }
          mirror.eventUpserts.push(...(Array.isArray(q._payload) ? q._payload : [q._payload]));
        }
        return Promise.resolve({ error: null }).then(res, rej);
      },
    };
    return q;
  }
  sandbox.supabaseClient = { from: (t) => makeQuery(t) };
  sandbox.currentUser = { id: "jeff-user" };
  sandbox.updateDraftDiagnostics = () => {};

  const ESPN_TEAM_ID_MAP = { 1: "matt", 2: "saxton", 3: "sam", 4: "glix", 5: "jeff", 6: "aj", 7: "corey", 8: "jd", 9: "wein", 10: "klin", 12: "dave", 13: "jtl" };
  sandbox.espnTeamIdToOwnerId = (id) => ESPN_TEAM_ID_MAP[id] || null;
  sandbox.ESPN = { leagueId: leagueOverrideId ? Number(leagueOverrideId) : 1200, listeners: [], polling: false, proxyUrl: "" };
  sandbox.leagueOverrideActive = () => sandbox.ESPN.leagueId !== sandbox.UD_HOME_LEAGUE_ID;
  sandbox.setLeagueOverride = (id) => {
    const n = Number(id);
    if (isFinite(n) && n > 0 && n !== sandbox.UD_HOME_LEAGUE_ID) { sandbox.ESPN.leagueId = n; localStore["ud_league_override"] = String(n); }
    else { sandbox.ESPN.leagueId = sandbox.UD_HOME_LEAGUE_ID; delete localStore["ud_league_override"]; }
  };

  const byName = new Map(pool.map(p => [p.name, { name: p.name, posKey: p.posKey, type: p.type, value: p.value }]));
  const valuesList = pool.map(p => byName.get(p.name)).sort((a, b) => b.value - a.value);
  sandbox.getValues = () => valuesList;
  sandbox.getPlayerValue = (name) => byName.get(name) || null;

  sandbox.normalizePlayerName = (s) => {
    if (!s) return "";
    let n = String(s).normalize("NFD").replace(/[̀-ͯ]/g, "");
    n = n.toLowerCase().replace(/[.'`’]/g, "").replace(/[^a-z0-9 ]/g, " ");
    n = n.replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "");
    return n.replace(/\s+/g, " ").trim();
  };
  sandbox.coreNameKey = (name) => {
    const toks = sandbox.normalizePlayerName(name).split(" ").filter(Boolean);
    if (toks.length <= 2) return toks.join(" ");
    const mids = toks.slice(1, -1).filter(t => t.length > 1);
    return [toks[0], ...mids, toks[toks.length - 1]].join(" ");
  };
  sandbox.currentView = "overview";

  vm.createContext(sandbox);

  const files = [
    "js/core/inflation.js", "js/features/endgame.js", "js/features/draft-mode.js",
    "js/features/draft.js", "js/core/invariants.js", "js/features/ai-assistant.js",
    "js/data/draft-log.js",
  ];
  let program = files.map(rel => "\n//==== " + rel + " ====\n" + fs.readFileSync(path.join(APP, rel), "utf8")).join("\n");
  program += "\n//==== spliced processEspnPicks ====\n" +
    extractFunction(fs.readFileSync(path.join(APP, "js/data/espn.js"), "utf8"), "processEspnPicks");
  program += "\nglobalThis.__ud = {" +
    " get liveDraft(){return _liveDraft;}, get dlog(){return _dlog;}, get feed(){return _feed;}," +
    " checkDraftInvariants: (typeof checkDraftInvariants==='function'?checkDraftInvariants:null)," +
    " setFeedMode: (typeof setFeedMode==='function'?setFeedMode:null)," +
    " loadLiveDraft: (typeof loadLiveDraft==='function'?loadLiveDraft:null)," +
    " dlogLoad: (typeof _dlogLoad==='function'?_dlogLoad:null)," +
    " setEspnNames: function(m){ _espnIdToName = m; }," +
    " eval: function(code){ return eval(code); } };\n";
  vm.runInContext(program, sandbox, { filename: "ud-engines-concat.js" });

  vm.runInContext(fs.readFileSync(path.join(EXT, "ud-bridge.js"), "utf8"), sandbox, { filename: "ud-bridge.js" });

  const ud = sandbox.__ud;
  const idToName = {};
  for (const p of pool) idToName[p.espnId] = p.name;
  ud.setEspnNames(idToName);

  return {
    sandbox, ud, onChangedFns, chromeBacking, localStore, mirror, idToName,
    deliver(msg) { const ev = { source: sandbox.window, data: msg }; winListeners.forEach(fn => { try { fn(ev); } catch (e) {} }); },
    setFeedMode(mode) { ud.setFeedMode(mode); if (mode === "test" || mode === "real") ud.setEspnNames(idToName); },
    call(expr) { return ud.eval(expr); },
    picks() { return ud.liveDraft.picks; },
  };
}

// --------------------------------------------------------------------------
// Bridge wiring (from simulate-draft.js). ref.app is mutable for app reloads.
// hiddenTabDelay-style batching is available per scenario via a hold flag.
// --------------------------------------------------------------------------
function makeRunner(leagueId, pool, app, storageBacking, extOpts) {
  const ref = { app, hold: false };
  let pending = [];
  const deliverChange = (changes) => {
    const a = ref.app;
    for (const k of Object.keys(changes)) {
      if (changes[k].newValue === undefined) delete a.chromeBacking[k];
      else a.chromeBacking[k] = JSON.parse(JSON.stringify(changes[k].newValue));
    }
    a.onChangedFns.forEach(fn => { try { fn(changes, "local"); } catch (e) {} });
  };
  const onStorageChange = (changes, area) => {
    if (area !== "local") return;
    if (ref.hold) { pending.push(changes); return; }
    deliverChange(changes);
  };
  const flushHeld = () => { const q = pending; pending = []; q.forEach(deliverChange); };
  const ext = makeExtensionSandbox(leagueId, storageBacking, onStorageChange, extOpts);
  const fullResync = () => {
    const changes = {};
    for (const k of Object.keys(storageBacking)) changes[k] = { oldValue: undefined, newValue: storageBacking[k] };
    if (Object.keys(changes).length) deliverChange(changes);
  };
  return { ext, ref, deliverChange, flushHeld, onStorageChange, fullResync };
}

const drain = () => new Promise(res => setImmediate(res));

// --------------------------------------------------------------------------
// Per-scenario assertion collector.
// --------------------------------------------------------------------------
function Ctx(name) {
  return {
    name, failures: [], notes: [],
    assert(cond, msg) { if (!cond) this.failures.push(msg); },
    note(m) { this.notes.push(m); },
  };
}

// Helper: emit a lot (nom + bids + sold) as raw frames through the extension.
function lotFrames(playerId, nomTeam, bids, soldTeam, seq, soldPrice) {
  const frames = [];
  frames.push("NOMINATION " + nomTeam + " " + playerId);
  for (const b of bids) frames.push("BID " + b.team + " " + playerId + " " + b.price + " 255 30000");
  frames.push("SOLD " + soldTeam + " " + playerId + " " + seq + " " + soldPrice + " 0");
  return frames;
}

// Emit raw frames through the extension, ticking the 700ms coalescer afterward
// so non-SOLD events (NOMINATION/BID) reach chrome.storage the way they do in a
// real browser (the interval that this vm captures but doesn't auto-fire). SOLD
// and INIT already flush immediately in draft-bridge; the tick covers the rest.
async function emitLot(runner, frames, stepMs) {
  for (const f of frames) { runner.ext.emitFrame(f); advance(stepMs || 200); await drain(); }
  runner.ext.tick(); await drain();
}
async function emitFrameFlushed(runner, text, stepMs) {
  runner.ext.emitFrame(text); advance(stepMs || 200); await drain();
  runner.ext.tick(); await drain();
}

// ===========================================================================
// SCENARIOS
// ===========================================================================
const SCENARIOS = {};

// ---------------------------------------------------------------------------
// 1. outOfOrderEvents (LATENT — passes today) — probes the app's event-dedup.
//    _onDraftEvents keeps a `last = seq of the LAST APPENDED event` and filters
//    `e.seq > last`. That is a last-element cursor, not a max-seq watermark, so
//    it is only safe while every delivered batch is monotonic vs. what's stored.
//    The REAL pipeline IS monotonic (single chrome.storage key, FIFO onChanged,
//    ud-bridge sends deltas in push order), so this passes — but we assert that
//    guarantee holds end-to-end (a regression that ever reorders delivery would
//    silently drop a NOMINATION/BID and blank/misdraw the hero). S-041/S-046.
// ---------------------------------------------------------------------------
SCENARIOS.outOfOrderEvents = async function (ctx) {
  const pool = buildPool();
  const leagueId = 999123;
  const app = makeAppSandbox(pool, leagueId);
  app.setFeedMode("test");
  const storageBacking = {};
  const runner = makeRunner(leagueId, pool, app, storageBacking);

  // Drive several lots through the REAL extension→bridge→app path and assert the
  // app's _dlog carries every SOLD/NOMINATION/BID in strictly-increasing order —
  // i.e. the real pipeline never delivers out of order and never drops a frame.
  let seq = 1;
  for (let i = 0; i < 5; i++) {
    await emitFrameFlushed(runner, "NOMINATION " + ((i % 12) + 1) + " " + pool[i].espnId);
    await emitFrameFlushed(runner, "BID " + ((i % 12) + 1) + " " + pool[i].espnId + " " + (3 + i) + " 255 30000");
    await emitFrameFlushed(runner, "SOLD " + ((i % 12) + 1) + " " + pool[i].espnId + " " + seq + " " + (3 + i) + " 0");
    seq++;
  }
  const events = app.call("_dlog.events");
  const seqs = events.map(e => e.seq);
  let mono = true, prev = null;
  for (const s of seqs) { if (prev != null && !(s > prev)) mono = false; prev = s; }
  const noms = events.filter(e => e.cmd === "NOMINATION").length;
  const solds = events.filter(e => e.cmd === "SOLD").length;
  ctx.note("delivered seqs: " + seqs.join(",") + " (noms=" + noms + ", solds=" + solds + ")");
  // S-046: strictly increasing end-to-end through the real pipeline.
  ctx.assert(mono, "S-046 VIOLATED: real pipeline delivered events out of seq order — " + seqs.join(","));
  // S-041: no frame dropped (5 noms, 5 solds present).
  ctx.assert(noms === 5 && solds === 5,
    "S-041 VIOLATED: real pipeline dropped frames (noms=" + noms + " solds=" + solds + " expected 5/5)");
  ctx.note("NOTE (latent): _onDraftEvents dedups against the LAST-APPENDED seq, not max(seq). Safe only while delivery stays monotonic; a proper watermark (Math.max over stored seqs) would be more robust against any future reordering.");
};

// ---------------------------------------------------------------------------
// 2. duplicateInitBursts — a flaky ESPN socket can fire INIT repeatedly on
//    reconnect. Each INIT backfills. Assert no double picks and (critically)
//    that a burst of identical INITs does NOT trip the same-league rotation
//    (S-061: rotation only when INIT << stored AND feed >60min old).
// ---------------------------------------------------------------------------
SCENARIOS.duplicateInitBursts = async function (ctx) {
  const pool = buildPool();
  const leagueId = 999123;
  const app = makeAppSandbox(pool, leagueId);
  app.setFeedMode("test");
  const storageBacking = {};
  const runner = makeRunner(leagueId, pool, app, storageBacking);

  // Late join: the FIRST thing we see is an INIT with 5 picks (backfill).
  const initPicks = [];
  for (let i = 0; i < 5; i++) initPicks.push({ playerId: pool[i].espnId, teamId: (i % 12) + 1, seq: i + 1, price: 10 + i });
  // Fire the SAME INIT 5 times in a burst (reconnect storm).
  for (let n = 0; n < 5; n++) { runner.ext.emitFrame("INIT " + encodeInitB64(leagueId, initPicks)); advance(50); await drain(); }

  const picks = app.picks();
  const ids = picks.map(p => p.espnPlayerId);
  const uniq = new Set(ids);
  ctx.note("picks after 5 identical INIT bursts: " + picks.length);
  ctx.assert(picks.length === 5 && uniq.size === 5,
    "S-064/S-068 VIOLATED: identical INIT burst produced " + picks.length + " picks (expected 5 deduped)");
  const inv = app.call("checkDraftInvariants()");
  const dupErr = inv.violations.find(x => x.id === "I-FEED" && /duplicate/.test(x.detail));
  ctx.assert(!dupErr, "I-FEED duplicate playerId after INIT burst: " + (dupErr ? dupErr.detail : ""));
};

// ---------------------------------------------------------------------------
// 3. clearFeedDuringLot — the user clicks "Clear captured feed" while a lot is
//    live (a nomination + bids are in _dlog but no SOLD yet). S-059: clearing
//    MUST NOT delete _liveDraft.picks. S-157: reload is suppressed while a lot
//    is live. But does clearing mid-lot leave the hero pointing at a lot whose
//    backing events were just wiped? currentLotFromEvents reads _dlog.events.
// ---------------------------------------------------------------------------
SCENARIOS.clearFeedDuringLot = async function (ctx) {
  const pool = buildPool();
  const leagueId = 999123;
  const app = makeAppSandbox(pool, leagueId);
  app.setFeedMode("test");
  const storageBacking = {};
  const runner = makeRunner(leagueId, pool, app, storageBacking);

  // Complete one lot (a recorded pick), then start a SECOND lot but DON'T sell.
  await emitLot(runner, lotFrames(pool[0].espnId, 1, [{ team: 1, price: 4 }], 1, 1, 4));
  await emitFrameFlushed(runner, "NOMINATION 2 " + pool[1].espnId);
  await emitFrameFlushed(runner, "BID 2 " + pool[1].espnId + " 6 255 30000");

  const picksBefore = app.picks().length;
  const lotBefore = app.call("currentLotFromEvents()");
  ctx.assert(lotBefore && lotBefore.playerId === pool[1].espnId, "precondition: a live lot exists on player " + pool[1].espnId);

  // User clicks Clear. The app posts clearFeed to ud-bridge (same app window).
  app.call("clearCapturedFeed()");
  await drain(); await drain();

  const picksAfter = app.picks().length;
  const lotAfter = app.call("currentLotFromEvents()");
  ctx.note("picks before/after clear: " + picksBefore + "/" + picksAfter + "; lot after clear: " + (lotAfter ? lotAfter.playerId : "null"));

  // S-059: recorded picks survive the clear.
  ctx.assert(picksAfter === picksBefore,
    "S-059 VIOLATED: Clear captured feed deleted recorded picks (" + picksBefore + " → " + picksAfter + ")");
  // After a clear the event log is gone, so the hero must show no live lot
  // (S-135 "waiting for a nomination") — NOT a stuck lot with no backing events.
  ctx.assert(lotAfter === null,
    "S-058 concern: after Clear, currentLotFromEvents still returns a lot with no backing event log — hero would be stuck on a phantom lot.");
};

// ---------------------------------------------------------------------------
// 4. appReloadMidLot — the APP tab reloads (F5, crash-restore) while a lot is
//    live, AFTER the 700ms coalescer has flushed the NOMINATION/BID to storage
//    (the realistic case). On reload the app restores _dlog from its own
//    localStorage backup (_dlogPersist) AND the ud-bridge re-pushes storage.
//    The live hero (currentLotFromEvents) MUST restore so Jeff isn't blank mid-
//    bidding. S-164 (app reload restores _dlog events + resumes), S-134.
// ---------------------------------------------------------------------------
SCENARIOS.appReloadMidLot = async function (ctx) {
  const pool = buildPool();
  const leagueId = 999123;
  const app = makeAppSandbox(pool, leagueId);
  app.setFeedMode("test");
  const storageBacking = {};
  const runner = makeRunner(leagueId, pool, app, storageBacking);

  // Sell one lot (flushed immediately per S-042), then start a live lot and let
  // the 700ms coalescer flush the NOMINATION/BID to storage (emitFrameFlushed).
  await emitLot(runner, lotFrames(pool[0].espnId, 1, [{ team: 1, price: 4 }], 1, 1, 4));
  await emitFrameFlushed(runner, "NOMINATION 2 " + pool[1].espnId);
  await emitFrameFlushed(runner, "BID 2 " + pool[1].espnId + " 7 255 30000");

  // The app also persists its own _dlog backup on a 2s timer; force it so the
  // reload path (which reads ud_draft_events_v1) has the live lot. In the real
  // app this fires within 2s; we call it directly to model "the timer fired".
  app.call("_dlogPersist();");
  const storedEvents = storageBacking.udDraftEvents ? storageBacking.udDraftEvents.events.length : 0;
  ctx.note("events in chrome.storage at reload: " + storedEvents + "; app _dlog: " + app.call("_dlog.events.length"));

  // APP reload: rebuild from persisted localStorage, then ud-bridge re-push.
  const savedLive = app.localStore["ud_live_draft_v1"];
  const savedDlog = app.localStore["ud_draft_events_v1"];
  const savedMode = app.localStore["ud_feed_mode"];
  const savedOverride = app.localStore["ud_league_override"];
  const newApp = makeAppSandbox(pool, leagueId);
  if (savedLive !== undefined) newApp.localStore["ud_live_draft_v1"] = savedLive;
  if (savedDlog !== undefined) newApp.localStore["ud_draft_events_v1"] = savedDlog;
  if (savedMode !== undefined) newApp.localStore["ud_feed_mode"] = savedMode;
  if (savedOverride !== undefined) newApp.localStore["ud_league_override"] = savedOverride;
  newApp.call("loadLiveDraft(); _dlogLoad();");
  newApp.setFeedMode(savedMode || "test");
  runner.ref.app = newApp;
  runner.fullResync();
  await drain();

  const eventsAfter = newApp.call("_dlog.events.length");
  const lotAfter = newApp.call("currentLotFromEvents()");
  ctx.note("app events after reload: " + eventsAfter + "; lot after reload: " + (lotAfter ? lotAfter.playerId : "null"));
  ctx.assert(newApp.picks().length === 1, "S-164: recorded pick lost across app reload (" + newApp.picks().length + ")");
  ctx.assert(lotAfter && lotAfter.playerId === pool[1].espnId,
    "S-164/S-134 VIOLATED: after an app reload mid-lot, the live lot (player " + pool[1].espnId +
    ") did not restore (events after=" + eventsAfter + ") — hero blanks until the next frame.");
};

// ---------------------------------------------------------------------------
// 5. extReloadThenImmediateSold — the extension reloads (pagehide flush), and a
//    SOLD arrives on the reconnected socket BEFORE any INIT restores the feed
//    context. draft-bridge restores elog (+100 seq bump, S-045) but `feed` too.
//    A SOLD for a NEW player must record; a repeat SOLD (same seq) must not
//    double. Verify the seq bump doesn't create a phantom re-sale (a bumped seq
//    differs from the app's held espnSeq → _applyDraftFeed would treat it as a
//    re-auction and overwrite, S-069/S-072).
// ---------------------------------------------------------------------------
SCENARIOS.extReloadThenImmediateSold = async function (ctx) {
  const pool = buildPool();
  const leagueId = 999123;
  const app = makeAppSandbox(pool, leagueId);
  app.setFeedMode("test");
  const storageBacking = {};
  let runner = makeRunner(leagueId, pool, app, storageBacking);

  // Sell 3 lots.
  for (let i = 0; i < 3; i++) {
    for (const f of lotFrames(pool[i].espnId, 1, [{ team: 1, price: 5 + i }], 1, i + 1, 5 + i)) { runner.ext.emitFrame(f); advance(200); await drain(); }
  }
  const held = new Map(app.picks().map(p => [p.espnPlayerId, { price: p.price, seq: p.espnSeq, team: p.espnTeamId }]));
  ctx.assert(app.picks().length === 3, "precondition: 3 picks");

  // Extension reload: pagehide flush, rebuild from the same storage backing.
  runner.ext.pagehide();
  runner.ext = makeExtensionSandbox(leagueId, storageBacking, runner.onStorageChange);
  await drain();

  // Immediately, a SOLD arrives for a NEW player (lot 4) before any INIT.
  for (const f of lotFrames(pool[3].espnId, 2, [{ team: 2, price: 9 }], 2, 4, 9)) { runner.ext.emitFrame(f); advance(200); await drain(); }

  const picks = app.picks();
  ctx.note("picks after ext reload + SOLD: " + picks.length);
  // The 3 original picks must be UNCHANGED (no phantom re-sale from seq bump).
  let mutated = 0;
  for (const p of picks) {
    const h = held.get(p.espnPlayerId);
    if (h && (h.price !== p.price || h.team !== p.espnTeamId)) mutated++;
  }
  ctx.assert(mutated === 0, "S-069/S-072 VIOLATED: " + mutated + " prior pick(s) mutated after extension reload (phantom re-auction from seq bump)");
  ctx.assert(picks.length === 4, "S-045/S-068: expected 4 picks after ext reload + new SOLD, got " + picks.length);
  const inv = app.call("checkDraftInvariants()");
  const errs = inv.violations.filter(x => x.severity === "error");
  ctx.assert(errs.length === 0, "invariant errors after ext reload: " + errs.map(e => e.id + ":" + e.detail).slice(0, 3).join(" | "));
};

// ---------------------------------------------------------------------------
// 6. twoLeaguesInterleaved — user switches ESPN tabs between two mock leagues.
//    In TEST mode, feed/events from ANY league are accepted (S-010). But the
//    app's _dlog is a SINGLE session (leagueId/startedAt). Interleaving two
//    leagues' streams: _onDraftEvents resets _dlog.events when (leagueId,
//    startedAt) differs (S-062). Assert the app doesn't blend two leagues'
//    events into one session, and picks stay coherent.
// ---------------------------------------------------------------------------
SCENARIOS.twoLeaguesInterleaved = async function (ctx) {
  const pool = buildPool();
  const app = makeAppSandbox(pool, 999123);
  app.setFeedMode("test");

  // Two independent extension sandboxes (two ESPN tabs), each its own storage.
  const backA = {}, backB = {};
  const runnerA = makeRunner(777001, pool, app, backA);
  const runnerB = makeRunner(888002, pool, app, backB);

  // Interleave: league A sells a lot, league B sells a lot, A again.
  await emitLot(runnerA, lotFrames(pool[0].espnId, 1, [{ team: 1, price: 5 }], 1, 1, 5));
  await emitLot(runnerB, lotFrames(pool[1].espnId, 2, [{ team: 2, price: 6 }], 2, 1, 6));
  await emitLot(runnerA, lotFrames(pool[2].espnId, 3, [{ team: 3, price: 7 }], 3, 2, 7));

  const log = app.call("_dlog");
  const picks = app.picks();
  ctx.note("final _dlog leagueId: " + log.leagueId + ", events: " + log.events.length + ", picks: " + picks.length);
  // S-062: the event log correctly reflects exactly ONE league at a time (it
  // resets on switch) — this PART works.
  ctx.assert(String(log.leagueId) === "777001",
    "S-062 VIOLATED: after switching back to league A, _dlog.leagueId is " + log.leagueId);

  // THE FINDING: _liveDraft.picks is a SINGLE list with no league key, so both
  // leagues' SOLDs blend onto one board. League B's player (pid " + pool[1] + ")
  // is drafted-off the pool even though the app is back on league A. The event
  // log resets per league but the pick board never does.
  const leagueBpid = pool[1].espnId;
  const boardHasB = picks.some(p => p.espnPlayerId === leagueBpid);
  const avail = app.call("availableDraftPool()");
  const bInPool = avail.some(p => app.call("getPlayerValue('" + pool[1].name + "')") && p.name === pool[1].name);
  ctx.note("league-B player on league-A board: " + boardHasB + "; still available: " + bInPool);
  ctx.assert(!boardHasB,
    "DATA-INTEGRITY: switching ESPN tabs between two mock leagues blends both leagues' picks into ONE board (_liveDraft.picks has no league key). League B's pick (playerId " + leagueBpid +
    ") stays on the board and is removed from the available pool while the app is back on league A — a wrong board / wrong inflation until Reset draft. Only same-league rotation (S-060) clears picks; a cross-league switch does not.");
  // Invariants themselves don't catch this (both are valid espn:N picks).
  const inv = app.call("checkDraftInvariants()");
  const errs = inv.violations.filter(x => x.severity === "error");
  ctx.assert(errs.length === 0, "invariant errors with interleaved leagues: " + errs.map(e => e.id + ":" + e.detail).slice(0, 3).join(" | "));
};

// ---------------------------------------------------------------------------
// 7. localStorageQuota — mid-draft, localStorage.setItem throws (quota). The
//    app's saveLiveDraft / _dlogPersist wrap in EMPTY try/catch, so the failure
//    is silent (no user warning anywhere). On reload the app restores picks from
//    ud_live_draft_v1. While the ESPN tab is LIVE the extension feed re-push
//    refills them — but if the tab is CLOSED (reviewing later / draft ended),
//    the 15-min staleness gate (S-051) blocks re-ingestion and the un-persisted
//    picks are LOST for good. S-164 (app reload restores picks).
//    This scenario proves the harmful case: quota exhausted + no live tab.
// ---------------------------------------------------------------------------
SCENARIOS.localStorageQuota = async function (ctx) {
  const pool = buildPool();
  const leagueId = 999123;
  // Quota kicks in only for the big live-draft/event keys after N sells.
  let sells = 0;
  const throwsFor = (k) => sells >= 3 && (k === "ud_live_draft_v1" || k === "ud_draft_events_v1");
  const sharedLocal = {};
  const app = makeAppSandbox(pool, leagueId, { localStore: sharedLocal, localStorageThrows: throwsFor });
  app.setFeedMode("test");
  const storageBacking = {};
  const runner = makeRunner(leagueId, pool, app, storageBacking);

  for (let i = 0; i < 6; i++) {
    await emitLot(runner, lotFrames(pool[i].espnId, 1, [{ team: 1, price: 5 + i }], 1, i + 1, 5 + i));
    sells++;
  }
  const liveBefore = app.picks().length;
  const persisted = sharedLocal["ud_live_draft_v1"] ? JSON.parse(sharedLocal["ud_live_draft_v1"]).picks.length : 0;
  ctx.note("picks in memory before reload: " + liveBefore + "; ud_live_draft_v1 persisted: " + (sharedLocal["ud_live_draft_v1"] ? persisted : "MISSING"));

  // App reload with NO live ESPN tab (draft ended / reviewing later next day).
  // The extension feed in chrome.storage is now >15 min stale, so the staleness
  // gate (S-051) refuses to re-ingest it. Advance the clock 20 min and DON'T
  // deliver a heartbeat, then reload + re-push.
  advance(20 * 60 * 1000);
  const newApp = makeAppSandbox(pool, leagueId, { localStore: sharedLocal });
  newApp.call("loadLiveDraft(); _dlogLoad();");
  newApp.setFeedMode("test");
  const liveAfterReloadOnly = newApp.picks().length;   // from ud_live_draft_v1 only
  runner.ref.app = newApp;
  runner.fullResync();           // ud-bridge pushAll(true) → re-delivers udDraftFeed (now stale)
  await drain(); await drain();
  const liveAfter = newApp.picks().length;
  const staleInfo = newApp.call("_feed.staleInfo");
  ctx.note("picks after reload (localStorage only): " + liveAfterReloadOnly + "; after stale feed re-push: " + liveAfter + "; staleInfo set: " + !!staleInfo);

  // S-164: every recorded pick must survive an app reload.
  ctx.assert(liveAfter === liveBefore,
    "S-164 VIOLATED: " + (liveBefore - liveAfter) + " of " + liveBefore + " picks LOST across an app reload. localStorage quota was exhausted and saveLiveDraft() swallowed the QuotaExceededError silently (empty catch), so ud_live_draft_v1 held only " + persisted + " picks. With no live ESPN tab the feed is stale-gated (S-051) and cannot refill them, so picks " + (persisted + 1) + ".." + liveBefore + " are gone with no warning. Draft-day harm: reviewing a completed draft after a quota-exhausted session shows fewer picks than were actually made.");
};

// ---------------------------------------------------------------------------
// 8. eventCapMidDraft — the app caps _dlog.events at 15000 (splice oldest). A
//    pathological or long draft that crosses the cap drops the OLDEST events,
//    which include early NOMINATIONs. currentLotFromEvents scans the whole log;
//    a dropped nomination for a STILL-LIVE lot (unlikely at 15k but the cap
//    logic is what we test) would blank it. More realistically: does crossing
//    the cap break seq-monotonicity or I-FEED? We force a smaller synthetic
//    overflow by pushing many events and verify invariants hold + no crash.
// ---------------------------------------------------------------------------
SCENARIOS.eventCapMidDraft = async function (ctx) {
  const pool = buildPool();
  const leagueId = 999123;
  const app = makeAppSandbox(pool, leagueId);
  app.setFeedMode("test");

  // Directly deliver a large synthetic event stream via the app message path
  // (deliver draftEvents) to cross a lowered notion of the cap. We can't lower
  // EVENT_CAP without editing source, so we push >15000 events and confirm the
  // splice keeps seqs monotonic and picks intact. Deliver in chunks.
  const startedAt = nowFn();
  let seq = 1;
  const chunk = (n, cmd) => {
    const events = [];
    for (let i = 0; i < n; i++) events.push({ seq: seq++, at: nowFn(), cmd, teamId: 1, playerId: pool[0].espnId, amount: 2 });
    app.deliver({ source: "keeper-edge", type: "draftEvents", full: false,
      log: { leagueId: String(leagueId), sport: "flb", startedAt, total: seq, updatedAt: nowFn() }, events });
  };
  // 16000 BID events → crosses the 15000 cap.
  for (let c = 0; c < 16; c++) { chunk(1000, "BID"); await drain(); }

  const log = app.call("_dlog");
  ctx.note("events retained after 16000 pushed: " + log.events.length + " (cap 15000)");
  ctx.assert(log.events.length <= 15000, "S-047: event log exceeded the 15000 cap (" + log.events.length + ")");
  // Seqs must remain strictly increasing after the oldest-first splice.
  let mono = true, last = null;
  for (const e of log.events) { if (last != null && !(e.seq > last)) mono = false; last = e.seq; }
  ctx.assert(mono, "S-046 VIOLATED: seqs not strictly increasing after cap splice");
  const inv = app.call("checkDraftInvariants()");
  const feedErr = inv.violations.find(x => x.id === "I-FEED" && x.severity === "error");
  ctx.assert(!feedErr, "I-FEED error after cap splice: " + (feedErr ? feedErr.detail : ""));
};

// ---------------------------------------------------------------------------
// 9. clockJumpSleepWake — the laptop sleeps mid-lot and wakes 3 hours later
//    (DST or sleep-wake). Date.now() jumps forward. A lot that was live when
//    sleep began: currentLotFromEvents uses Date.now()-lastAt. After a >2h jump
//    it returns null ("ended", per S-163 / Jeff's 2h answer). Then the NEXT
//    live frame must self-heal (spec answer Q2: "next frame self-heals"). Also:
//    a BACKWARD clock jump must not make quietMs negative and mislabel state,
//    and the staleness gate (S-051) must not spuriously reject a live feed.
// ---------------------------------------------------------------------------
SCENARIOS.clockJumpSleepWake = async function (ctx) {
  const pool = buildPool();
  const leagueId = 999123;
  const app = makeAppSandbox(pool, leagueId);
  app.setFeedMode("test");
  const storageBacking = {};
  const runner = makeRunner(leagueId, pool, app, storageBacking);

  // Sell a lot, then start a live lot (nom+bid).
  await emitLot(runner, lotFrames(pool[0].espnId, 1, [{ team: 1, price: 4 }], 1, 1, 4));
  await emitFrameFlushed(runner, "NOMINATION 2 " + pool[1].espnId);
  await emitFrameFlushed(runner, "BID 2 " + pool[1].espnId + " 6 255 30000");

  const lotBeforeSleep = app.call("currentLotFromEvents()");
  ctx.assert(lotBeforeSleep && lotBeforeSleep.playerId === pool[1].espnId, "precondition: live lot before sleep");

  // Laptop sleeps 3h. Clock jumps forward.
  advance(3 * 60 * 60 * 1000);
  const lotAfterSleep = app.call("currentLotFromEvents()");
  ctx.note("lot after 3h sleep: " + (lotAfterSleep ? "player " + lotAfterSleep.playerId + (lotAfterSleep.idle ? " idle" : "") : "null (ended)"));
  // Per Jeff's Q2 answer, >2h ended is intended — so null is correct. The harm
  // would be if it CRASHED or returned a corrupt lot. Assert clean null.
  ctx.assert(lotAfterSleep === null, "S-163: lot >2h quiet must read ended (null), got " + JSON.stringify(lotAfterSleep && lotAfterSleep.playerId));

  // Self-heal: the NEXT live frame (a fresh nomination) must restore a lot.
  await emitFrameFlushed(runner, "NOMINATION 3 " + pool[2].espnId);
  await emitFrameFlushed(runner, "BID 3 " + pool[2].espnId + " 8 255 30000");
  const healed = app.call("currentLotFromEvents()");
  ctx.assert(healed && healed.playerId === pool[2].espnId,
    "spec Q2 self-heal VIOLATED: after a >2h clock jump, a fresh nomination did not restore the hero lot (got " + (healed ? healed.playerId : "null") + ")");

  // Backward jump (DST fall-back / NTP correction): clock moves back 1h. A live
  // lot's quietMs would go negative. currentLotFromEvents must not mislabel a
  // FRESH lot as ended or crash.
  advance(-60 * 60 * 1000);
  const backLot = app.call("currentLotFromEvents()");
  ctx.note("lot after 1h backward clock jump: " + (backLot ? "player " + backLot.playerId + (backLot.idle ? " idle" : " live") : "null"));
  ctx.assert(backLot && backLot.playerId === pool[2].espnId && !backLot.idle,
    "clock-back VIOLATED: a backward clock jump mislabeled the current live lot (got " + JSON.stringify(backLot && { id: backLot.playerId, idle: backLot.idle }) + ")");
};

// ---------------------------------------------------------------------------
// 10. modeFlipMidStream — test → real → test while events flow. S-109/S-110:
//     is_mock must track the mode; a real→ session must not stay mock, and a
//     test session must never be labeled real. S-008/S-009: in real mode a
//     non-1200 league's picks/events must be REJECTED. Flipping to real while a
//     999123 stream is live must stop ingesting it.
// ---------------------------------------------------------------------------
SCENARIOS.modeFlipMidStream = async function (ctx) {
  const pool = buildPool();
  const leagueId = 999123;      // a mock league (NOT 1200)
  const app = makeAppSandbox(pool, leagueId);
  app.setFeedMode("test");
  const storageBacking = {};
  const runner = makeRunner(leagueId, pool, app, storageBacking);

  // Test mode: sell 2 lots for the mock league.
  for (let i = 0; i < 2; i++) {
    for (const f of lotFrames(pool[i].espnId, 1, [{ team: 1, price: 5 + i }], 1, i + 1, 5 + i)) { runner.ext.emitFrame(f); advance(200); await drain(); }
  }
  const picksAfterTest = app.picks().length;
  ctx.assert(picksAfterTest === 2, "precondition: 2 mock picks in test mode");

  // Flip to REAL. Now the 999123 stream must be REJECTED (S-008/S-009).
  app.setFeedMode("real");
  await drain();
  // Deliver another SOLD from the mock league (999123) — must NOT ingest.
  for (const f of lotFrames(pool[2].espnId, 1, [{ team: 1, price: 12 }], 1, 3, 12)) { runner.ext.emitFrame(f); advance(200); await drain(); }
  const picksAfterReal = app.picks().length;
  ctx.note("picks after flipping to real + mock SOLD: " + picksAfterReal + " (was " + picksAfterTest + ")");
  ctx.assert(picksAfterReal === picksAfterTest,
    "S-008 VIOLATED: after flipping to REAL, a non-1200 mock league's SOLD was still ingested (" + picksAfterTest + " → " + picksAfterReal + ")");

  // Flip back to test — the mock stream should ingest again.
  app.setFeedMode("test");
  await drain();
  for (const f of lotFrames(pool[3].espnId, 1, [{ team: 1, price: 3 }], 1, 4, 3)) { runner.ext.emitFrame(f); advance(200); await drain(); }
  ctx.note("picks after flipping back to test: " + app.picks().length);

  const inv = app.call("checkDraftInvariants()");
  const errs = inv.violations.filter(x => x.severity === "error");
  ctx.assert(errs.length === 0, "invariant errors after mode flips: " + errs.map(e => e.id + ":" + e.detail).slice(0, 3).join(" | "));
};

// ---------------------------------------------------------------------------
// 11. supabaseFlushRacesRotation — a same-league re-draft rotation (fresh
//     startedAt) happens while the Supabase mirror still has queued events from
//     draft-1. S-105: session identity is "<leagueId>:<startedAt>". S-060:
//     rotation gives a fresh startedAt → fresh session. The risk: draft-2 events
//     (new startedAt) must land in a NEW session, and draft-1's queued events
//     must not be re-tagged into draft-2's session. We drive the real
//     logDraftEvents (draft-log.js) via the app and inspect the mirror capture.
// ---------------------------------------------------------------------------
SCENARIOS.supabaseFlushRacesRotation = async function (ctx) {
  const pool = buildPool();
  const leagueId = 999123;
  const app = makeAppSandbox(pool, leagueId);
  app.setFeedMode("test");

  // Draft 1: log some events with startedAt = T1.
  const T1 = nowFn();
  app.call("logDraftEvents({leagueId:'" + leagueId + "', sport:'flb', startedAt:" + T1 + "}, " +
    "[{seq:1,at:" + T1 + ",cmd:'SOLD',teamId:1,playerId:" + pool[0].espnId + ",amount:5}," +
    "{seq:2,at:" + T1 + ",cmd:'SOLD',teamId:2,playerId:" + pool[1].espnId + ",amount:6}], true)");
  // Force a flush (draft-log uses setTimeout, stubbed no-op; call _dlFlush).
  await app.call("_dlFlush()"); await drain();
  const key1 = app.call("DRAFT_LOG.clientKey");
  ctx.note("draft-1 clientKey: " + key1);

  // Rotation: a NEW draft on the SAME league, fresh startedAt = T2.
  advance(90 * 60 * 1000);
  const T2 = nowFn();
  app.call("logDraftEvents({leagueId:'" + leagueId + "', sport:'flb', startedAt:" + T2 + "}, " +
    "[{seq:1,at:" + T2 + ",cmd:'SOLD',teamId:3,playerId:" + pool[2].espnId + ",amount:7}], true)");
  await app.call("_dlFlush()"); await drain();
  const key2 = app.call("DRAFT_LOG.clientKey");
  ctx.note("draft-2 clientKey: " + key2 + "; session upserts: " + JSON.stringify(app.mirror.sessionUpserts.map(s => s.client_key)));

  // S-105/S-106: two distinct sessions (different client_key), and draft-2's
  // event must upsert under draft-2's session, not draft-1's.
  ctx.assert(key1 !== key2, "S-105 VIOLATED: rotation did not create a new client_key (" + key1 + " == " + key2 + ")");
  const keys = app.mirror.sessionUpserts.map(s => s.client_key);
  ctx.assert(keys.includes(key1) && keys.includes(key2),
    "S-105 VIOLATED: expected two session upserts (" + key1 + ", " + key2 + "), got " + JSON.stringify(keys));
  // draft-2's watermark must start fresh (uploadedSeq for the new session begins
  // at that session's own seqs, not carried from draft-1).
  const status = app.call("draftLogStatus()");
  ctx.note("final mirror status: " + JSON.stringify(status));
};

// ---------------------------------------------------------------------------
// 12. staleCaptureNoTabIngest — a >15min-old capture with NO ESPN tab open must
//     NOT ingest (S-051) and must show "not live" (S-052/S-165). This models the
//     app reopening the next day: chrome.storage still holds yesterday's feed;
//     ud-bridge re-pushes it on load. Assert old picks are NOT silently
//     re-ingested into _liveDraft (they'd fake a live draft / refill cleared
//     picks).
// ---------------------------------------------------------------------------
SCENARIOS.staleCaptureNoTabIngest = async function (ctx) {
  const pool = buildPool();
  const leagueId = 999123;
  const app = makeAppSandbox(pool, leagueId);
  app.setFeedMode("test");

  // Craft an OLD feed (updatedAt 20 min ago; no ESPN tab heartbeat delivered).
  const old = nowFn() - 20 * 60 * 1000;
  const feed = { leagueId: String(leagueId), sport: "flb", startedAt: old,
    picks: [ { playerId: pool[0].espnId, teamId: 1, price: 5, seq: 1, ts: old },
             { playerId: pool[1].espnId, teamId: 2, price: 6, seq: 2, ts: old } ],
    seen: {}, updatedAt: old };

  // ud-bridge would push this on load. Deliver directly as a draftFeed message.
  app.deliver({ source: "keeper-edge", type: "draftFeed", feed });
  await drain(); await drain();

  const picks = app.picks().length;
  const feedState = app.call("_feed");
  ctx.note("picks ingested from 20-min-old feed (no tab): " + picks + "; staleInfo: " + JSON.stringify(feedState.staleInfo) + "; connected: " + feedState.connected);
  // S-051: must NOT ingest.
  ctx.assert(picks === 0, "S-051 VIOLATED: a 20-min-old capture with no ESPN tab was ingested (" + picks + " picks) — would fake a live draft / refill cleared picks");
  // S-052: staleInfo set + not connected.
  ctx.assert(feedState.staleInfo && !feedState.connected, "S-052 VIOLATED: stale capture not marked 'not live' (staleInfo=" + JSON.stringify(feedState.staleInfo) + ", connected=" + feedState.connected + ")");
};

// ===========================================================================
// Runner
// ===========================================================================
async function runOne(name) {
  const fn = SCENARIOS[name];
  const ctx = Ctx(name);
  setClock(1_700_000_000_000);   // reset clock per scenario
  try {
    await fn(ctx);
  } catch (e) {
    ctx.failures.push("THREW: " + (e && e.stack || e));
  }
  return ctx;
}

async function main() {
  const argv = process.argv.slice(2);
  let only = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--scenario") only = argv[++i];
    else if (argv[i] === "--list") { console.log(Object.keys(SCENARIOS).join("\n")); process.exit(0); }
    else { console.error("unknown arg " + argv[i]); process.exit(2); }
  }
  if (only && !SCENARIOS[only]) { console.error("unknown scenario " + only + "\navailable:\n  " + Object.keys(SCENARIOS).join("\n  ")); process.exit(2); }

  const names = only ? [only] : Object.keys(SCENARIOS);
  const results = [];
  for (const n of names) results.push(await runOne(n));

  const G = (s) => "\x1b[32m" + s + "\x1b[0m", R = (s) => "\x1b[31m" + s + "\x1b[0m", D = (s) => "\x1b[2m" + s + "\x1b[0m";
  let failed = 0;
  console.log("\n=== Phase 2 Round 1 — Chaos scenarios ===\n");
  for (const r of results) {
    const ok = r.failures.length === 0;
    if (!ok) failed++;
    console.log((ok ? G("PASS") : R("FAIL")) + "  " + r.name);
    for (const nt of r.notes) console.log(D("      · " + nt));
    for (const f of r.failures) console.log(R("      ✗ " + f));
  }
  console.log("\n" + (failed ? R(failed + " scenario(s) FAILED (findings)") : G("all " + results.length + " scenarios PASS")) +
    " — " + results.length + " run\n");
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error("chaos crashed:", e && e.stack || e); process.exit(3); });
