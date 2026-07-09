// FA keeper price (Jeff, Jul 9 2026): free agents with no draft history showed
// $8 on the Keepers page. Constitution: FAAB cost does NOT affect keeper value —
// ALL FA keepers are $6 in their first keepable year. A player with no draft
// record at all can only be a current-season FAAB add (any player kept in a
// prior offseason appears in that year's draft as a keeper pick), so their
// first keepable year IS the upcoming draft → $6, not $8.
const { test, section, summary, assertEq, makeLocalStorageStub } = require("./helpers.js");
const fs = require("fs");

global.window = global;
global.localStorage = makeLocalStorageStub();
global.normalizePlayerName = (s) => String(s || "").toLowerCase()
  .normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[.']/g, "").replace(/\s+/g, " ").trim();
global.getKeeperPriceExceptions = () => ({ "Override Guy": 12 });

// League App contract stubs (authoritative contract book). `leagueLoaded`
// simulates whether the rosters fetch has happened; players in `contracted`
// still hold their drafted contract, anyone else was dropped.
let leagueLoaded = true;
const contracted = new Set(["drafted guy", "lapsed guy", "override guy"]);
global.getLeagueRosterData = () => (leagueLoaded ? { season: 2026 } : null);
global.getLeagueContractByName = (name) => {
  const n = global.normalizePlayerName(name);
  if (n === "contract guy")           // full League App record: majors carry nextYearPrice
    return { kind: "major", contract: { nextYearPrice: 26 }, cost: 26, costMissing: false };
  if (n === "callup guy")
    return { kind: "callup", contract: {}, cost: 10, costMissing: false };
  return contracted.has(n) ? { kind: "major" } : null;
};

// Seed through the real storage path (loadHistoryFromStorage runs at load).
// Latest data year 2026 → upcoming draft year 2027.
localStorage.setItem("ud_draft_history_v1", JSON.stringify({
  picks: [
    { year: 2026, owner: "Jeff", player: "Drafted Guy", pos: "OF", price: 20 },
    { year: 2025, owner: "Jeff", player: "Lapsed Guy", pos: "1B", price: 10 },
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

// Jeff, Jul 9 2026 (round 2): Heliot Ramos ($5 draft → showed $7) and Ivan
// Herrera ($3 draft → showed $5) were drafted, DROPPED, and re-added via FAAB.
// A dropped contract is dead — the re-adding team owns a $6 FA keeper, but the
// escalator only saw draft history. League App roster data (the authoritative
// contract book) tells us who still holds a contract.
section("Keeper salary — drafted-then-dropped players re-price as $6 FAs");
test("drafted, dropped, re-added via FAAB → $6 (not draft price + $2)", () => {
  localStorage.setItem("ud_draft_history_v1", JSON.stringify({
    picks: [{ year: 2026, owner: "AJ", player: "ReAdded Guy", pos: "OF", price: 5 }],
    meta: { years: [2026] },
  }));
  loadHistoryFromStorage();
  assertEq(getCurrentKeeperSalary("ReAdded Guy"), 6);
});
test("league data not loaded yet → falls back to history escalator", () => {
  leagueLoaded = false;
  assertEq(getCurrentKeeperSalary("ReAdded Guy"), 7);
  leagueLoaded = true;
});
test("still-contracted drafted player keeps the escalator", () => {
  localStorage.setItem("ud_draft_history_v1", JSON.stringify({
    picks: [
      { year: 2026, owner: "Jeff", player: "Drafted Guy", pos: "OF", price: 20 },
      { year: 2025, owner: "Jeff", player: "Lapsed Guy", pos: "1B", price: 10 },
    ],
    meta: { years: [2025, 2026] },
  }));
  loadHistoryFromStorage();
  assertEq(getCurrentKeeperSalary("Drafted Guy"), 22);
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
test("callup with a set price → that price", () => {
  assertEq(getCurrentKeeperSalary("Callup Guy"), 10);
});
summary();
