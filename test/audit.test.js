// Post-draft audit diff logic (perfection plan Phase 3a): official ESPN picks
// vs our capture — missing / price / team / extra all detected; clean = clean.
const { test, section, summary, assert, assertEq, makeLocalStorageStub } = require("./helpers.js");
const fs = require("fs");
global.window = global;
global.localStorage = makeLocalStorageStub();
global.document = { getElementById: (id) => (global.__el && global.__el.id === id ? global.__el : { innerHTML: "" }), createElement: () => ({ style: {}, addEventListener() {}, appendChild() {}, click() {}, remove() {} }), body: { appendChild() {} } };
global.esc = (s) => String(s);
global._liveDraft = { picks: [] };
global.getPlayerValue = () => null; global.getNfbc = () => null;
global.getTeam = () => null; global.draftTestMode = () => true;
global.getMyTeam = () => null; global.getMyDraftTeam = () => null;
global._dlog = { events: [] };
eval(fs.readFileSync(__dirname + "/../js/features/debrief.js", "utf8"));

function elFor() { global.__el = { id: "debrief-audit-body", innerHTML: "" }; return global.__el; }

section("Post-draft audit vs ESPN official results");

test("zero diffs certifies; each diff class detected", async () => {
  _liveDraft.picks = [
    { player: "A", espnPlayerId: 1, espnTeamId: 3, price: 10 },
    { player: "B", espnPlayerId: 2, espnTeamId: 4, price: 20 },
    { player: "Extra", espnPlayerId: 9, espnTeamId: 5, price: 5 },
  ];
  // official: A ok; B wrong price+team; C missing from ours; no 9
  global.fetchEspnDraft = async () => ({ picks: [
    { playerId: 1, teamId: 3, bidAmount: 10, playerName: "A" },
    { playerId: 2, teamId: 7, bidAmount: 25, playerName: "B" },
    { playerId: 3, teamId: 2, bidAmount: 8, playerName: "C" },
  ]});
  const el = elFor();
  await runDraftAudit();
  assert(el.innerHTML.includes("discrepanc"), "diffs detected");
  assert(el.innerHTML.includes("PRICE: B"), "price diff");
  assert(el.innerHTML.includes("TEAM: B"), "team diff");
  assert(el.innerHTML.includes("MISSING"), "missing pick");
  assert(el.innerHTML.includes("EXTRA"), "extra pick");

  // clean case
  _liveDraft.picks = [{ player: "A", espnPlayerId: 1, espnTeamId: 3, price: 10 }];
  global.fetchEspnDraft = async () => ({ picks: [{ playerId: 1, teamId: 3, bidAmount: 10, playerName: "A" }] });
  const el2 = elFor();
  await runDraftAudit();
  assert(el2.innerHTML.includes("CERTIFIED"), "clean audit certifies: " + el2.innerHTML.slice(0, 80));
});

// R13: a UD-native practice mock (leagueId 990001, synthetic ids, ESPN.leagueId
// left at home) must NOT run the ESPN official-results audit — it would diff the
// mock against the real league. The guard is synchronous (returns before the
// first await), so a sync test body suffices.
test("a UD practice mock skips the ESPN audit (shows a note, no fetch)", () => {
  global.mockFeedActive = () => true;
  let fetched = false;
  global.fetchEspnDraft = async () => { fetched = true; return { picks: [] }; };
  const el = elFor();
  runDraftAudit();
  assert(!fetched, "must NOT fetch ESPN during a UD practice mock");
  assert(el.innerHTML.toLowerCase().includes("practice mock"), "shows the not-applicable note: " + el.innerHTML.slice(0, 90));
  global.mockFeedActive = () => false;
});

(async () => { await new Promise(r => setTimeout(r, 100)); summary(); })();
