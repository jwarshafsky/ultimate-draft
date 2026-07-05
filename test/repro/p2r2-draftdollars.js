// p2r2-draftdollars — FINDING (SCOPE B): a garbage/HTML response from the
// traded-draft-dollars Google Sheet silently OVERWRITES good cached adjustments
// with {} and PERSISTS {} to localStorage. Every team then reverts to base $260
// with no indication anything is wrong — a "show wrong numbers" failure (worse
// than showing nothing), and it poisons the cache for the next reload.
//
// Root cause: loadDraftDollars() (js/data/draft-dollars.js:47-60) assigns
//   _draftDollars = data;  localStorage.setItem(..., {data, at})
// UNCONDITIONALLY on any 200, with no sanity gate. Google Sheets' `output=csv`
// publish endpoint is documented to serve an HTML error / sign-in page (HTTP 200)
// when the sheet is momentarily unavailable or just republished. parseCSV()
// happily "parses" that HTML into rows, _parseDraftDollars finds no Team match,
// and returns {} — which then clobbers the real adjustments.
//
// Contrast: league-rosters.js:63 guards with
//   if (!data || !Array.isArray(data.teams)) throw ...
// so a garbage parse there does NOT overwrite good data. draft-dollars has no
// equivalent gate.
//
// This repro loads the REAL draft-dollars.js + a real parseCSV into a stubbed
// global, seeds a good cache, then simulates a 200-with-HTML response and shows
// the adjustments get wiped + persisted.

const fs = require("fs");
const path = require("path");
const APP = "/Users/jwars/Desktop/Claude/ultimate-draft/js/";

// --- minimal browser-ish globals ---
const _ls = {};
global.localStorage = {
  getItem: (k) => (k in _ls ? _ls[k] : null),
  setItem: (k, v) => { _ls[k] = String(v); },
  removeItem: (k) => { delete _ls[k]; },
};
global.console = console;

// LEAGUE with a couple of owners so _ddResolveTeamId can match.
global.LEAGUE = {
  draftBudget: 260,
  teams: [
    { id: "jeff", owner: "Warshafsky" },
    { id: "matt", owner: "Matt" },
  ],
};

// Real parseCSV from projections.js (sliced) + real draft-dollars.js.
function sliceFn(src, name) {
  const s = src.indexOf("function " + name + "(");
  const bs = src.indexOf("{", s);
  let d = 0, e = -1;
  for (let i = bs; i < src.length; i++) {
    if (src[i] === "{") d++; else if (src[i] === "}") { if (--d === 0) { e = i; break; } }
  }
  return src.slice(s, e + 1);
}
const projSrc = fs.readFileSync(APP + "data/projections.js", "utf8");
eval(sliceFn(projSrc, "parseCSV"));
global.parseCSV = parseCSV;

// draft-dollars.js ends with a top-level _loadDDFromCache() call and uses fetch;
// we eval the whole file (fetch is monkeypatched below), then drive loadDraftDollars.
const ddSrc = fs.readFileSync(APP + "data/draft-dollars.js", "utf8");
// Provide a fetch stub the file will close over via global.
let _nextResponse = null;
global.fetch = async () => ({
  ok: _nextResponse.ok,
  status: _nextResponse.status,
  text: async () => _nextResponse.body,
});
eval(ddSrc);   // defines loadDraftDollars, getDraftDollarAdjustment, etc.

async function run() {
  let failed = 0;
  const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) failed++; };

  // 1) A GOOD csv loads real adjustments and caches them.
  _nextResponse = { ok: true, status: 200, body: "Team,Change in Cash\nWarshafsky,-15\nMatt,20\n" };
  await loadDraftDollars();
  ok(getDraftDollarAdjustment("jeff") === -15, "good CSV -> jeff adj = -15 (got " + getDraftDollarAdjustment("jeff") + ")");
  ok(getDraftDollarAdjustment("matt") === 20, "good CSV -> matt adj = 20 (got " + getDraftDollarAdjustment("matt") + ")");
  const cachedGood = localStorage.getItem("ud_draft_dollars_v1");
  ok(/(-15)/.test(cachedGood), "good adjustments persisted to cache");

  // 2) Now Google serves a 200 with an HTML error page (its real failure mode).
  const htmlErr = "<!DOCTYPE html><html><head><title>Temporarily Unavailable</title></head>"
    + "<body><h1>Sorry, unable to open the file at this time.</h1>"
    + "<p>Please check the address and try again.</p></body></html>";
  _nextResponse = { ok: true, status: 200, body: htmlErr };
  await loadDraftDollars();

  const jeffAfter = getDraftDollarAdjustment("jeff");
  const mattAfter = getDraftDollarAdjustment("matt");
  const cachedAfter = localStorage.getItem("ud_draft_dollars_v1");

  console.log("\n  After HTML-error response:");
  console.log("    jeff adj  =", jeffAfter, "(was -15)");
  console.log("    matt adj  =", mattAfter, "(was 20)");
  console.log("    cache     =", cachedAfter.slice(0, 80));

  // The BUG: adjustments silently reverted to 0 and the good cache was wiped.
  const wiped = (jeffAfter === 0 && mattAfter === 0);
  const cachePoisoned = !/(-15)/.test(cachedAfter);

  console.log("");
  // This repro is designed to FAIL while the bug exists: we ASSERT the
  // spec-correct behavior (good values retained on garbage), so a fail = bug.
  ok(jeffAfter === -15, "SPEC: jeff adjustment retained on garbage response (should stay -15)");
  ok(!cachePoisoned, "SPEC: good cache NOT overwritten by garbage");

  if (wiped) console.log("\n  >>> BUG CONFIRMED: traded-budget adjustments silently wiped to $0 and cache poisoned.");
  console.log("\n" + (failed === 0 ? "ALL PASS (bug fixed)" : failed + " ASSERTION(S) FAILED (bug present)"));
  process.exit(failed === 0 ? 0 : 1);
}
run();
