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
summary();
