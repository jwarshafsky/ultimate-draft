// FA keeper price (Jeff, Jul 9 2026): free agents with no draft history showed
// $8 on the Keepers page. Constitution: FAAB cost does NOT affect keeper value —
// ALL FA keepers are $6 in their first keepable year. A player with no draft
// record at all can only be a current-season FAAB add (any player kept in a
// prior offseason appears in that year's draft as a keeper pick), so their
// first keepable year IS the upcoming draft → $6, not $8.
//
// Round 2 (same day): Heliot Ramos ($5 draft) and Ivan Herrera ($3 draft) were
// drafted, DROPPED, and re-added via FAAB — dead contracts, $6 FAs — but the
// escalator priced them off draft history ($7/$5). Round 3: the first attempt
// inferred "dropped" from absence in the League App book, which is wrong — the
// book only lists KEEPERS, so auction buys like Ohtani/Joe Ryan/Seiya Suzuki
// aren't in it either and got mispriced to $6. The real signal is ESPN's
// per-entry acquisitionType: ADD = FAAB pickup ($6); DRAFT/TRADE = the drafted
// cost basis survives (trades transfer salary) → history escalator.
const { test, section, summary, assertEq, makeLocalStorageStub } = require("./helpers.js");
const fs = require("fs");

global.window = global;
global.localStorage = makeLocalStorageStub();
global.normalizePlayerName = (s) => String(s || "").toLowerCase()
  .normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[.']/g, "").replace(/\s+/g, " ").trim();
global.getKeeperPriceExceptions = () => ({ "Override Guy": 12 });

// League App contract stubs (the book of KEPT contracts — auction buys and
// FAAB adds are never in it). `leagueLoaded` simulates whether the fetch ran.
let leagueLoaded = true;
global.getLeagueRosterData = () => (leagueLoaded ? { season: 2026 } : null);
global.getLeagueContractByName = (name) => {
  const n = global.normalizePlayerName(name);
  if (n === "contract guy")           // full League App record: majors carry nextYearPrice
    return { kind: "major", contract: { nextYearPrice: 26 }, cost: 26, costMissing: false };
  if (n === "callup guy")
    return { kind: "callup", contract: {}, cost: 10, costMissing: false };
  return null;
};

// ESPN acquisitionType stub (how the current roster got each player).
// Callup Guy is deliberately ADD: call-ups reach the ESPN roster via an add,
// but their League App tier price must win over the $6 FA rule.
const acqMap = {
  "drafted guy": "DRAFT",
  "readded guy": "ADD",
  "traded guy": "TRADE",
  "faab pickup": "ADD",
  "traded faab guy": "TRADE",
  "callup guy": "ADD",
  "chain guy": "TRADE",
  "dollar draftee": "TRADE",
};
global.espnAcquisitionType = (name) => acqMap[global.normalizePlayerName(name)] || null;

// Cap-tracker salary stub (drafted basis travels with a trade; FAAB chain = $1).
const capMap = { "traded guy": 107, "chain guy": 1, "dollar draftee": 1 };
global.capSheetSalary = (name) => {
  const v = capMap[global.normalizePlayerName(name)];
  return typeof v === "number" ? v : null;
};

// Seed through the real storage path (loadHistoryFromStorage runs at load).
// Latest data year 2026 → upcoming draft year 2027.
localStorage.setItem("ud_draft_history_v1", JSON.stringify({
  picks: [
    { year: 2026, owner: "Jeff", player: "Drafted Guy", pos: "OF", price: 20 },
    { year: 2025, owner: "Jeff", player: "Lapsed Guy", pos: "1B", price: 10 },
    { year: 2026, owner: "AJ", player: "ReAdded Guy", pos: "OF", price: 5 },
    { year: 2026, owner: "Corey", player: "Traded Guy", pos: "DH", price: 107 },
    { year: 2026, owner: "AJ", player: "Chain Guy", pos: "OF", price: 5 },
    { year: 2026, owner: "AJ", player: "Dollar Draftee", pos: "RP", price: 1 },
  ],
  meta: { years: [2025, 2026] },
}));

eval(fs.readFileSync(__dirname + "/../js/data/draft-history.js", "utf8"));

section("Keeper salary — FA pickups keep at $6 (constitution)");
test("no draft history (current-season FAAB add) → $6, not $8", () => {
  assertEq(getCurrentKeeperSalary("Faab Pickup"), 6);
});
test("drafted most recent year → price + $2", () => {
  assertEq(getCurrentKeeperSalary("Drafted Guy"), 22);
});
test("year gap escalates $2 per year (2025 pick, 2027 draft)", () => {
  assertEq(getCurrentKeeperSalary("Lapsed Guy"), 14);
});
test("keeper_price_exceptions override wins over everything", () => {
  assertEq(getCurrentKeeperSalary("Override Guy"), 12);
});

section("Keeper salary — ESPN acquisitionType decides dead vs live contracts");
test("drafted, dropped, re-added via FAAB (ADD) → $6, not draft price + $2", () => {
  assertEq(getCurrentKeeperSalary("ReAdded Guy"), 6);
});
test("ADD wins even when League App data isn't loaded", () => {
  leagueLoaded = false;
  assertEq(getCurrentKeeperSalary("ReAdded Guy"), 6);
  leagueLoaded = true;
});
test("drafted-then-traded (TRADE) keeps cost basis → escalator", () => {
  assertEq(getCurrentKeeperSalary("Traded Guy"), 109);   // Ohtani case: $107 + $2
});
test("never-drafted traded FAAB player (TRADE, no history) → $6", () => {
  assertEq(getCurrentKeeperSalary("Traded Faab Guy"), 6);
});
test("drafted → dropped → FAABed → TRADED ($1 cap salary) → $6", () => {
  // The blind spot: ESPN says TRADE, draft history says $5, but the cap
  // tracker's $1 salary proves a FAAB link in the chain — contract is dead.
  assertEq(getCurrentKeeperSalary("Chain Guy"), 6);
});
test("legit $1 auction buy traded onward keeps the escalator ($3, not $6)", () => {
  // Cap salary $1 is ambiguous when the draft price was also $1 — don't
  // misread a real $1 basis as a FAAB chain.
  assertEq(getCurrentKeeperSalary("Dollar Draftee"), 3);
});
test("TRADE with no cap-sheet data → escalator (fail-safe)", () => {
  delete capMap["chain guy"];
  assertEq(getCurrentKeeperSalary("Chain Guy"), 7);
  capMap["chain guy"] = 1;
});
test("auction buy NOT in the League App book keeps the escalator", () => {
  // Round-3 regression: the book lists keepers only — absence must NOT mean $6.
  assertEq(getCurrentKeeperSalary("Drafted Guy"), 22);
});
test("no acquisition info at all → history escalator (fail-safe)", () => {
  assertEq(getCurrentKeeperSalary("Lapsed Guy"), 14);
});

// The League App is the authoritative salary book. When it carries a real
// price (majors' nextYearPrice, a callup's set price), that price wins even
// if draft history is missing or contradicts it (preview-browser Harper case:
// contracted at $26 but empty local history priced him as a $6 FA).
section("Keeper salary — League App contract price is authoritative");
test("major with League App nextYearPrice → that price, even with no history", () => {
  assertEq(getCurrentKeeperSalary("Contract Guy"), 26);
});
test("major League App price beats a conflicting history escalator", () => {
  localStorage.setItem("ud_draft_history_v1", JSON.stringify({
    picks: [{ year: 2026, owner: "Jeff", player: "Contract Guy", pos: "OF", price: 40 }],
    meta: { years: [2026] },
  }));
  loadHistoryFromStorage();
  assertEq(getCurrentKeeperSalary("Contract Guy"), 26);
});
test("priced call-up → tier price wins over the $6 ADD rule", () => {
  assertEq(getCurrentKeeperSalary("Callup Guy"), 10);
});

// The cap-salaries loader itself (js/data/cap-salaries.js): parse the real
// published-CSV shape — headerless player rows with team totals tacked on the
// right, plus a partial header line that must be skipped.
section("Cap-salary CSV parsing");
eval(fs.readFileSync(__dirname + "/../js/data/cap-salaries.js", "utf8"));
test("parses owner,player,salary rows and skips header/blank lines", () => {
  const csv = [
    " ,,,,,Team,Salary",
    "MV3,Matt Chapman,8.00,8.00,,Jeff,382",
    "Jeff,Shohei Ohtani,107.00,107.00,,,",
    "Jeff,Heliot Ramos,1.00,1.00,,,",
    ",,,,,,",
  ].join("\n");
  const map = _parseCapSalaries(csv);
  assertEq(map[normalizePlayerName("Shohei Ohtani")], 107);
  assertEq(map[normalizePlayerName("Heliot Ramos")], 1);
  assertEq(map[normalizePlayerName("Matt Chapman")], 8);
  assertEq(Object.keys(map).length, 3);
});
test("capSheetSalary reads the localStorage cache", () => {
  localStorage.setItem("ud_cap_salaries_v1", JSON.stringify({
    map: { [normalizePlayerName("Cached Guy")]: 14 }, at: "2026-07-09T00:00:00Z",
  }));
  assertEq(capSheetSalary("Cached Guy"), 14);
  assertEq(capSheetSalary("Nobody"), null);
});
summary();
