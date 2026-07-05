// UD-native mock → Live Draft feed — headless end-to-end test.
//
// Loads the REAL engine files (inflation, mock-engine, endgame, draft-mode,
// draft, invariants, ai-assistant, mock-live-feed) into one vm sandbox — the
// browser's single shared scope — with a SEEDED Math.random (deterministic) and
// a controllable clock. Then it:
//   1. builds a full mock feed script (buildMockFeedScript) and asserts the
//      cadence sampler stays inside the spec's measured distributions;
//   2. drives every frame through the REAL pipeline (_onDraftEvents /
//      _applyDraftFeed → processEspnPicks), draining async between frames;
//   3. asserts zero error-severity invariant violations after every lot;
//   4. asserts the final held picks match the engine's ground-truth sales;
//   5. asserts Supabase logging ran as is_mock=true and the stream key rotated.
//
// Standalone (own sandbox) so it never interleaves with app-engines.test.js's
// async suite. Zero npm deps; uses test/helpers.js for the runner + assertions.

const fs = require("fs");
const vm = require("vm");
const path = require("path");
const { test, assert, assertEq, summary } = require("./helpers");

const APP = path.resolve(__dirname, "..");

// --- deterministic PRNG (mulberry32) --------------------------------------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- controllable clock shared with the sandbox ---------------------------
let CLOCK = 1_700_000_000_000;
const nowFn = () => CLOCK;
const advance = (ms) => { CLOCK += ms; };

// --- synthetic player pool with real positional variety -------------------
function buildPool() {
  // Enough per position to fill twelve 26-man rosters (1C/1×1B/1×2B/1SS/1×3B/
  // 5OF/6SP/4RP starters + MI/CI/UTIL/bench). Values descend from stars to $1.
  const plan = [
    ["C", 20], ["1B", 20], ["2B", 20], ["SS", 20], ["3B", 20],
    ["OF", 80], ["SP", 95], ["RP", 55],
  ];
  const types = { C: "H", "1B": "H", "2B": "H", SS: "H", "3B": "H", OF: "H", SP: "P", RP: "P" };
  const slots = [];
  for (const [pos, n] of plan) for (let i = 0; i < n; i++) slots.push(pos);
  // Interleave positions so stars spread across positions, then value by index.
  slots.sort((a, b) => a.localeCompare(b));   // stable, deterministic
  const total = slots.length;
  const players = [];
  for (let i = 0; i < total; i++) {
    const pos = slots[i];
    // Steep curve → a handful of stars and a long $1 tail, like a real auction
    // (most roster/bench spots clear at $1). This is what makes bids/lot bimodal
    // with a median of ~1 (cheap lots take one bid; star wars take many).
    const value = Math.max(1, Math.round(60 * Math.pow(1 - i / total, 4)));
    players.push({ name: "Player " + (100000 + i), posKey: pos, type: types[pos], value, elig: [pos] });
  }
  players.sort((a, b) => b.value - a.value);   // value-descending pool
  return players;
}

// --- sandbox that loads the real engines ----------------------------------
function makeSandbox(seed) {
  const seededRandom = mulberry32(seed);
  const M = Object.create(Math);        // inherits sqrt/log/cos/floor/min/max/PI…
  M.random = seededRandom;

  const pool = buildPool();
  const localStore = {};
  const winListeners = [];
  const logCalls = [];

  const sandbox = {};
  sandbox.console = { log() {}, error() {}, warn() {} };
  sandbox.Date = { now: nowFn };
  sandbox.Math = M;
  sandbox.JSON = JSON; sandbox.Set = Set; sandbox.Map = Map;
  sandbox.Array = Array; sandbox.Object = Object; sandbox.Number = Number; sandbox.String = String;
  sandbox.Boolean = Boolean; sandbox.RegExp = RegExp; sandbox.isFinite = isFinite;
  sandbox.parseInt = parseInt; sandbox.parseFloat = parseFloat; sandbox.isNaN = isNaN;
  sandbox.setTimeout = () => 0; sandbox.clearTimeout = () => {};
  sandbox.setInterval = () => 0; sandbox.clearInterval = () => {};
  sandbox.alert = () => {};
  sandbox.__confirmYes = false;
  sandbox.confirm = () => !!sandbox.__confirmYes;
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

  // Data-layer stubs the engines reference.
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
  sandbox.logDraftEvents = (meta, events, isMock) => { logCalls.push({ isMock, n: (events || []).length }); };
  sandbox.draftLogStatus = () => ({ sessionId: null, pending: 0, uploadedSeq: 0, isMock: true });
  sandbox.recordInflationSnapshot = () => {};
  sandbox.ensureRotowireNews = () => {};
  sandbox.fetchEspnPlayers = null;

  const ESPN_TEAM_ID_MAP = { 1: "matt", 2: "saxton", 3: "sam", 4: "glix", 5: "jeff", 6: "aj", 7: "corey", 8: "jd", 9: "wein", 10: "klin", 11: "dave", 12: "jtl" };
  sandbox.espnTeamIdToOwnerId = (id) => ESPN_TEAM_ID_MAP[id] || null;
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
    "js/features/endgame.js",
    "js/features/draft-mode.js",
    "js/features/draft.js",
    "js/core/invariants.js",
    "js/features/ai-assistant.js",
    "js/features/mock-live-feed.js",
  ];
  let program = files.map(rel => "\n//==== " + rel + " ====\n" + fs.readFileSync(path.join(APP, rel), "utf8")).join("\n");
  // Splice the real processEspnPicks (avoids loading espn.js's proxy/fetch globals).
  program += "\n//==== spliced processEspnPicks ====\n" + extractFunction(fs.readFileSync(path.join(APP, "js/data/espn.js"), "utf8"), "processEspnPicks");
  program += "\nglobalThis.__ud = {" +
    " get liveDraft(){return _liveDraft;}," +
    " get dlog(){return _dlog;}," +
    " checkDraftInvariants: (typeof checkDraftInvariants==='function'?checkDraftInvariants:null)," +
    " buildMockFeedScript: (typeof buildMockFeedScript==='function'?buildMockFeedScript:null)," +
    " getMyDraftEspnId: (typeof getMyDraftEspnId==='function'?getMyDraftEspnId:null)," +
    " arm: function(s){ _mfArm(s); return _mockFeed.ctx; }," +
    " applyFrame: function(ctx, fr, adv){ if (adv) adv(fr.dt||0); return _mfApplyFrame(ctx, fr, globalThis.Date.now()); }," +
    " eval: function(code){ return eval(code); }" +
    "};\n";
  vm.runInContext(program, sandbox, { filename: "ud-mock-concat.js" });

  return { sandbox, ud: sandbox.__ud, logCalls };
}

function extractFunction(src, name) {
  const start = src.indexOf("function " + name);
  if (start < 0) throw new Error("extractFunction: " + name + " not found");
  const braceOpen = src.indexOf("{", start);
  let depth = 0, i = braceOpen;
  for (; i < src.length; i++) { const c = src[i]; if (c === "{") depth++; else if (c === "}") { depth--; if (depth === 0) { i++; break; } } }
  return src.slice(start, i);
}

// --- percentile helper -----------------------------------------------------
function pct(arr, q) {
  if (!arr.length) return 0;
  const a = arr.slice().sort((x, y) => x - y);
  const idx = (a.length - 1) * q, lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (idx - lo);
}
const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const drain = () => new Promise(res => setImmediate(res));

// ===========================================================================
async function run() {
  CLOCK = 1_700_000_000_000;
  const { sandbox, ud, logCalls } = makeSandbox(7);

  // Build the full feed script (deterministic under the seeded RNG).
  const script = ud.buildMockFeedScript({});
  assert(script && script.frames.length > 50, "script should have many frames");

  // --- per-lot decomposition for cadence assertions ---------------------
  const lots = [];   // { nomAt, soldAt, bidCount, bids:[amounts], interBids:[dt] }
  const betweenLots = [];
  let cur = null, clock = 0;
  for (const fr of script.frames) {
    clock += fr.dt;
    if (fr.cmd === "NOMINATION") {
      if (fr.dt > 0) betweenLots.push(fr.dt);
      cur = { nomAt: clock, soldAt: clock, bidCount: 0, bids: [], interBids: [] };
      lots.push(cur);
    } else if (fr.cmd === "BID" && cur) {
      cur.bidCount++;
      cur.bids.push(fr.amount);
      if (cur.bidCount > 1) cur.interBids.push(fr.dt);   // skip the fixed opening gap
    } else if (fr.cmd === "SOLD" && cur) {
      cur.soldAt = clock;
    }
  }

  test("script produces a full auction (>150 lots) with matching sales", () => {
    assert(lots.length > 150, "expected >150 lots, got " + lots.length);
    assertEq(script.totalLots, script.sales.length, "totalLots == sales.length");
    assertEq(lots.length, script.sales.length, "one lot per sale");
  });

  test("cadence: bids/lot bimodal — median ~1, mean in [3,10]", () => {
    const counts = lots.map(l => l.bidCount);
    const med = pct(counts, 0.5), mn = mean(counts), p95 = pct(counts, 0.95);
    assert(med >= 1 && med <= 4, "median bids/lot " + med + " not in [1,4]");
    assert(mn >= 3 && mn <= 10, "mean bids/lot " + mn.toFixed(2) + " not in [3,10]");
    assert(p95 <= 30, "p95 bids/lot " + p95 + " > 30");
  });

  test("cadence: increments median $1, mean in [2,3.4], p90 in [4,9]", () => {
    const incs = [];
    for (const l of lots) for (let i = 1; i < l.bids.length; i++) { const d = l.bids[i] - l.bids[i - 1]; if (d > 0) incs.push(d); }
    assert(incs.length > 100, "need enough increments to measure");
    assertEq(pct(incs, 0.5), 1, "median increment should be $1");
    const mn = mean(incs), p90 = pct(incs, 0.9);
    assert(mn >= 2 && mn <= 3.4, "mean increment " + mn.toFixed(2) + " not in [2,3.4]");
    assert(p90 >= 4 && p90 <= 9, "p90 increment " + p90 + " not in [4,9]");
  });

  test("cadence: inter-bid median in [0.25,1.1]s, p95 in [2.5,7]s", () => {
    const gaps = [];
    for (const l of lots) for (const g of l.interBids) gaps.push(g / 1000);
    assert(gaps.length > 100, "need enough inter-bid gaps");
    const med = pct(gaps, 0.5), p95 = pct(gaps, 0.95);
    assert(med >= 0.25 && med <= 1.1, "median inter-bid " + med.toFixed(2) + "s not in [0.25,1.1]");
    assert(p95 >= 2.5 && p95 <= 7, "p95 inter-bid " + p95.toFixed(2) + "s not in [2.5,7]");
  });

  test("cadence: lot duration median ~25s (p95 <= 33s), between-lots ~2s", () => {
    const durs = lots.map(l => (l.soldAt - l.nomAt) / 1000);
    const med = pct(durs, 0.5), p95 = pct(durs, 0.95);
    assert(med >= 24 && med <= 27, "median lot duration " + med.toFixed(2) + "s not ~25");
    assert(p95 <= 33, "p95 lot duration " + p95.toFixed(2) + "s > 33");
    const bl = mean(betweenLots) / 1000;
    assert(bl >= 1.5 && bl <= 3, "between-lots mean " + bl.toFixed(2) + "s not ~2");
  });

  // --- drive every frame through the REAL pipeline ----------------------
  const ctx = ud.arm(script);
  let maxErr = 0, firstErr = null, invChecks = 0;

  for (const fr of script.frames) {
    ud.applyFrame(ctx, fr, advance);
    await drain();   // let _applyDraftFeed's await resolve before we inspect
    if (fr.cmd === "SOLD") {
      const r = ud.checkDraftInvariants();
      invChecks++;
      const errs = r.violations.filter(v => v.severity === "error");
      if (errs.length > maxErr) { maxErr = errs.length; }
      if (errs.length && !firstErr) firstErr = errs[0].id + " — " + errs[0].detail;
    }
  }
  await drain();

  test("my seat was announced (setMyDraftEspnId)", () => {
    assertEq(ud.getMyDraftEspnId(), script.myEspnId, "getMyDraftEspnId should equal script.myEspnId");
  });

  test("invariants: zero error-severity violations across every lot", () => {
    assert(invChecks > 150, "should have checked invariants each lot (" + invChecks + ")");
    assertEq(maxErr, 0, "invariant errors found" + (firstErr ? ": " + firstErr : ""));
  });

  test("final held picks match the engine's ground-truth sales", () => {
    const held = ud.liveDraft.picks;
    const byPid = new Map(held.filter(p => p.espnPlayerId != null).map(p => [p.espnPlayerId, p]));
    assertEq(byPid.size, script.sales.length, "held pick count == sales count");
    for (const sale of script.sales) {
      const pk = byPid.get(sale.playerId);
      assert(pk, "missing pick for playerId " + sale.playerId);
      assertEq(pk.espnTeamId, sale.teamId, "playerId " + sale.playerId + " team");
      assertEq(pk.price, sale.price, "playerId " + sale.playerId + " price");
      assert(typeof pk.team === "string" && pk.team.indexOf("espn:") === 0, "pick.team must be espn:N in test mode, got " + pk.team);
    }
  });

  test("every pick resolved to a pool player name (no unresolved ghosts)", () => {
    for (const pk of ud.liveDraft.picks) {
      // A resolved pick carries a pool name; an unresolved one would be
      // "Player <9xxxxx>" (the synthetic ESPN id). None should slip through.
      assert(!/^Player 9\d{5}$/.test(pk.player || ""), "unresolved synthetic id name: " + pk.player);
      assert(sandbox.getPlayerValue(pk.player) != null, "pick name not in value pool: " + pk.player);
    }
  });

  test("stream key rotated to the synthetic mock league", () => {
    assertEq(ud.liveDraft.streamKey, script.leagueId + ":" + script.startedAt, "streamKey = leagueId:startedAt");
  });

  test("all events logged to Supabase as is_mock=true", () => {
    assert(logCalls.length > 0, "logDraftEvents should have been called");
    assert(logCalls.every(c => c.isMock === true), "every log call must be is_mock=true");
    const logged = logCalls.reduce((s, c) => s + c.n, 0);
    assertEq(logged, script.frames.length, "logged event count == frames emitted");
    assertEq(ud.dlog.events.length, script.frames.length, "_dlog holds every event");
  });

  // --- fast-forward / skip controls -------------------------------------
  // startMockFeed arms + activates but schedules via setTimeout (a no-op in the
  // sandbox), so nothing auto-plays — we drive the skips explicitly and drain.
  ud.eval("startMockFeed()");
  const ffTotal = ud.eval("_mockFeed.script.totalLots");

  const soldAtStart = ud.eval("_mockFeed.soldLots");
  ud.eval("skipMockNomination()");
  await drain();
  test("skip nomination advances exactly one lot", () => {
    assertEq(soldAtStart, 0, "fresh mock starts at 0 sold");
    assertEq(ud.eval("_mockFeed.soldLots"), 1, "one lot resolved");
    assertEq(ud.liveDraft.picks.length, 1, "one pick recorded");
    assertEq(ud.checkDraftInvariants().counts.error, 0, "invariants clean after skip-lot");
  });

  ud.eval("skipMockPicks(5)");
  await drain();
  test("skip N picks advances N lots", () => {
    assertEq(ud.eval("_mockFeed.soldLots"), 6, "1 + 5 lots resolved");
    assertEq(ud.liveDraft.picks.length, 6, "six picks recorded");
    assertEq(ud.checkDraftInvariants().counts.error, 0, "invariants clean after skip-N");
  });

  ud.eval("skipMockToEnd()");
  await drain();
  test("skip to end completes the draft with clean invariants", () => {
    assertEq(ud.eval("_mockFeed.active"), false, "mock is finished (inactive)");
    assertEq(ud.eval("_mockFeed.soldLots"), ffTotal, "every lot resolved");
    assertEq(ud.liveDraft.picks.filter(p => p.espnPlayerId != null).length, ffTotal, "held picks == total lots");
    assertEq(ud.checkDraftInvariants().counts.error, 0, "zero invariant errors at the end");
  });

  // === Review-round regression tests (adversarial review, 2026-07-05) =========

  // #1 CRITICAL — starting a mock must never silently wipe real/manual picks.
  ud.eval("setLeagueOverride('990001'); setFeedMode('test'); _liveDraft.deleted={}; _liveDraft.streamKey=null; _liveDraft.picks=[{player:'Real Guy', team:'jeff', price:20, ts:1}];");
  sandbox.__confirmYes = false;
  const startedDenied = ud.eval("startMockFeed()");
  test("#1 startMockFeed refuses to wipe real picks when the user cancels", () => {
    assertEq(startedDenied, false, "returns false when confirm denied");
    assertEq(ud.liveDraft.picks.length, 1, "the real pick is preserved");
    assertEq(ud.liveDraft.picks[0].player, "Real Guy", "real pick untouched");
  });
  sandbox.__confirmYes = true;
  ud.eval("startMockFeed()");
  test("#1 startMockFeed proceeds only after explicit confirmation", () => {
    assert(ud.liveDraft.picks.every(p => typeof p.team === "string" && p.team.indexOf("espn:") === 0),
      "after confirm, only mock (espn:N) picks remain — no real pick survived");
  });
  ud.eval("stopMockFeed({silent:true})");

  // #1 UI defense — the Start button is hidden in Real mode (the real-draft
  // cockpit renders this control too; a misclick must be impossible).
  test("#1 renderMockFeedControls hides Start in Real mode, shows it in Test", () => {
    ud.eval("setLeagueOverride('990001'); setFeedMode('test');");
    const test = ud.eval("renderMockFeedControls(false)");
    assert(test.indexOf('data-mockfeed="start"') >= 0, "Start shown in Test mode");
    assert(test.indexOf("mf-skip-n") < 0, "no free-type skip input (focus-safe presets)");
    ud.eval("setLeagueOverride(''); setFeedMode('real');");
    const real = ud.eval("renderMockFeedControls(false)");
    assertEq(real.indexOf('data-mockfeed="start"'), -1, "Start hidden in Real mode");
  });

  // #2 HIGH — a mock seeds _espnIdToName with synthetic ids + a flag; entering
  // Real mode must drop it so a same-session real draft fetches real names.
  ud.eval("setLeagueOverride('990001'); setFeedMode('test'); startMockFeed();");
  test("#2 a mock seeds a flagged synthetic name map", () => {
    assert(ud.eval("!!_espnIdToName && Object.keys(_espnIdToName).length > 0"), "names seeded");
    assertEq(ud.eval("_espnNamesAreMock"), true, "flagged mock-seeded");
  });
  ud.eval("stopMockFeed({silent:true}); setLeagueOverride(''); setFeedMode('real');");
  test("#2 entering Real mode clears the mock-seeded name map", () => {
    assertEq(ud.eval("_espnIdToName"), null, "_espnIdToName nulled on entering Real mode");
    assertEq(ud.eval("_espnNamesAreMock"), false, "flag cleared");
  });

  // #5 LOW — skip controls hidden while paused (a paused feed must not emit).
  ud.eval("setLeagueOverride('990001'); setFeedMode('test'); startMockFeed();");
  const skipRunning = ud.eval("_mfSkipControls(false)");
  ud.eval("pauseMockFeed()");
  const skipPaused = ud.eval("_mfSkipControls(false)");
  ud.eval("resumeMockFeed()");
  const skipResumed = ud.eval("_mfSkipControls(false)");
  ud.eval("stopMockFeed({silent:true})");
  test("#5 skip controls show while running, vanish while paused", () => {
    assert(skipRunning.indexOf('data-mockfeed="skipnom"') >= 0, "shown while running");
    assertEq(skipPaused, "", "hidden while paused");
    assert(skipResumed.length > 0, "return after resume");
  });

  // #3 HIGH (coverage) — exercise the REAL async name path draft.js runs for a
  // live ESPN feed: a pick recorded before names load is a "Player <id>"
  // placeholder, then a later successful fetch sweeps it to the real name.
  ud.eval(
    "_liveDraft.picks=[]; _liveDraft.deleted={}; _liveDraft.streamKey=null; " +
    "_espnIdToName=null; _espnNamesLoading=null; _espnNamesAreMock=false; " +
    "setLeagueOverride(''); setFeedMode('real'); " +
    "fetchEspnPlayers = async () => ({ players: [] }); " +   // first fetch: no names
    "_applyDraftFeed({ leagueId:1200, sport:'flb', startedAt: globalThis.Date.now(), updatedAt: globalThis.Date.now(), picks:[{playerId:33192, teamId:5, price:12, seq:1}] });"
  );
  await drain(); await drain();
  test("#3 real feed records a placeholder when names aren't loaded yet", () => {
    const pk = ud.liveDraft.picks.find(p => p.espnPlayerId === 33192);
    assert(pk, "pick recorded through the async pipeline");
    assertEq(pk.player, "Player 33192", "placeholder name before the real fetch resolves");
  });
  ud.eval(
    "_espnIdToName=null; _espnNamesLoading=null; " +
    "fetchEspnPlayers = async () => ({ players: [{ id:33192, fullName:'Real Guy' }] }); " +
    "_ensureEspnNames();"
  );
  await drain(); await drain();
  test("#3 a later successful fetch sweeps placeholders to real names", () => {
    const pk = ud.liveDraft.picks.find(p => p.espnPlayerId === 33192);
    assertEq(pk.player, "Real Guy", "placeholder swept to the real name");
  });

  // === Round 8 regression tests ==============================================

  // #6 HIGH — a manual pick the feed later attributes to another team must MOVE
  // to that team (team re-keyed), or its price double-counts → I-MONEY error.
  ud.eval(
    "setLeagueOverride('990001'); setFeedMode('test'); " +
    "_liveDraft.picks=[{player:'Player 100005', team:'espn:5', price:20, ts:1}]; _liveDraft.deleted={}; _liveDraft.streamKey=null; " +
    "_espnIdToName = Object.assign(_espnIdToName||{}, {990055:'Player 100005'}); " +
    "_applyDraftFeed({ leagueId:990001, sport:'flb', startedAt: globalThis.Date.now(), updatedAt: globalThis.Date.now(), picks:[{playerId:990055, teamId:8, price:25, seq:1}] });"
  );
  await drain(); await drain();
  test("#6 feed-upgraded manual pick moves to the feed's team (no double-count)", () => {
    const pk = ud.liveDraft.picks.find(p => p.espnPlayerId === 990055);
    assert(pk, "manual pick upgraded with the ESPN identity");
    assertEq(pk.espnTeamId, 8, "espnTeamId updated to the feed winner");
    assertEq(pk.team, "espn:8", "team re-keyed to match espnTeamId (was espn:5)");
    assertEq(ud.checkDraftInvariants().counts.error, 0, "no I-MONEY double-count");
  });

  // #7 MEDIUM — leaving Test mode must stop a running mock (else it keeps
  // emitting into an off/real feed behind a "Running" label).
  ud.eval("setLeagueOverride('990001'); setFeedMode('test'); _liveDraft.picks=[]; _liveDraft.deleted={}; _liveDraft.streamKey=null; startMockFeed();");
  const runningBefore = ud.eval("mockFeedActive()");
  ud.eval("setFeedMode('off')");
  const runningAfter = ud.eval("mockFeedActive()");
  test("#7 setFeedMode('off') stops a running mock", () => {
    assertEq(runningBefore, true, "mock is running");
    assertEq(runningAfter, false, "leaving Test mode stopped it");
  });

  // === Round 9 regression tests =============================================

  // #R9-1 HIGH — a mock must NEVER touch the synced real-draft key; switching to
  // Real reloads the real draft (never writes an empty list that would clobber
  // the cloud copy on every device).
  ud.eval(
    "setLeagueOverride(''); setFeedMode('real'); " +
    "_liveDraft.picks=[{player:'RealStar', team:'jeff', price:30, ts:1}]; _liveDraft.deleted={}; _liveDraft.streamKey='1200:1'; saveLiveDraft();"
  );
  const realKeyBefore = ud.eval("localStorage.getItem('ud_live_draft_v1')");
  sandbox.__confirmYes = true;                     // ok to clear the (real) picks for a mock
  ud.eval("startMockFeed()");
  ud.eval("skipMockPicks(3)");
  await drain();
  test("#R9-1 a running mock never writes the synced real-draft key", () => {
    assertEq(ud.eval("localStorage.getItem('ud_live_draft_v1')"), realKeyBefore, "ud_live_draft_v1 untouched by the mock");
    const mk = ud.eval("localStorage.getItem('ud_live_draft_mock_v1')");
    assert(mk && JSON.parse(mk).picks.length >= 3, "mock picks persist to the device-local mock key");
  });
  ud.eval("stopMockFeed({silent:true}); setLeagueOverride(''); setFeedMode('real');");
  await drain();
  test("#R9-1 switching to Real reloads the real draft (no empty-clobber)", () => {
    assertEq(ud.liveDraft.picks.length, 1, "real draft restored from its own key");
    assertEq(ud.liveDraft.picks[0].player, "RealStar", "the real pick is back");
    const rk = JSON.parse(ud.eval("localStorage.getItem('ud_live_draft_v1')"));
    assertEq(rk.picks.length, 1, "real key was never emptied");
  });

  summary("UD-native mock feed");
}

run().catch(err => { console.error("ud-mock test crashed:", err && err.stack || err); process.exit(1); });
