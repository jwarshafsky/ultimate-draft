#!/usr/bin/env node
// ===========================================================================
// Ultimate Draft — headless chaos simulator (Phase 1c).
//
// Generates a full synthetic ESPN auction as a frame script and replays it
// through the REAL pipeline end to end:
//
//   synthetic ESPN frames
//        │  (drive the real MAIN-world hook)
//        ▼
//   draft-socket-capture.js  →  window.postMessage({__udDraft:true,...})
//        │  (real isolated-world bridge)
//        ▼
//   draft-bridge.js          →  chrome.storage.local.set(...)
//        │  (real app-tab bridge)
//        ▼
//   ud-bridge.js             →  window.postMessage({source:"keeper-edge",...})
//        │  (real app message listener)
//        ▼
//   draft.js / endgame.js / inflation.js / invariants.js  (the app engines)
//
// The extension half and the app half each run in their OWN vm sandbox (so the
// two `window`s / `chrome`s don't collide), bridged by hand exactly the way the
// two real browser tabs are bridged: the extension sandbox's chrome.storage
// writes are delivered as onChanged events to ud-bridge, whose postMessage
// output is fed into the app sandbox's "message" listener.
//
// After every SOLD lot we run checkDraftInvariants() against the app sandbox and
// assert zero "error"-severity violations. At the end we assert the app's final
// pick list matches the script's ground-truth sales (accounting for undos) and
// print a scorecard.
//
// Self-contained: no npm deps, only node built-ins (fs, vm, path). Does NOT
// touch test/helpers.js or any sibling test file.
//
// CLI: node test/simulate-draft.js [--seed 42] [--full] [--all] [--flag name]...
// Exit nonzero on any assertion failure.
// ===========================================================================

const fs = require("fs");
const vm = require("vm");
const path = require("path");

const APP = path.resolve(__dirname, "..");                 // ultimate-draft/
const EXT = path.resolve(__dirname, "..", "..", "keeper-edge-extension");

// --------------------------------------------------------------------------
// CLI parsing
// --------------------------------------------------------------------------
const ALL_FLAGS = [
  "duplicateSoldFrames", "undoMidDraft", "reconnectInit", "pauseGap",
  "appReload", "extensionReload", "hiddenTabDelay", "unknownFrames",
  "sameLeagueSecondDraft",
];
function parseArgs(argv) {
  const opts = { seed: 42, full: false, flags: {} };
  for (const f of ALL_FLAGS) opts.flags[f] = false;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--seed") opts.seed = parseInt(argv[++i], 10) || 42;
    else if (a === "--full") opts.full = true;
    else if (a === "--all") for (const f of ALL_FLAGS) opts.flags[f] = true;
    else if (a === "--flag") {
      const name = argv[++i];
      if (ALL_FLAGS.includes(name)) opts.flags[name] = true;
      else { console.error("unknown --flag " + name); process.exit(2); }
    } else if (a.startsWith("--") && ALL_FLAGS.includes(a.slice(2))) {
      opts.flags[a.slice(2)] = true;
    } else {
      console.error("unknown arg " + a); process.exit(2);
    }
  }
  return opts;
}

// --------------------------------------------------------------------------
// Deterministic PRNG (mulberry32)
// --------------------------------------------------------------------------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --------------------------------------------------------------------------
// Controllable clock — one `now` shared by BOTH sandboxes and this driver so
// there is zero Date.now() drift. Advanced explicitly per event.
// --------------------------------------------------------------------------
let CLOCK = 1_700_000_000_000;   // fixed epoch start
const nowFn = () => CLOCK;
function advance(ms) { CLOCK += ms; }

// --------------------------------------------------------------------------
// Synthetic player pool — 400 players with values. The app resolves picks by
// ESPN playerId → name via _espnIdToName, and prices/inflates by name via
// getValues()/getPlayerValue(). We seed BOTH from this one pool so names always
// resolve and no pick becomes a "ghost".
// --------------------------------------------------------------------------
function buildPool(rng) {
  const players = [];
  const posCycle = ["C", "1B", "2B", "SS", "3B", "OF", "OF", "OF", "SP", "SP", "RP"];
  const types = { C: "H", "1B": "H", "2B": "H", SS: "H", "3B": "H", OF: "H", SP: "P", RP: "P" };
  for (let i = 0; i < 400; i++) {
    const espnId = 100000 + i;             // > 1000 so INIT/lot filters accept it
    const posKey = posCycle[i % posCycle.length];
    // Value curve: a handful of stars, long tail to $1.
    const value = Math.max(1, Math.round(60 * Math.pow(1 - i / 400, 2)));
    players.push({
      espnId,
      name: "Player " + espnId,            // stable synthetic name
      posKey,
      type: types[posKey],
      value,
    });
  }
  return players;
}

// --------------------------------------------------------------------------
// Draft-script generator. Produces an ordered list of synthetic ESPN frames
// plus the ground-truth sales the app must end up matching.
//
// Each lot: NOMINATION, 2–12 escalating BIDs by distinct teams, SOLD.
// Chaos flags inject extra/altered frames (see inline).
// --------------------------------------------------------------------------
function generateDraftScript(seed, opts, pool) {
  const rng = mulberry32(seed);
  const nLots = opts.full ? 300 : 60;
  const frames = [];              // { text, advanceMs, tag }
  const sales = [];               // ground truth: { playerId, teamId, price, seq }
  const numTeams = 12;
  let seq = 1;                    // ESPN lot seq (monotonic across the draft)
  const usedPlayers = new Set();

  const pick = (n) => Math.floor(rng() * n);
  const emit = (text, advanceMs, tag) => frames.push({ text, advanceMs: advanceMs || 0, tag: tag || null });

  // Pool indices in value order (pool already value-descending-ish).
  let poolIdx = 0;
  const nextPlayer = () => {
    while (poolIdx < pool.length && usedPlayers.has(pool[poolIdx].espnId)) poolIdx++;
    return poolIdx < pool.length ? pool[poolIdx++] : null;
  };

  const undoQueue = [];          // players to re-nominate later (undoMidDraft)

  for (let lot = 0; lot < nLots; lot++) {
    const p = nextPlayer();
    if (!p) break;
    usedPlayers.add(p.espnId);
    const nomTeam = 1 + pick(numTeams);

    emit("NOMINATION " + nomTeam + " " + p.espnId, 500, "nom");

    // pauseGap: a 20-min silence mid-lot (before bids resolve).
    if (opts.flags.pauseGap && lot > 0 && lot % 17 === 0) {
      emit("CLOCK 1 2 3", 20 * 60 * 1000, "pausegap");   // liveness only, big time jump
    }

    // 2–12 escalating bids by distinct teams.
    const nBids = 2 + pick(11);
    const bidders = [];
    const avail = [];
    for (let t = 1; t <= numTeams; t++) avail.push(t);
    // shuffle bidders
    for (let i = avail.length - 1; i > 0; i--) { const j = pick(i + 1); [avail[i], avail[j]] = [avail[j], avail[i]]; }
    let price = 1;
    for (let b = 0; b < nBids && b < avail.length; b++) {
      const team = avail[b];
      bidders.push({ team, price });
      // BID <teamId> <playerId> <amount> <budget?> <timeLeftMs>
      emit("BID " + team + " " + p.espnId + " " + price + " 255 30000", 300, "bid");
      price += 1 + pick(3);
    }
    const winner = bidders[bidders.length - 1];
    const soldPrice = winner.price;
    const soldTeam = winner.team;

    // hiddenTabDelay: model batched storage flushes by NOT flushing between
    // frames — handled at the driver level via a flag; here we just tag.
    emit("SOLD " + soldTeam + " " + p.espnId + " " + seq + " " + soldPrice + " 0", 400, "sold");
    sales.push({ playerId: p.espnId, teamId: soldTeam, price: soldPrice, seq });
    seq++;

    // duplicateSoldFrames: repeat the exact SOLD (must dedup, no double pick).
    if (opts.flags.duplicateSoldFrames && lot % 5 === 2) {
      emit("SOLD " + soldTeam + " " + p.espnId + " " + (seq - 1) + " " + soldPrice + " 0", 100, "dupsold");
    }

    // unknownFrames: inject garbage/unknown commands (must be logged, ignored).
    if (opts.flags.unknownFrames && lot % 7 === 3) {
      emit("UNDO_SOMETHING " + soldTeam + " " + p.espnId, 100, "unknown");
      emit("GARBAGE lorem ipsum " + lot, 100, "unknown");
    }

    // undoMidDraft: queue this player for a later re-nomination + re-sale with a
    // NEW seq (commissioner undo → re-auction). The re-sale REPLACES the pick.
    if (opts.flags.undoMidDraft && lot % 11 === 6) {
      undoQueue.push({ player: p, prevSeq: seq - 1, origIdx: sales.length - 1 });
    }

    // reconnectInit: a socket reconnect mid-stream sends INIT with the current
    // full pick state. We encode it with the real binary layout so the real
    // parseInitPicks path runs. Emitted as a special INIT frame the driver
    // expands (needs the running sale list).
    if (opts.flags.reconnectInit && lot > 0 && lot % 23 === 0) {
      emit("__INIT__", 200, "init");   // driver replaces with encoded INIT using sales so far
    }
  }

  // Drain the undo queue: for each, re-nominate + re-sell to a (possibly)
  // different team at a (possibly) different price with a fresh seq. Ground
  // truth is updated so the winner/price REPLACE the original sale.
  for (const u of undoQueue) {
    const p = u.player;
    const newTeam = 1 + pick(numTeams);
    const newPrice = 1 + pick(40);
    emit("NOMINATION " + newTeam + " " + p.espnId, 500, "renom");
    emit("BID " + newTeam + " " + p.espnId + " " + newPrice + " 255 30000", 300, "rebid");
    emit("SOLD " + newTeam + " " + p.espnId + " " + seq + " " + newPrice + " 0", 400, "resold");
    // Replace ground truth for this player.
    sales[u.origIdx] = { playerId: p.espnId, teamId: newTeam, price: newPrice, seq };
    seq++;
  }

  return { frames, sales, nLots, nextSeq: seq };
}

// --------------------------------------------------------------------------
// INIT binary encoder — mirrors parseInitPicks' layout so the REAL parser runs.
// Each roster record: [leagueId u32][team i32][slotA i32][playerId i32][lslot i32][price i32]
// parseInitPicks slides a window looking for the leagueId u32 marker, so we can
// simply concatenate one 24-byte record per pick (marker at offset 0 of each).
// --------------------------------------------------------------------------
function encodeInitB64(leagueId, picks) {
  const rec = 24;
  const buf = Buffer.alloc(rec * picks.length);
  const lid = (Number(leagueId) >>> 0);
  picks.forEach((p, i) => {
    const o = i * rec;
    buf.writeUInt32BE(lid, o);
    buf.writeInt32BE(p.teamId, o + 4);
    buf.writeInt32BE(p.seq, o + 8);          // slotA — parser stores as seq
    buf.writeInt32BE(p.playerId, o + 12);
    buf.writeInt32BE(0, o + 16);             // lineupSlot (0..40 ok)
    buf.writeInt32BE(p.price, o + 20);
  });
  return buf.toString("base64");
}

// Extract a single top-level `function NAME(...) { ... }` from source text by
// brace-matching (used to splice the REAL processEspnPicks out of espn.js
// without pulling in that file's proxy/fetch globals).
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
// Extension sandbox — runs draft-socket-capture.js + draft-bridge.js in a vm
// context whose window/chrome/location/etc. we control. Its chrome.storage
// writes are surfaced to a callback (→ ud-bridge in the app sandbox).
// --------------------------------------------------------------------------
function makeExtensionSandbox(leagueId, storageBacking, onStorageChange) {
  // Each ESPN-tab bridge instance shares the persistent chrome.storage backing
  // (so an extension reload restores prior state) but has its own window/WS.
  const wsListeners = {};
  const winListeners = [];
  let intervalFns = [];   // captured setInterval callbacks (driven manually)

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
  sandbox.setTimeout = (fn) => { try { fn(); } catch (e) {} return 0; };  // run immediately (deterministic)
  sandbox.clearTimeout = () => {};

  sandbox.location = { pathname: "/baseball/draft", search: "?leagueId=" + leagueId };

  sandbox.chrome = {
    storage: {
      local: {
        get(keys, cb) {
          const o = {};
          (Array.isArray(keys) ? keys : [keys]).forEach(k => {
            if (storageBacking[k] !== undefined) o[k] = JSON.parse(JSON.stringify(storageBacking[k]));
          });
          cb(o);   // synchronous — deterministic ordering
        },
        set(obj, cb) {
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
      onChanged: {
        _fns: [],
        addListener(fn) { this._fns.push(fn); },
      },
    },
  };

  // window with WebSocket hook + postMessage. The MAIN-world capture posts with
  // "*" target; the isolated bridge listens for {__udDraft:true}. Both live in
  // THIS window, so a same-window postMessage delivers between them.
  function FakeWS(url) { this.url = url; }
  FakeWS.prototype.addEventListener = function (type, fn) { (wsListeners[type] = wsListeners[type] || []).push(fn); };
  FakeWS.CONNECTING = 0; FakeWS.OPEN = 1; FakeWS.CLOSING = 2; FakeWS.CLOSED = 3;

  sandbox.window = {
    WebSocket: FakeWS,
    postMessage(msg) {
      // Deliver to same-window listeners (source === window).
      const ev = { source: sandbox.window, data: msg };
      winListeners.forEach(fn => { try { fn(ev); } catch (e) {} });
    },
    addEventListener(type, fn) { if (type === "message" || type === "pagehide") { if (type === "message") winListeners.push(fn); if (type === "pagehide") sandbox.__pagehide = fn; } },
  };
  sandbox.self = sandbox.window;
  sandbox.globalThis = sandbox;
  // draft-socket-capture references bare `window`, `location`, `console`, etc.
  vm.createContext(sandbox);

  // Load the two ESPN-tab scripts into this context.
  const capSrc = fs.readFileSync(path.join(EXT, "draft-socket-capture.js"), "utf8");
  const brSrc = fs.readFileSync(path.join(EXT, "draft-bridge.js"), "utf8");
  vm.runInContext(capSrc, sandbox, { filename: "draft-socket-capture.js" });
  vm.runInContext(brSrc, sandbox, { filename: "draft-bridge.js" });

  // Open the hooked draft socket so the capture hook taps it.
  const ws = new sandbox.window.WebSocket("wss://fantasydraft.espn.com/game-99/JOIN?1=99&2=" + leagueId);

  return {
    sandbox,
    // Deliver a raw ESPN frame text into the socket.
    emitFrame(text) {
      (wsListeners.message || []).forEach(fn => { try { fn({ data: text }); } catch (e) {} });
    },
    // Run all registered flush/beat intervals once (e.g. before a reload).
    tick() { intervalFns.forEach(fn => { try { fn(); } catch (e) {} }); },
    // Fire pagehide (flush) — used before extension reload.
    pagehide() { if (sandbox.__pagehide) try { sandbox.__pagehide(); } catch (e) {} },
    onChangedFns: sandbox.chrome.storage.onChanged._fns,
    storageBacking,
  };
}

// --------------------------------------------------------------------------
// App sandbox — runs the real app engine files (inflation, endgame, draft,
// draft-mode, invariants) plus a stub data layer, in a vm context. ud-bridge
// runs HERE too (the app tab hosts it), forwarding chrome.storage → postMessage
// into the app's own message listener.
//
// The app sandbox has its OWN chrome.storage backing that MIRRORS the extension
// backing: whenever the extension writes, the driver copies the changed keys in
// and fires this sandbox's onChanged, exactly as a shared chrome.storage would.
// --------------------------------------------------------------------------
function makeAppSandbox(pool, leagueOverrideId) {
  const sandbox = {};
  const localStore = {};        // localStorage backing
  const winListeners = [];
  const docListeners = {};
  const onChangedFns = [];
  const chromeBacking = {};

  sandbox.console = { log() {}, error() {}, warn() {} };
  sandbox.Date = { now: nowFn };
  sandbox.Buffer = Buffer;
  sandbox.JSON = JSON;
  sandbox.Math = Math;
  sandbox.Set = Set; sandbox.Map = Map;
  sandbox.Array = Array; sandbox.Object = Object; sandbox.Number = Number; sandbox.String = String;
  sandbox.Boolean = Boolean; sandbox.RegExp = RegExp; sandbox.isFinite = isFinite; sandbox.parseInt = parseInt;
  sandbox.parseFloat = parseFloat; sandbox.isNaN = isNaN;
  sandbox.URLSearchParams = URLSearchParams;
  sandbox.atob = (b) => Buffer.from(b, "base64").toString("binary");
  sandbox.setTimeout = () => 0;       // no-op: we drive time explicitly
  sandbox.clearTimeout = () => {};
  sandbox.setInterval = () => 0;
  sandbox.clearInterval = () => {};

  sandbox.location = { origin: "https://app.test", pathname: "/", search: "" };

  // localStorage stub (also the reload-serialize surface).
  sandbox.localStorage = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(localStore, k) ? localStore[k] : null; },
    setItem(k, v) { localStore[k] = String(v); },
    removeItem(k) { delete localStore[k]; },
    _store: localStore,
  };
  if (leagueOverrideId) localStore["ud_league_override"] = String(leagueOverrideId);

  // Minimal DOM: getElementById returns null (headless), addEventListener
  // captures, querySelectorAll returns []. currentView !== "draft" so the app
  // avoids render paths; we call engine functions directly.
  sandbox.document = {
    getElementById() { return null; },
    querySelectorAll() { return []; },
    addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
    body: { classList: { add() {}, remove() {}, toggle() {} } },
    createElement() { return { style: {}, appendChild() {}, click() {}, remove() {} }; },
  };

  sandbox.window = {
    postMessage(msg) {
      const ev = { source: sandbox.window, data: msg };
      winListeners.forEach(fn => { try { fn(ev); } catch (e) {} });
    },
    addEventListener(type, fn) { if (type === "message") winListeners.push(fn); },
  };
  sandbox.self = sandbox.window;
  sandbox.globalThis = sandbox;

  sandbox.chrome = {
    storage: {
      local: {
        get(keys, cb) {
          const o = {};
          (Array.isArray(keys) ? keys : [keys]).forEach(k => {
            if (chromeBacking[k] !== undefined) o[k] = JSON.parse(JSON.stringify(chromeBacking[k]));
          });
          cb(o);
        },
        set(obj, cb) {
          for (const k of Object.keys(obj)) chromeBacking[k] = JSON.parse(JSON.stringify(obj[k]));
          if (cb) cb();
        },
        remove(keys, cb) {
          (Array.isArray(keys) ? keys : [keys]).forEach(k => delete chromeBacking[k]);
          if (cb) cb();
        },
      },
      onChanged: { addListener(fn) { onChangedFns.push(fn); } },
    },
  };

  // ---------------- stub data layer (globals the real engines reference) ----
  sandbox.LEAGUE = {
    teams: [
      { id: "matt", name: "Matt", owner: "Matt" },
      { id: "saxton", name: "Saxton", owner: "Saxton" },
      { id: "sam", name: "Sam", owner: "Sam" },
      { id: "glix", name: "Glicksmans", owner: "Glicksmans" },
      { id: "jeff", name: "Jeff", owner: "Jeff", isMe: true },
      { id: "aj", name: "AJ", owner: "AJ" },
      { id: "corey", name: "Corey", owner: "Corey" },
      { id: "jd", name: "Josh/Doug", owner: "Josh/Doug" },
      { id: "wein", name: "Larry", owner: "Larry" },
      { id: "klin", name: "Klinger", owner: "Klinger" },
      { id: "dave", name: "Dave", owner: "Dave" },
      { id: "jtl", name: "Jesse", owner: "Jesse" },
    ],
    draftBudget: 260, numTeams: 12, luxuryTax: 350, rosterSize: 26,
    hitCats: ["R", "HR", "RBI", "SB", "OBP"], pitCats: ["QS", "K", "SV_HLD", "ERA", "WHIP"],
  };
  sandbox.VALUATION = { hitBudgetPct: 0.66, minDollar: 1 };
  sandbox.POS_TARGETS = { C: 1, "1B": 1, "2B": 1, SS: 1, "3B": 1, MI: 1, CI: 1, OF: 5, UTIL: 1, SP: 6, RP: 3 };
  sandbox.UD_HOME_LEAGUE_ID = 1200;

  sandbox.getMyTeam = function () { return sandbox.LEAGUE.teams.find(t => t.isMe); };
  sandbox.getTeam = function (id) { return sandbox.LEAGUE.teams.find(t => t.id === id); };
  sandbox.getKeeperSelections = function () { return {}; };
  sandbox.getEffectiveKeeperSelections = function () { return {}; };
  sandbox.getCurrentKeeperSalary = function () { return null; };
  sandbox.getLeagueContractByName = function () { return null; };
  sandbox.getBudgetAdjustment = function () { return 0; };
  sandbox.getDraftDollarAdjustment = function () { return 0; };
  sandbox.getFlaggedPlayers = function () { return []; };
  sandbox.getMyRoster = function () { return []; };
  sandbox.projectTeamCategories = function () { return {}; };
  sandbox.esc = function (s) { return String(s == null ? "" : s); };
  sandbox.setStatus = function () {};
  sandbox.getNfbc = function () { return null; };
  sandbox.getStatcast = function () { return null; };
  sandbox.statcastBuySell = function () { return null; };
  sandbox.classifyPriceVsTargets = function () { return null; };
  sandbox.renderTagIcons = function () { return ""; };
  sandbox.renderTargetBadge = function () { return ""; };
  sandbox.logDraftEvents = function () {};
  sandbox.draftLogStatus = function () { return { sessionId: null, pending: 0, uploadedSeq: 0, isMock: true }; };
  sandbox.recordInflationSnapshot = function () {};
  sandbox.ensureRotowireNews = function () {};
  sandbox.fetchEspnPlayers = null;   // so _ensureEspnNames early-returns; we seed _espnIdToName directly

  // ESPN team-id → owner-id map (real-league mapping — matches espn.js).
  const ESPN_TEAM_ID_MAP = {
    1: "matt", 2: "saxton", 3: "sam", 4: "glix", 5: "jeff",
    6: "aj", 7: "corey", 8: "jd", 9: "wein", 10: "klin", 12: "dave", 13: "jtl",
  };
  sandbox.espnTeamIdToOwnerId = function (id) { return ESPN_TEAM_ID_MAP[id] || null; };

  // ESPN object the app engines read (leagueId, listeners, polling).
  sandbox.ESPN = {
    leagueId: leagueOverrideId ? Number(leagueOverrideId) : 1200,
    listeners: [], polling: false, proxyUrl: "",
  };
  sandbox.leagueOverrideActive = function () { return sandbox.ESPN.leagueId !== sandbox.UD_HOME_LEAGUE_ID; };
  sandbox.setLeagueOverride = function (id) {
    const n = Number(id);
    if (isFinite(n) && n > 0 && n !== sandbox.UD_HOME_LEAGUE_ID) { sandbox.ESPN.leagueId = n; localStore["ud_league_override"] = String(n); }
    else { sandbox.ESPN.leagueId = sandbox.UD_HOME_LEAGUE_ID; delete localStore["ud_league_override"]; }
  };

  // Value pool — getValues / getPlayerValue over the synthetic pool.
  const byName = new Map(pool.map(p => [p.name, { name: p.name, posKey: p.posKey, type: p.type, value: p.value }]));
  const valuesList = pool.map(p => byName.get(p.name)).sort((a, b) => b.value - a.value);
  sandbox.getValues = function () { return valuesList; };
  sandbox.getPlayerValue = function (name) { return byName.get(name) || null; };

  // normalizePlayerName / coreNameKey (copied from ros-projections.js).
  sandbox.normalizePlayerName = function (s) {
    if (!s) return "";
    let n = String(s).normalize("NFD").replace(/[̀-ͯ]/g, "");
    n = n.toLowerCase().replace(/[.'`’]/g, "").replace(/[^a-z0-9 ]/g, " ");
    n = n.replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "");
    return n.replace(/\s+/g, " ").trim();
  };
  sandbox.coreNameKey = function (name) {
    const toks = sandbox.normalizePlayerName(name).split(" ").filter(Boolean);
    if (toks.length <= 2) return toks.join(" ");
    const mids = toks.slice(1, -1).filter(t => t.length > 1);
    return [toks[0], ...mids, toks[toks.length - 1]].join(" ");
  };

  // currentView left as "overview" so render paths are skipped; engines that
  // check `currentView === "draft"` won't try to touch the (null) DOM.
  sandbox.currentView = "overview";

  vm.createContext(sandbox);

  // Load the real engine files IN ORDER, CONCATENATED into ONE program. This
  // matches the browser's single shared scope: a `const`/`function` declared at
  // the top level of one file is visible to the next (draft.js calls
  // computeFlatInflation from inflation.js, invariants.js calls
  // computeLiveTeamStates, etc.). vm gives each runInContext its OWN program
  // scope, so loading files separately would hide those lexical bindings from
  // each other — hence one concatenated program.
  //
  // draft.js at load calls loadLiveDraft()/_dlogLoad() (localStorage), registers
  // listeners, and sets (no-op) timers — all fine in the stubbed environment.
  const files = [
    "js/core/inflation.js",
    "js/features/endgame.js",
    "js/features/draft-mode.js",
    "js/features/draft.js",
    "js/core/invariants.js",
    "js/features/ai-assistant.js",   // buildAiContext for I-MODE (best-effort)
  ];
  let program = files.map(rel =>
    "\n//======== " + rel + " ========\n" + fs.readFileSync(path.join(APP, rel), "utf8")).join("\n");

  // processEspnPicks lives in js/data/espn.js, which we DON'T load wholesale (it
  // redeclares ESPN / UD_HOME_LEAGUE_ID that we stub, and drags in proxy/fetch).
  // But _applyDraftFeed calls the REAL processEspnPicks to add feed picks, so we
  // splice just that function out of the real source into the concat scope (it
  // resolves _liveDraft / getPlayerValue / saveLiveDraft / draftTestMode /
  // espnTeamIdToOwnerId as concat-scope + stubbed globals). Using the real
  // function keeps the pick-add path honest.
  program += "\n//======== spliced: processEspnPicks (from js/data/espn.js) ========\n" +
    extractFunction(fs.readFileSync(path.join(APP, "js/data/espn.js"), "utf8"), "processEspnPicks");
  // Export the lexically-scoped names the driver needs onto globalThis.__ud so
  // vm.runInContext (a fresh program scope) can reach them. Also expose a setter
  // for the `let _espnIdToName` so we can seed the id→name map.
  program += "\nglobalThis.__ud = {" +
    " get liveDraft(){return _liveDraft;}," +
    " get dlog(){return _dlog;}," +
    " get feed(){return _feed;}," +
    " checkDraftInvariants: (typeof checkDraftInvariants==='function'?checkDraftInvariants:null)," +
    " setFeedMode: (typeof setFeedMode==='function'?setFeedMode:null)," +
    " loadLiveDraft: (typeof loadLiveDraft==='function'?loadLiveDraft:null)," +
    " dlogLoad: (typeof _dlogLoad==='function'?_dlogLoad:null)," +
    " setEspnNames: function(m){ _espnIdToName = m; }," +
    " eval: function(code){ return eval(code); }" +
    "};\n";
  vm.runInContext(program, sandbox, { filename: "ud-engines-concat.js" });

  // Load the REAL app-tab bridge (ud-bridge.js). It's a self-contained IIFE that
  // listens to chrome.storage.onChanged and forwards {source:"keeper-edge",...}
  // via window.postMessage into the app's own message listener — the exact link
  // that carries data from the (mirrored) extension storage into the engines.
  const bridgeSrc = fs.readFileSync(path.join(EXT, "ud-bridge.js"), "utf8");
  vm.runInContext(bridgeSrc, sandbox, { filename: "ud-bridge.js" });

  const ud = sandbox.__ud;

  // Seed the ESPN id→name map directly (fetchEspnPlayers is stubbed null, so
  // the app's async fetch never runs; picks resolve by this map).
  const idToName = {};
  for (const p of pool) idToName[p.espnId] = p.name;
  ud.setEspnNames(idToName);

  return {
    sandbox,
    ud,
    onChangedFns,
    chromeBacking,
    localStore,
    // Deliver a keeper-edge postMessage into the app's message listener.
    deliver(msg) {
      const ev = { source: sandbox.window, data: msg };
      winListeners.forEach(fn => { try { fn(ev); } catch (e) {} });
    },
    // Set feed mode as the app would (test/real/off).
    setFeedMode(mode) { ud.setFeedMode(mode); if (mode === "test") ud.setEspnNames(idToName); },
    call(expr) { return ud.eval(expr); },
    picks() { return ud.liveDraft.picks; },
    idToName,
  };
}

// --------------------------------------------------------------------------
// Assertion helper — accumulate failures, exit nonzero at the end.
// --------------------------------------------------------------------------
let FAILURES = [];
function assert(cond, msg) { if (!cond) FAILURES.push(msg); }

// --------------------------------------------------------------------------
// The bridge wiring: an extension sandbox and an app sandbox connected exactly
// like the two real tabs. The extension's chrome.storage backing is shared with
// the app's ud-bridge by copying changed keys into the app's chrome backing and
// firing the app's onChanged — the same effect as one shared chrome.storage.
// --------------------------------------------------------------------------
function makeDraftRunner(leagueId, pool, app, opts, storageBacking) {
  // `ref.app` is mutable so an app reload can swap in a fresh sandbox WITHOUT
  // rebuilding the extension (its onStorageChange closure reads ref.app).
  const ref = { app };
  let pendingChanges = [];
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
    if (opts.flags.hiddenTabDelay) { pendingChanges.push(changes); return; }
    deliverChange(changes);
  };
  const flushHidden = () => { const q = pendingChanges; pendingChanges = []; q.forEach(deliverChange); };

  const ext = makeExtensionSandbox(leagueId, storageBacking, onStorageChange);
  // Push the entire current storage backing into ref.app as a full re-sync
  // (mirrors ud-bridge pushAll(true) on a fresh app load).
  const fullResync = () => {
    const changes = {};
    for (const k of Object.keys(storageBacking)) changes[k] = { oldValue: undefined, newValue: storageBacking[k] };
    if (Object.keys(changes).length) deliverChange(changes);
  };
  return { ext, ref, deliverChange, flushHidden, onStorageChange, fullResync };
}

// --------------------------------------------------------------------------
// KNOWN, CONFIRMED app bugs the simulator surfaces but does NOT hard-fail on
// (per the work order: document real bugs, don't patch app code). Each entry is
// a violation matcher + a human description with repro. Matching errors are
// counted and reported in the scorecard; everything else still fails the run.
// --------------------------------------------------------------------------
const KNOWN_BUGS = [
  // (empty — UNDO-RESALE-OWNER-LEAK was fixed 2026-07-04 in draft.js
  // _applyDraftFeed; if it ever regresses, this harness now HARD-FAILS.
  // Convention: new confirmed app bugs get an entry here ONLY until fixed.)
];
let knownHits = {};

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv);
  FAILURES = []; knownHits = {};
  const rng = mulberry32(opts.seed);
  const pool = buildPool(rng);
  const leagueId = 999123;   // a mock league id (NOT 1200) → test mode

  const script = generateDraftScript(opts.seed, opts, pool);

  // Build the app sandbox in TEST mode (feed mode test; league override set so
  // draftTestMode() is true → generic Team-N, $260, no keepers, full pool).
  let app = makeAppSandbox(pool, leagueId);
  app.setFeedMode("test");

  // The persistent extension chrome.storage backing (survives extension reload).
  let storageBacking = {};
  let runner = makeDraftRunner(leagueId, pool, app, opts, storageBacking);

  // Counters for the scorecard.
  let stats = { lots: 0, events: 0, invariantChecks: 0, appReloads: 0, extReloads: 0, initFrames: 0 };

  // Running sales-so-far, used to encode reconnect INIT frames.
  const salesSoFar = [];
  const salesByPlayer = new Map();   // playerId → latest sale (for INIT + final ground truth)

  // Rebuild the app sandbox from serialized state (appReload).
  function reloadApp() {
    // Serialize what the app persists (localStorage keys) and rebuild.
    const savedLive = app.localStore["ud_live_draft_v1"];
    const savedDlog = app.localStore["ud_draft_events_v1"];
    const savedMode = app.localStore["ud_feed_mode"];
    const savedOverride = app.localStore["ud_league_override"];
    const newApp = makeAppSandbox(pool, leagueId);
    if (savedLive !== undefined) newApp.localStore["ud_live_draft_v1"] = savedLive;
    if (savedDlog !== undefined) newApp.localStore["ud_draft_events_v1"] = savedDlog;
    if (savedMode !== undefined) newApp.localStore["ud_feed_mode"] = savedMode;
    if (savedOverride !== undefined) newApp.localStore["ud_league_override"] = savedOverride;
    // Re-load persisted state into the fresh engines (loadLiveDraft/_dlogLoad
    // run in the concat-program scope). setFeedMode restores test mode.
    newApp.call("loadLiveDraft(); _dlogLoad();");
    newApp.setFeedMode(savedMode || "test");
    app = newApp;
    // Swap the mutable app ref so the (unchanged) extension keeps delivering to
    // the new sandbox, then replay the full extension state (ud-bridge pushAll).
    runner.ref.app = newApp;
    runner.fullResync();
    stats.appReloads++;
  }

  // Rebuild the extension sandbox from chrome.storage backing (extensionReload):
  // asserts the nextSeq bump (draft-bridge adds 100 on restore) and continuity.
  function reloadExtension() {
    runner.ext.pagehide();                 // flush the last 700ms
    const seqBefore = storageBacking.udDraftEvents ? storageBacking.udDraftEvents.nextSeq : null;
    // Rebuild the ESPN-tab bridge from the SAME persistent backing.
    runner.ext = makeExtensionSandbox(leagueId, storageBacking, runner.onStorageChange);
    stats.extReloads++;
    // The restored elog should have bumped nextSeq by 100 (no seq reuse).
    if (seqBefore != null && storageBacking.udDraftEvents) {
      const seqAfter = storageBacking.udDraftEvents.nextSeq;
      assert(seqAfter >= seqBefore, "extensionReload: nextSeq must not regress (" + seqBefore + " → " + seqAfter + ")");
    }
  }

  // Run one invariant check against the app; assert zero error-severity EXCEPT
  // for errors matching a documented, confirmed app bug (see KNOWN_BUGS). Those
  // are recorded and surfaced in the scorecard so the harness can still gate all
  // OTHER regressions (exit 0) while loudly flagging the real bug for the fixer.
  function checkInvariants(where) {
    const res = app.call("checkDraftInvariants()");
    stats.invariantChecks++;
    const errs = res.violations.filter(x => x.severity === "error");
    const unexpected = [];
    for (const e of errs) {
      const kb = KNOWN_BUGS.find(k => k.match(e));
      if (kb) { knownHits[kb.id] = (knownHits[kb.id] || 0) + 1; }
      else unexpected.push(e);
    }
    if (unexpected.length) {
      assert(false, "invariant errors at " + where + ": " +
        unexpected.slice(0, 4).map(e => e.id + " — " + e.detail).join(" | "));
    }
    return res;
  }

  // _applyDraftFeed (the pick pipeline) is async — it awaits _ensureEspnNames
  // before calling processEspnPicks. Draining the host microtask + macrotask
  // queues (which the vm shares) lets those pending .then() continuations run
  // before we read state. Called after every SOLD and before any reconcile.
  const drain = () => new Promise(res => setImmediate(res));

  // Drive the frame script.
  let lotCount = 0;
  for (let i = 0; i < script.frames.length; i++) {
    const fr = script.frames[i];

    // reconnectInit placeholder → real encoded INIT built from sales so far.
    if (fr.text === "__INIT__") {
      const initPicks = [...salesByPlayer.values()];
      const b64 = encodeInitB64(leagueId, initPicks);
      runner.ext.emitFrame("INIT " + b64);
      stats.initFrames++;
      advance(fr.advanceMs);
      if (opts.flags.hiddenTabDelay) runner.flushHidden();
      await drain();
      continue;
    }

    runner.ext.emitFrame(fr.text);
    stats.events++;
    advance(fr.advanceMs);

    // Track ground-truth sales as SOLD frames pass (for INIT + final compare).
    if (fr.tag === "sold" || fr.tag === "resold") {
      const parts = fr.text.split(/\s+/);
      const teamId = +parts[1], playerId = +parts[2], seq = +parts[3], price = +parts[4];
      salesByPlayer.set(playerId, { playerId, teamId, price, seq });
    }

    if (opts.flags.hiddenTabDelay) runner.flushHidden();
    await drain();

    // After every sold lot: run invariants; maybe trigger a reload.
    if (fr.tag === "sold" || fr.tag === "resold") {
      lotCount++;
      checkInvariants("lot " + lotCount);

      // appReload at ~1/3 through.
      if (opts.flags.appReload && lotCount === Math.floor(script.nLots / 3)) {
        reloadApp();
        checkInvariants("after appReload");
      }
      // extensionReload at ~2/3 through.
      if (opts.flags.extensionReload && lotCount === Math.floor(script.nLots * 2 / 3)) {
        reloadExtension();
        checkInvariants("after extReload");
      }
    }
  }
  stats.lots = lotCount;
  await drain();

  // ---- Final ground-truth reconciliation (draft 1) ----
  // The app's held picks must match the latest sale per player (undos replaced).
  reconcile(app, salesByPlayer, "draft-1");

  // ---- sameLeagueSecondDraft: after 90 simulated minutes, a NEW draft on the
  // same leagueId. Assert rotation (fresh startedAt) + draft-2 picks captured.
  if (opts.flags.sameLeagueSecondDraft) {
    advance(90 * 60 * 1000);
    // A fresh draft room: the INIT on reconnect has FAR fewer picks than stored
    // (draft-1 had 60) AND the stored feed is >60min old → draft-bridge fires
    // rotateDraft(). The INIT must be NON-EMPTY (a truly empty payload is
    // treated as "no INIT" — d.initB64 falsy), so we seed it with the first
    // couple of draft-2 sales, which is what a reconnect into an in-progress
    // fresh draft actually carries.
    const script2 = generateDraftScript(opts.seed + 1, { full: false, flags: {} }, pool);
    const d2Sold = script2.frames
      .filter(f => f.tag === "sold" || f.tag === "resold")
      .map(f => { const p = f.text.split(/\s+/); return { teamId: +p[1], playerId: +p[2], seq: +p[3], price: +p[4] }; });
    const initSeed = d2Sold.slice(0, 2);   // 2 « 60/2 → rotation trips

    const startedAtBefore = storageBacking.udDraftEvents ? storageBacking.udDraftEvents.startedAt : 0;
    runner.ext.emitFrame("INIT " + encodeInitB64(leagueId, initSeed));
    stats.initFrames++;
    advance(1000);
    if (opts.flags.hiddenTabDelay) runner.flushHidden();
    await drain();

    const sales2 = new Map();
    let lot2 = 0;
    for (const fr of script2.frames) {
      if (fr.text === "__INIT__") continue;
      runner.ext.emitFrame(fr.text);
      stats.events++;
      advance(fr.advanceMs);
      if (opts.flags.hiddenTabDelay) runner.flushHidden();
      await drain();
      if (fr.tag === "sold" || fr.tag === "resold") {
        const parts = fr.text.split(/\s+/);
        sales2.set(+parts[2], { playerId: +parts[2], teamId: +parts[1], price: +parts[4], seq: +parts[3] });
        lot2++;
        checkInvariants("draft-2 lot " + lot2);
      }
    }
    const startedAtAfter = storageBacking.udDraftEvents ? storageBacking.udDraftEvents.startedAt : 0;
    assert(startedAtAfter > startedAtBefore, "sameLeagueSecondDraft: startedAt must rotate (" + startedAtBefore + " → " + startedAtAfter + ")");
    // draft-2 sales must all be captured (merged onto whatever draft-1 left —
    // rotation clears feed.seen so repeats are re-recorded).
    const heldIds = new Set(app.picks().map(p => p.espnPlayerId));
    let captured2 = 0;
    for (const pid of sales2.keys()) if (heldIds.has(pid)) captured2++;
    assert(captured2 === sales2.size, "sameLeagueSecondDraft: only " + captured2 + "/" + sales2.size + " draft-2 picks captured");
    stats.lots += lot2;
  }

  // ---- Scorecard ----
  const activeFlags = Object.keys(opts.flags).filter(f => opts.flags[f]);
  const finalInv = app.call("checkDraftInvariants()");
  // Split final errors into known-bug vs unexpected (known ones don't fail).
  const finalErrs = finalInv.violations.filter(x => x.severity === "error");
  const finalKnown = finalErrs.filter(e => KNOWN_BUGS.some(k => k.match(e)));
  const finalUnexpected = finalErrs.filter(e => !KNOWN_BUGS.some(k => k.match(e)));
  const knownList = Object.keys(knownHits);
  const scorecard = [
    "──────────────────────────────────────────────────────",
    " Ultimate Draft — chaos simulator scorecard",
    "──────────────────────────────────────────────────────",
    " seed:              " + opts.seed + (opts.full ? "  (--full)" : ""),
    " chaos flags:       " + (activeFlags.length ? activeFlags.join(", ") : "(none)"),
    " lots (sold):       " + stats.lots,
    " picks held (app):  " + app.picks().length,
    " frames emitted:    " + stats.events,
    " INIT frames:       " + stats.initFrames,
    " events logged:     " + app.call("_dlog.events.length"),
    " invariant checks:  " + stats.invariantChecks,
    " final violations:  " + finalUnexpected.length + " unexpected err, " +
      finalKnown.length + " known-bug err, " + finalInv.counts.warn + " warn",
    " app reloads:       " + stats.appReloads,
    " extension reloads: " + stats.extReloads,
    " known-bug hits:    " + (knownList.length ? knownList.map(id => id + "×" + knownHits[id]).join(", ") : "(none)"),
    " assertion failures:" + FAILURES.length,
    "──────────────────────────────────────────────────────",
  ].join("\n");
  console.error(scorecard);

  if (knownList.length) {
    console.error("\n⚠ KNOWN APP BUGS surfaced (documented, NOT patched by this harness):");
    for (const id of knownList) {
      const kb = KNOWN_BUGS.find(k => k.id === id);
      console.error("  • [" + id + "] hit " + knownHits[id] + "×");
      if (kb) console.error("    " + kb.desc);
    }
  }

  if (FAILURES.length) {
    console.error("\nFAILURES (" + FAILURES.length + "):");
    FAILURES.slice(0, 20).forEach((f, i) => console.error("  " + (i + 1) + ". " + f));
    process.exit(1);
  }
  console.error("\nPASS — all invariants held (bar documented known bugs), final pick list matches ground truth.");
  process.exit(0);
}

// Compare the app's held picks against ground-truth sales (latest per player).
function reconcile(app, salesByPlayer, label) {
  const held = app.picks();
  const heldById = new Map(held.filter(p => p.espnPlayerId != null).map(p => [p.espnPlayerId, p]));

  // Every expected sale must be present with matching team + price.
  for (const [pid, sale] of salesByPlayer) {
    const pk = heldById.get(pid);
    if (!pk) { assert(false, label + ": missing pick for playerId " + pid + " (expected $" + sale.price + ")"); continue; }
    // In test mode team is "espn:N"; compare via espnTeamId.
    if (pk.espnTeamId !== sale.teamId) assert(false, label + ": playerId " + pid + " team " + pk.espnTeamId + " != expected " + sale.teamId);
    if (pk.price !== sale.price) assert(false, label + ": playerId " + pid + " price $" + pk.price + " != expected $" + sale.price);
  }
  // No EXTRA held picks beyond the expected sales (dup/ghost guard).
  for (const pk of held) {
    if (pk.espnPlayerId == null) continue;
    if (!salesByPlayer.has(pk.espnPlayerId)) assert(false, label + ": unexpected held pick playerId " + pk.espnPlayerId + " ($" + pk.price + ")");
  }
  // Count match.
  if (heldById.size !== salesByPlayer.size) {
    assert(false, label + ": held " + heldById.size + " picks != expected " + salesByPlayer.size);
  }
}

main().catch(err => { console.error("simulator crashed:", err && err.stack || err); process.exit(3); });
