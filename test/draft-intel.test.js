// Draft-intelligence tests — category-aware recommended bid (marginal roto
// worth), nomination tells (live draft archaeology), the Squeeze/price-
// enforcement tactic, and the Draft-day readiness checks. Loads the REAL app
// files (single global namespace, same pattern as app-engines.test.js) with
// stubbed data globals; computeMockStandings/aggregateCats are focused copies
// of the real roto core (precedent: processEspnPicks in app-engines.test.js).

const fs = require("fs");
const {
  test, section, summary, assert, assertEq,
  makeLocalStorageStub,
} = require("./helpers.js");

const APP = "/Users/jwars/Desktop/Claude/ultimate-draft/js/";

// ---------------------------------------------------------------------------
// Fixtures: 12-team league, a value pool with stat projections engineered so
// my team is HR-rich and SB-poor (the category cue must tell them apart).
// ---------------------------------------------------------------------------
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

// Pool: two equal-$ stars with opposite shapes + balanced filler so the
// projected-fill allocator has depth. My picks (below) are HR-heavy, SB-zero.
const VALUES = [
  { name: "Speedy Gonzales", posKey: "OF", team: "AAA", type: "H", value: 20 },
  { name: "Big Bopper", posKey: "OF", team: "AAA", type: "H", value: 20 },
  { name: "Aaron Judge", posKey: "OF", team: "NYY", type: "H", value: 40 },
  { name: "Masher One", posKey: "1B", team: "AAA", type: "H", value: 18 },
  { name: "Masher Two", posKey: "3B", team: "AAA", type: "H", value: 17 },
  { name: "Masher Three", posKey: "OF", team: "AAA", type: "H", value: 16 },
  { name: "No Proj Guy", posKey: "2B", team: "AAA", type: "H", value: 15 },
];
for (let i = 1; i <= 20; i++) {
  VALUES.push({ name: "Balanced H" + i, posKey: ["C", "1B", "2B", "SS", "3B", "OF"][i % 6], team: "AAA", type: "H", value: Math.max(1, 12 - i) });
  VALUES.push({ name: "Balanced P" + i, posKey: i % 4 === 0 ? "RP" : "SP", team: "AAA", type: "P", value: Math.max(1, 11 - i) });
}
const VAL_BY_NAME = Object.fromEntries(VALUES.map((v) => [normalizePlayerName(v.name), v]));

const PROJ = {
  "Speedy Gonzales": { type: "H", R: 95, HR: 4, RBI: 40, SB: 55, OBP: 0.350 },
  "Big Bopper":      { type: "H", R: 85, HR: 42, RBI: 110, SB: 0, OBP: 0.350 },
  "Aaron Judge":     { type: "H", R: 110, HR: 50, RBI: 120, SB: 6, OBP: 0.410 },
  "Masher One":      { type: "H", R: 80, HR: 38, RBI: 100, SB: 1, OBP: 0.360 },
  "Masher Two":      { type: "H", R: 78, HR: 36, RBI: 95, SB: 1, OBP: 0.355 },
  "Masher Three":    { type: "H", R: 75, HR: 34, RBI: 90, SB: 2, OBP: 0.350 },
  // "No Proj Guy" deliberately absent.
};
for (let i = 1; i <= 20; i++) {
  PROJ["Balanced H" + i] = { type: "H", R: 60, HR: 15, RBI: 60, SB: 10, OBP: 0.330 };
  PROJ["Balanced P" + i] = { type: "P", QS: 12, K: 140, SV_HLD: i % 4 === 0 ? 20 : 2, IP: 150, ERA: 3.8, WHIP: 1.2 };
}

const KEEPER_SELECTIONS = {};   // keeper-free: budgets stay symmetric at $260

// Focused copy of category.js aggregateCats over the PROJ fixture (counting
// stats summed; OBP averaged over hitters; ERA/WHIP IP-blind means are fine
// for ranking symmetric fixtures).
function aggregateCatsFixture(names) {
  const t = { R: 0, HR: 0, RBI: 0, SB: 0, OBP: 0, QS: 0, K: 0, SV_HLD: 0, ERA: 0, WHIP: 0, IP: 0 };
  let h = 0, p = 0;
  for (const n of names) {
    const pr = PROJ[n];
    if (!pr) continue;
    if (pr.type === "H") { t.R += pr.R; t.HR += pr.HR; t.RBI += pr.RBI; t.SB += pr.SB; t.OBP += pr.OBP; h++; }
    else { t.QS += pr.QS; t.K += pr.K; t.SV_HLD += pr.SV_HLD; t.IP += pr.IP; t.ERA += pr.ERA; t.WHIP += pr.WHIP; p++; }
  }
  if (h) t.OBP /= h;
  if (p) { t.ERA /= p; t.WHIP /= p; }
  return t;
}

// Focused port of mock.js computeMockStandings (the real roto ranking core).
function computeMockStandingsFixture(states) {
  const cats = ["R", "HR", "RBI", "SB", "OBP", "QS", "K", "SV_HLD", "ERA", "WHIP"];
  const teams = Object.values(states).map(t => {
    const names = [...(t.kept || []).map(k => k.name), ...t.drafted.map(d => d.name)];
    const totals = aggregateCatsFixture(names);
    return { teamId: t.teamId, owner: t.ownerName, isMe: !!t.isMe, totals, catPoints: {}, rotoPoints: 0 };
  });
  const N = teams.length;
  const valOf = (t, c) => {
    const v = t.totals[c] || 0;
    if ((c === "ERA" || c === "WHIP") && (!t.totals.IP || v <= 0)) return Infinity;
    return v;
  };
  let anyData = false;
  for (const c of cats) {
    if (teams.some(t => { const v = valOf(t, c); return isFinite(v) && v > 0; })) anyData = true;
    const lower = (c === "ERA" || c === "WHIP");
    const order = teams.slice().sort((a, b) => lower ? valOf(a, c) - valOf(b, c) : valOf(b, c) - valOf(a, c));
    let i = 0;
    while (i < N) {
      let j = i; while (j + 1 < N && valOf(order[j + 1], c) === valOf(order[i], c)) j++;
      let sum = 0; for (let r = i; r <= j; r++) sum += (N - r);
      const avg = sum / (j - i + 1);
      for (let r = i; r <= j; r++) { order[r].catPoints[c] = avg; order[r].rotoPoints += avg; }
      i = j + 1;
    }
  }
  teams.sort((a, b) => b.rotoPoints - a.rotoPoints);
  teams.forEach((t, i) => t.rank = i + 1);
  return { teams, anyData, cats, N };
}

// ---------------------------------------------------------------------------
// Sandbox + real-file load (mirrors app-engines.test.js).
// ---------------------------------------------------------------------------
const ls = makeLocalStorageStub({});
const mkEl = () => ({ addEventListener() {}, appendChild() {}, click() {}, remove() {}, setAttribute() {}, getAttribute() { return null; }, style: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, dataset: {}, focus() {}, closest() { return null; }, querySelectorAll() { return []; }, querySelector() { return null; }, innerHTML: "", textContent: "", value: "", title: "", className: "" });
const doc = {
  addEventListener() {}, getElementById() { return mkEl(); }, querySelectorAll() { return []; },
  querySelector() { return null; }, createElement() { return mkEl(); },
  body: { classList: { add() {}, remove() {}, toggle() {} }, appendChild() {} }, activeElement: null,
};
const win = { addEventListener() {}, removeEventListener() {}, postMessage() {}, location: { origin: "https://jwarshafsky.github.io", pathname: "/", search: "" } };

const g = {
  window: win, document: doc, localStorage: ls, location: win.location,
  console: { log() {}, warn() {}, error() {} },
  setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  URL: { createObjectURL: () => "", revokeObjectURL: () => {} }, Blob: function () {}, Date,

  LEAGUE, UD_HOME_LEAGUE_ID: 1200,
  ESPN: { leagueId: 1200, proxyUrl: "https://proxy.example", proxyKey: "k" },
  VALUATION: { hitBudgetPct: 0.70 },
  getValues: () => VALUES,
  getPlayerValue: (name) => VAL_BY_NAME[normalizePlayerName(name)] || null,
  normalizePlayerName,
  esc: (s) => String(s),
  setStatus() {},
  currentView: "x",

  getMyTeam: () => LEAGUE.teams.find((t) => t.isMe) || null,
  getTeam: (id) => LEAGUE.teams.find((t) => t.id === id) || null,
  espnTeamIdToOwnerId: (espnId) => ESPN_TEAM_ID_MAP[espnId] || null,

  getKeeperSelections: () => KEEPER_SELECTIONS,
  getEffectiveKeeperSelections: () => KEEPER_SELECTIONS,
  getCurrentKeeperSalary: () => null,
  getLeagueContractByName: () => null,

  getNfbc: () => null,
  getStatcast: () => null,
  statcastBuySell: () => null,
  getDraftDollarAdjustment: () => 0,
  getProjection: (name) => PROJ[name] || null,
  getNote: () => null,
  getFlaggedPlayers: () => [],
  classifyPriceVsTargets: () => null,
  renderTagIcons: () => "", renderTargetBadge: () => "",
  ensureRotowireNews() {},
  fetchEspnPlayers: async () => ({ players: [] }),
  logDraftEvents() {},
  draftLogStatus: () => ({ sessionId: null, pending: 0 }),
  coreNameKey: (s) => normalizePlayerName(s),

  renderDraftSetup() {}, renderCategoryDashboard: () => "", renderAiAssistantPanel: () => "",
  wireAiPanel() {}, renderInflationCurve: () => "", renderSpendingPace: () => "",
  renderPlayerNewsBlock: () => "", wirePlayerNewsBlock() {}, renderInvariantsLine: () => "",
  openDebrief() {}, closeDebrief() {}, openNoteEditor() {}, recordInflationSnapshot() {},
  getMyRoster: () => [], projectTeamCategories: () => null,
  aggregateCats: aggregateCatsFixture,
  strategyForAi: () => null,
  computeMockStandings: computeMockStandingsFixture,

  // Readiness-card data stubs (overridden per test).
  activeProjSource: () => "steamer_ros",
  rosHasDollars: () => true,
  rosHasData: () => true,
  getRosSourceLabel: () => "Steamer ROS",
  _ros: { data: { steamer_ros: { updatedAt: new Date().toISOString() } } },
  getNfbcMeta: () => ({ source: "NFBC", importedAt: new Date().toISOString(), count: 500 }),
  getDraftStrategy: () => ({ text: "plan", brief: "the brief" }),
};
for (const k of Object.keys(g)) global[k] = g[k];

const files = [
  "data/budget-adjust.js",
  "data/owner-tendencies.js",
  "data/draft-cadence.js",
  "core/inflation.js",
  "core/invariants.js",
  "features/endgame.js",
  "features/nominations.js",
  "features/draft-setup.js",
  "features/draft.js",
  "features/draft-mode.js",
];
let bundle = files.map((f) => fs.readFileSync(APP + f, "utf8")).join("\n;\n");
bundle += "\n;globalThis._liveDraft=_liveDraft;globalThis._dlog=_dlog;globalThis._feed=_feed;"
        + "globalThis._dmCatAdjCache=_dmCatAdjCache;globalThis._dmTellsCache=_dmTellsCache;";
(0, eval)(bundle);

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
  // Bust the per-lot caches between tests.
  if (typeof global._dmCatAdjCache !== "undefined") { try { _dmCatAdjCache.key = null; } catch (e) {} }
  if (typeof global._dmTellsCache !== "undefined") { try { _dmTellsCache.key = null; } catch (e) {} }
}
function setRealMode() { ls.setItem("ud_feed_mode", "real"); ls.removeItem("ud_league_override"); }

// My HR-rich, SB-zero roster (3 picks).
function giveJeffMashers() {
  for (const n of ["Masher One", "Masher Two", "Masher Three"]) {
    global._liveDraft.picks.push({ player: n, pos: "OF", team: "jeff", price: 15, ts: 1, espnPlayerId: null });
  }
}

// =====================================================================
section("Category-aware recommended bid (categoryBidAdjustment)");
// =====================================================================

test("SB stud beats equal-$ HR stud in marginal roto points for an SB-poor roster", () => {
  setRealMode(); resetDraftState(); giveJeffMashers();
  const speedy = global.categoryBidAdjustment("Speedy Gonzales");
  global._dmCatAdjCache.key = null;   // different player, but bust to be safe
  const bopper = global.categoryBidAdjustment("Big Bopper");
  assert(speedy && bopper, "both computed (got " + JSON.stringify({ speedy, bopper }) + ")");
  assert(speedy.deltaPts > bopper.deltaPts, "SB stud adds more roto pts (" + speedy.deltaPts.toFixed(2) + " vs " + bopper.deltaPts.toFixed(2) + ")");
  assert(speedy.adj >= bopper.adj, "adjustment $ ordered with the points");
});

test("adjustment is clamped to ±$6 and carries a why/assumedPrice", () => {
  setRealMode(); resetDraftState(); giveJeffMashers();
  const a = global.categoryBidAdjustment("Speedy Gonzales");
  assert(a, "computed");
  assert(Math.abs(a.adj) <= 6, "clamped (got " + a.adj + ")");
  assert(a.assumedPrice >= 1, "assumed price sane");
});

test("recommendBid: walkEff = walk + adj (never above maxBid), stretchEff ≥ walkEff, base preserved", () => {
  setRealMode(); resetDraftState(); giveJeffMashers();
  const r = global.recommendBid("Speedy Gonzales");
  assert(r, "reco computed");
  assert(r.walk >= 1 && r.stretch >= r.walk, "base prices sane");
  assert(r.walkEff >= 1 && r.stretchEff >= r.walkEff, "effective prices coherent");
  if (r.catAdj && r.catAdj.adj) {
    const expected = Math.min(Math.max(1, r.walk + r.catAdj.adj), r.maxBid != null ? Math.max(1, r.maxBid) : Infinity);
    assertEq(r.walkEff, expected, "walkEff = clamp(walk + adj)");
  } else {
    assertEq(r.walkEff, r.walk, "no adjustment → walkEff = walk");
  }
  if (r.maxBid != null) assert(r.walkEff <= Math.max(1, r.maxBid) && r.stretchEff <= Math.max(1, r.maxBid), "capped by maxBid");
});

test("no stat projection → no category adjustment (catAdj null, walkEff = walk)", () => {
  setRealMode(); resetDraftState(); giveJeffMashers();
  assertEq(global.categoryBidAdjustment("No Proj Guy"), null, "null for projection-less player");
  const r = global.recommendBid("No Proj Guy");
  assertEq(r.catAdj, null, "reco carries no adjustment");
  assertEq(r.walkEff, r.walk, "walkEff = walk");
  assertEq(r.stretchEff, r.stretch, "stretchEff = stretch");
});

test("no seat → categoryBidAdjustment returns null", () => {
  setRealMode(); resetDraftState();
  const realGetMyTeam = global.getMyTeam;
  global.getMyTeam = () => null;
  try {
    assertEq(global.categoryBidAdjustment("Speedy Gonzales"), null, "null without a seat");
  } finally { global.getMyTeam = realGetMyTeam; }
});

test("cache: same state returns the same object; a new pick recomputes", () => {
  setRealMode(); resetDraftState(); giveJeffMashers();
  const a = global.categoryBidAdjustment("Speedy Gonzales");
  const b = global.categoryBidAdjustment("Speedy Gonzales");
  assert(a === b, "second call is the cached object");
  global._liveDraft.picks.push({ player: "Balanced H1", pos: "C", team: "matt", price: 5, ts: 2, espnPlayerId: null });
  const c = global.categoryBidAdjustment("Speedy Gonzales");
  assert(c !== a, "pick landed → recomputed");
});

test("computeLiveProjStandings(assume) reduces my money/slots and rosters the player", () => {
  setRealMode(); resetDraftState(); giveJeffMashers();
  const withMe = global.computeLiveProjStandings({ name: "Speedy Gonzales", price: 20 });
  assert(withMe && withMe.anyData, "counterfactual ran");
  const mine = withMe.teams.find(t => t.teamId === "jeff");
  assert(mine, "my team present");
  assert(mine.totals.SB >= 55, "assumed player's SB counted in my totals (got " + mine.totals.SB + ")");
});

// =====================================================================
section("Nomination tells (live draft archaeology)");
// =====================================================================

// Build one full lot in the event log. othersBid / nomRebids / winner control
// the tell signals. seqBase keeps seqs unique across lots.
let _seq = 0;
function pushLot(nomTeam, playerId, opts) {
  opts = opts || {};
  const evs = global._dlog.events;
  const at = Date.now();
  evs.push({ cmd: "NOMINATION", teamId: nomTeam, playerId, seq: ++_seq, at });
  if (opts.othersBid) evs.push({ cmd: "BID", teamId: opts.otherTeam || (nomTeam === 1 ? 2 : 1), playerId, amount: 2, seq: ++_seq, at });
  if (opts.nomRebids) evs.push({ cmd: "BID", teamId: nomTeam, playerId, amount: 3, seq: ++_seq, at });
  evs.push({ cmd: "SOLD", teamId: opts.winner != null ? opts.winner : (opts.otherTeam || 2), playerId, amount: opts.price || 3, seq: ++_seq, at });
}

test("chase counted only when the nominator re-engages after another bidder", () => {
  setRealMode(); resetDraftState();
  pushLot(1, 2001, { othersBid: true, nomRebids: true, winner: 2 });   // chased, lost
  pushLot(1, 2002, { othersBid: false, winner: 1, price: 1 });          // uncontested $1 own win — NOT a chase
  pushLot(1, 2003, { othersBid: true, nomRebids: false, winner: 2 });   // let it go — not a chase
  const t = global.nominationTells()[1];
  assertEq(t.noms, 3, "3 nominations");
  assertEq(t.chased, 1, "only the re-engaged lot counts");
  assertEq(t.ownWins, 0, "no contested own-wins");
});

test("contested own-win counts as chase + ownWin (even if his bids fell in an INIT gap)", () => {
  setRealMode(); resetDraftState();
  // Nominator 4 wins his own lot vs competition WITHOUT a logged re-bid.
  pushLot(4, 2010, { othersBid: true, nomRebids: false, winner: 4, price: 9 });
  const t = global.nominationTells()[4];
  assertEq(t.ownWins, 1, "own win against the field");
  assertEq(t.chased, 1, "implied chase");
});

test("INIT resets the open lot — no cross-gap misattribution", () => {
  setRealMode(); resetDraftState();
  const evs = global._dlog.events;
  evs.push({ cmd: "NOMINATION", teamId: 6, playerId: 2020, seq: ++_seq, at: Date.now() });
  evs.push({ cmd: "BID", teamId: 7, playerId: 2020, amount: 2, seq: ++_seq, at: Date.now() });
  evs.push({ cmd: "INIT", seq: ++_seq, at: Date.now() });
  evs.push({ cmd: "BID", teamId: 6, playerId: 2020, amount: 3, seq: ++_seq, at: Date.now() });   // post-gap — lot unknown
  const t = global.nominationTells()[6];
  assertEq(t.noms, 1, "nomination counted");
  assertEq(t.chased, 0, "post-INIT bid not attributed");
});

test("_dmTellLine fires only past thresholds (≥3 noms, ≥2 chases, ≥40%)", () => {
  setRealMode(); resetDraftState();
  pushLot(1, 2101, { othersBid: true, nomRebids: true, winner: 2 });
  pushLot(1, 2102, { othersBid: true, nomRebids: true, winner: 1, price: 8 });
  let line = global._dmTellLine({ nomTeamId: 1, playerId: 2102 });
  assertEq(line, "", "2 noms — below threshold");
  pushLot(1, 2103, { othersBid: true, nomRebids: false, winner: 2 });
  global._dmTellsCache.key = null;
  line = global._dmTellLine({ nomTeamId: 1, playerId: 2103 });
  assert(line.includes("Tell:") && line.includes("Matt"), "3 noms / 2 chased → tell line names the owner");
});

test("nominationTellsSummary flags a position hunt (3+ noms, ≥50% one position)", () => {
  setRealMode(); resetDraftState();
  // Seed id→name so nominated players resolve to pool SPs.
  global._seedMockEspnNames({ 3001: "Balanced P1", 3002: "Balanced P2", 3003: "Balanced P3", 3004: "Balanced H1" });
  pushLot(9, 3001, { othersBid: false, winner: 2 });
  pushLot(9, 3002, { othersBid: false, winner: 2 });
  pushLot(9, 3003, { othersBid: false, winner: 2 });
  pushLot(9, 3004, { othersBid: false, winner: 2 });
  const rows = global.nominationTellsSummary();
  const wein = rows.find(r => r.espnId === 9);
  assert(wein, "team 9 in the summary");
  assert(/hunting SP \(3\/4/.test(wein.note), "SP hunt read (got: " + (wein && wein.note) + ")");
});

// =====================================================================
section("Squeeze / price-enforcement tactic (_bidTactic)");
// =====================================================================

function mkLot(highTeamId, bids, name, playerId) {
  const at = Date.now();
  return {
    playerId: playerId || 4001, name: name || "Aaron Judge", nomTeamId: highTeamId,
    bids: bids.map(b => ({ teamId: b[0], amount: b[1], at })),
    highBid: bids.length ? Math.max(...bids.map(b => b[1])) : 1,
    highTeamId, lastAt: at, idle: false, idleMin: 0,
  };
}

test("squeeze suggested at/above walk vs a funded rival with active field", () => {
  setRealMode(); resetDraftState();
  const fair = global._dmFairValue("Aaron Judge");
  assert(fair && fair > 20, "fixture fair value sane");
  const lot = mkLot(1, [[2, 18], [3, 19], [1, 20]]);
  const r = { walk: 18, stretch: 20, walkEff: 18, stretchEff: 20, maxBid: 300 };
  const msg = global._bidTactic("Aaron Judge", 20, r, lot);
  assert(msg && msg.startsWith("Squeeze:"), "squeeze fires (got: " + msg + ")");
  const rivalMax = global.computeLiveTeamStates()["matt"].maxBid;
  const ceiling = Math.min(rivalMax - 1, Math.round(fair), 300);
  assert(msg.includes("$" + ceiling), "ceiling = min(rival max−1, fair, my max) — expected $" + ceiling + " in: " + msg);
  assert(/Risk (low|medium)/.test(msg), "risk quantified");
});

test("no other bidders → advises AGAINST enforcing", () => {
  setRealMode(); resetDraftState();
  const lot = mkLot(1, [[1, 20]]);   // only the high bidder has bid
  const r = { walk: 18, stretch: 20, walkEff: 18, stretchEff: 20, maxBid: 300 };
  const msg = global._bidTactic("Aaron Judge", 20, r, lot);
  assert(msg && msg.startsWith("Don't price-enforce"), "warns off (got: " + msg + ")");
});

test("no squeeze when the rival already pays fair, when I'm the high bidder, or without a lot", () => {
  setRealMode(); resetDraftState();
  const fair = Math.round(global._dmFairValue("Aaron Judge"));
  const r = { walk: 18, stretch: 20, walkEff: 18, stretchEff: 20, maxBid: 300 };
  assertEq(global._bidTactic("Aaron Judge", fair, { ...r, walkEff: Math.min(18, fair) }, mkLot(1, [[2, fair - 1], [1, fair]])), null, "at fair — nothing to enforce");
  assertEq(global._bidTactic("Aaron Judge", 20, r, mkLot(5, [[2, 19], [5, 20]])), null, "I'm high — no self-squeeze");
  assertEq(global._bidTactic("Aaron Judge", 20, r, null), null, "manual mode (no lot) — silent");
});

test("buying branch unchanged: round-number wall break below walk", () => {
  setRealMode(); resetDraftState();
  const r = { walk: 18, stretch: 20, walkEff: 18, stretchEff: 20, maxBid: 235 };
  const msg = global._bidTactic("Aaron Judge", 10, r, mkLot(1, [[1, 10]]));
  assert(msg && msg.includes("$11") && msg.includes("$10 wall"), "wall break (got: " + msg + ")");
});

// =====================================================================
section("Draft-day readiness (_dsReadinessChecks)");
// =====================================================================

test("all-green fixture → no blockers", () => {
  setRealMode(); resetDraftState();
  global._feed.extPresent = true;
  global._feed.tabAt = Date.now();
  global.ESPN.proxyKey = "k";   // the readiness check reads what espn.js sends
  const checks = global._dsReadinessChecks();
  const bad = checks.filter(c => c.level === "bad");
  assertEq(bad.length, 0, "no blockers (got: " + bad.map(c => c.label).join(", ") + ")");
  assert(checks.some(c => c.label.includes("Feed mode REAL")), "mode surfaced");
  assert(checks.some(c => c.label.includes("Keeper predictions")), "keeper check present in real mode");
});

test("missing proxy key and feed OFF are blockers", () => {
  resetDraftState();
  ls.setItem("ud_feed_mode", "off");
  global.ESPN.proxyKey = "";
  global._feed.extPresent = false;
  const checks = global._dsReadinessChecks();
  const bad = checks.filter(c => c.level === "bad").map(c => c.label);
  assert(bad.some(l => l.includes("Feed mode OFF")), "mode off flagged");
  assert(bad.some(l => l === "Proxy"), "proxy flagged");
  assert(bad.some(l => l.includes("extension")), "extension flagged");
});

test("no dollar source is a blocker; stale dollars only a warning", () => {
  setRealMode(); resetDraftState();
  global.ESPN.proxyKey = "k";
  global._feed.extPresent = true; global._feed.tabAt = Date.now();
  const realHasDollars = global.rosHasDollars;
  global.rosHasDollars = () => false;
  try {
    const bad = global._dsReadinessChecks().filter(c => c.level === "bad").map(c => c.label);
    assert(bad.some(l => l.includes("Dollar values")), "missing $ source is a blocker");
  } finally { global.rosHasDollars = realHasDollars; }
  const old = new Date(Date.now() - 30 * 86400000).toISOString();
  const realRos = global._ros;
  global._ros = { data: { steamer_ros: { updatedAt: old } } };
  try {
    const checks = global._dsReadinessChecks();
    const dollar = checks.find(c => c.label.includes("Dollar values"));
    assertEq(dollar.level, "warn", "30-day-old dollars warn, not block");
  } finally { global._ros = realRos; }
});

// =====================================================================
section("Keeper inflation override flows app-wide (flat + tiered)");
// =====================================================================

test("manual override anchors computeFlatInflation and the tiered distribution conserves it", () => {
  setRealMode(); resetDraftState();
  global._keeperInflationOverride = () => 1.30;
  try {
    const flat = global.computeFlatInflation();
    assert(flat, "flat inflation computed");
    assert(Math.abs(flat.multiplier - 1.30) < 1e-9, "flat multiplier = override (got " + flat.multiplier + ")");
    const tiered = global.computeTieredInflation();
    assert(tiered && tiered.mode === "tiered", "tiered computed");
    // The tiered split must distribute the OVERRIDDEN excess exactly.
    const excess = (flat.multiplier - 1) * flat.remainingValue;
    const distributed = Object.keys(tiered.tierValue)
      .reduce((s, k) => s + tiered.tierValue[k] * (tiered.tierMult[k] - 1), 0);
    assert(Math.abs(distributed - excess) < 0.01, "tier distribution conserves the override excess (" + distributed.toFixed(2) + " vs " + excess.toFixed(2) + ")");
  } finally { delete global._keeperInflationOverride; }
});

test("no override → pool-derived multiplier unchanged", () => {
  setRealMode(); resetDraftState();
  const flat = global.computeFlatInflation();
  assert(flat && isFinite(flat.multiplier), "flat computed without keepers.js loaded");
});

// =====================================================================
section("I-MONEY invariant — full roster with leftover cash");
// =====================================================================

test("full roster (slotsRemaining=0) with cash left reports maxBid=0 and is NOT an I-MONEY error", () => {
  setRealMode(); resetDraftState();
  // computeLiveTeamStates correctly reports maxBid=0 for a full roster; the
  // invariant must expect the same, not budget−(0−1).
  const realStates = global.computeLiveTeamStates;
  global.computeLiveTeamStates = () => ({
    jeff: { teamId: "jeff", ownerName: "Jeff", budget: 50, spent: 210, keptCost: 0, slotsRemaining: 0, maxBid: 0, posCounts: {} },
  });
  try {
    const r = global.checkDraftInvariants();
    const bad = r.violations.filter(v => v.id === "I-MONEY" && /maxBid/.test(v.detail));
    assertEq(bad.length, 0, "no maxBid false positive (got: " + bad.map(v => v.detail).join(" | ") + ")");
  } finally { global.computeLiveTeamStates = realStates; }
});

test("open-roster maxBid identity still enforced (regression guard)", () => {
  setRealMode(); resetDraftState();
  const realStates = global.computeLiveTeamStates;
  global.computeLiveTeamStates = () => ({
    jeff: { teamId: "jeff", ownerName: "Jeff", budget: 50, spent: 210, keptCost: 0, slotsRemaining: 5, maxBid: 99, posCounts: {} },
  });
  try {
    const r = global.checkDraftInvariants();
    const bad = r.violations.filter(v => v.id === "I-MONEY" && /maxBid/.test(v.detail));
    assertEq(bad.length, 1, "wrong maxBid on an open roster IS still flagged");
  } finally { global.computeLiveTeamStates = realStates; }
});

// =====================================================================
section("Tier-absorption shares (single-pie conservation)");
// =====================================================================

const RECO_W = { T1: 1.6, T2: 1.35, T3: 1.0, T4: 0.6, T5: 0.2 };

test("shares total exactly 100% (dollar basis, projections loaded)", () => {
  const r = global._dsTierShares(RECO_W);
  assertEq(r.basis, "dollar", "value pool present → dollar-weighted");
  const sum = ["T1", "T2", "T3", "T4", "T5"].reduce((a, t) => a + r.pct[t], 0);
  assertEq(sum, 100, "integer shares sum to 100 (got " + sum + ")");
});

test("raising ONE weight lifts its share and lowers every other share", () => {
  const base = global._dsTierShares(RECO_W).pct;
  const bumped = global._dsTierShares({ ...RECO_W, T1: 2.5 }).pct;
  assert(bumped.T1 > base.T1, "T1 share rises (" + base.T1 + "→" + bumped.T1 + ")");
  for (const t of ["T2", "T3", "T4", "T5"]) {
    assert(bumped[t] <= base[t], t + " share does not rise (" + base[t] + "→" + bumped[t] + ")");
  }
  const sum = ["T1", "T2", "T3", "T4", "T5"].reduce((a, t) => a + bumped[t], 0);
  assertEq(sum, 100, "still totals 100 after the bump");
});

test("scaling ALL weights by a constant leaves shares unchanged (only ratios matter)", () => {
  const a = global._dsTierShares(RECO_W).pct;
  const b = global._dsTierShares({ T1: 3.2, T2: 2.7, T3: 2.0, T4: 1.2, T5: 0.4 }).pct;   // ×2
  for (const t of ["T1", "T2", "T3", "T4", "T5"]) assertEq(a[t], b[t], t + " share invariant to scaling");
});

test("no projection pool → weight-only basis, still totals 100%", () => {
  const realGetValues = global.getValues;
  global.getValues = () => [];
  try {
    const r = global._dsTierShares(RECO_W);
    assertEq(r.basis, "weight", "empty pool → weight-only");
    const sum = ["T1", "T2", "T3", "T4", "T5"].reduce((a, t) => a + r.pct[t], 0);
    assertEq(sum, 100, "weight shares sum to 100");
    assert(r.pct.T1 > r.pct.T5, "higher weight → bigger share");
  } finally { global.getValues = realGetValues; }
});

test("all weights zero → null shares (no divide-by-zero)", () => {
  const r = global._dsTierShares({ T1: 0, T2: 0, T3: 0, T4: 0, T5: 0 });
  assertEq(r.pct, null, "null when nothing to distribute");
});

// =====================================================================
section("Owner-tendency persistence (real drafts only)");
// =====================================================================

// Fill the event log with enough nominations to clear the archive threshold.
function seedTellsSession(nomTeam) {
  global._dlog.leagueId = 1200; global._dlog.startedAt = 111222333;
  for (let i = 0; i < 9; i++) {
    pushLot(nomTeam, 5000 + i, { othersBid: i % 2 === 0, nomRebids: i % 2 === 0, winner: i % 2 === 0 ? nomTeam : 2, price: 7 });
  }
}

test("real mode + home league → tells archived, aggregated, idempotent", () => {
  setRealMode(); resetDraftState();
  ls.removeItem("ud_owner_tendencies_v1");
  seedTellsSession(1);   // espn 1 = matt
  assertEq(global.recordOwnerTendencies(), true, "recorded");
  assertEq(global.recordOwnerTendencies(), true, "second call upserts (same session)");
  const stored = JSON.parse(ls.getItem("ud_owner_tendencies_v1"));
  assertEq(Object.keys(stored.sessions).length, 1, "one session (idempotent by stream key)");
  const h = global.getOwnerTendencyHistory("matt");
  assert(h && h.drafts === 1 && h.noms === 9, "aggregated for the mapped OWNER id (got " + JSON.stringify(h) + ")");
  assert(h.chased >= 2, "chases carried through");
  const note = global.ownerTendencyNote(1);
  assert(note && note.includes("chased"), "historical note renders (got: " + note + ")");
});

test("test mode / bot mock / foreign league never touch the profiles", () => {
  resetDraftState();
  ls.removeItem("ud_owner_tendencies_v1");
  seedTellsSession(1);
  ls.setItem("ud_feed_mode", "test");
  assertEq(global.recordOwnerTendencies(), false, "test mode blocked");
  setRealMode();
  global.mockFeedActive = () => true;
  try { assertEq(global.recordOwnerTendencies(), false, "bot practice mock blocked"); }
  finally { delete global.mockFeedActive; }
  const realLeague = global.ESPN.leagueId;
  global.ESPN.leagueId = 999;
  try { assertEq(global.recordOwnerTendencies(), false, "foreign league blocked"); }
  finally { global.ESPN.leagueId = realLeague; }
  assertEq(ls.getItem("ud_owner_tendencies_v1"), null, "store untouched");
});

// =====================================================================
section("Draft cadence — learn from ESPN feeds, real wins outright");
// =====================================================================

// N full lots with realistic timing: nom → 4 bids (500ms apart, +$1 each) →
// SOLD 25s after the nom → next nom 2s later.
function seedCadenceSession(leagueId, startedAt, lots) {
  global._dlog.events = [];
  global._dlog.leagueId = leagueId; global._dlog.startedAt = startedAt;
  let seq = 0, t = 1000000;
  for (let i = 0; i < lots; i++) {
    const pid = 7000 + i;
    global._dlog.events.push({ cmd: "NOMINATION", teamId: 1 + (i % 4), playerId: pid, seq: ++seq, at: t });
    for (let b = 0; b < 4; b++) {
      global._dlog.events.push({ cmd: "BID", teamId: 2 + (b % 3), playerId: pid, amount: 2 + b, seq: ++seq, at: t + 1000 + b * 500 });
    }
    global._dlog.events.push({ cmd: "SOLD", teamId: 2, playerId: pid, amount: 5, seq: ++seq, at: t + 25000 });
    t += 27000;
  }
}

test("deriveCadenceFromEvents measures increments, gaps, lot length, between-lots", () => {
  resetDraftState();
  seedCadenceSession(1200, 1, 3);
  const { samples, sold } = global.deriveCadenceFromEvents(global._dlog.events);
  assertEq(sold, 3, "3 sold lots");
  assert(samples.increments.every(x => x === 1), "increments are the $1 steps");
  assert(samples.interBidMs.every(x => x === 500), "inter-bid gaps 500ms");
  assert(samples.lotMs.every(x => x === 25000), "lot duration 25s");
  assert(samples.betweenLotMs.every(x => x === 2000), "2s between lots");
  assert(samples.bidsPerLot.every(x => x === 4), "4 bids per lot");
});

test("INIT breaks timing chains (no cross-reconnect junk samples)", () => {
  resetDraftState();
  global._dlog.events = [
    { cmd: "NOMINATION", teamId: 1, playerId: 1, seq: 1, at: 1000 },
    { cmd: "SOLD", teamId: 2, playerId: 1, amount: 3, seq: 2, at: 26000 },
    { cmd: "INIT", seq: 3, at: 27000 },
    { cmd: "NOMINATION", teamId: 1, playerId: 2, seq: 4, at: 900000 },   // long after — must NOT be a between-lots sample
    { cmd: "SOLD", teamId: 2, playerId: 2, amount: 3, seq: 5, at: 925000 },
  ];
  const { samples } = global.deriveCadenceFromEvents(global._dlog.events);
  assertEq(samples.betweenLotMs.length, 0, "no between-lot sample across the INIT gap");
});

test("ESPN mock feeds the mock bucket; a real draft then takes over outright", () => {
  resetDraftState();
  ls.removeItem("ud_draft_cadence_v1");
  // 1) an ESPN mock room (feed test) — learns into 'mock'
  ls.setItem("ud_feed_mode", "test");
  seedCadenceSession(555, 10, 10);
  assertEq(global.recordDraftCadence(), "mock", "ESPN mock recorded to the mock bucket");
  let pool = global.getCadenceSamples();
  assert(pool && pool.source === "mock", "mock samples drive pacing while no real draft exists");
  // 2) the real home-league draft arrives — real bucket wins outright
  setRealMode();
  seedCadenceSession(1200, 20, 10);
  assertEq(global.recordDraftCadence(), "real", "real draft recorded to the real bucket");
  pool = global.getCadenceSamples();
  assert(pool && pool.source === "real", "real cadence wins the moment it exists");
  // 3) idempotent per stream
  assertEq(global.recordDraftCadence(), "real", "upsert");
  const stored = JSON.parse(ls.getItem("ud_draft_cadence_v1"));
  assertEq(Object.keys(stored.real).length, 1, "one real session (idempotent)");
  assertEq(Object.keys(stored.mock).length, 1, "mock bucket intact");
});

test("bot practice mocks and short stubs never record", () => {
  resetDraftState();
  ls.removeItem("ud_draft_cadence_v1");
  setRealMode();
  seedCadenceSession(1200, 30, 10);
  global.mockFeedActive = () => true;
  try { assertEq(global.recordDraftCadence(), null, "bot mock excluded"); }
  finally { delete global.mockFeedActive; }
  seedCadenceSession(1200, 31, 3);   // < 8 sold
  assertEq(global.recordDraftCadence(), null, "too-short session excluded");
  assertEq(ls.getItem("ud_draft_cadence_v1"), null, "store untouched");
});

test("cadenceDraw samples the empirical array; null on empty", () => {
  assertEq(global.cadenceDraw([]), null, "empty → null");
  assertEq(global.cadenceDraw(null), null, "null → null");
  const v = global.cadenceDraw([7]);
  assertEq(v, 7, "single-element draw");
});

summary("Draft intelligence: category bid, tells, squeeze, readiness");
