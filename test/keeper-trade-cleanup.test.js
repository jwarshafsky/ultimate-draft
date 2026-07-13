// Traded-keeper ghost (Jeff, Jul 12 2026): Willson Contreras was traded from
// Dave to Klinger, but stayed listed on Dave's Keepers-page team because Jeff
// had his keeper box checked there. The "never lost" rule in _teamCandidates
// resurrects any picked player missing from the team's roster — right for an
// ESPN blip or name mismatch, wrong once the player verifiably lives on
// ANOTHER team's live roster. cleanupTradedMyKeepers() clears picks in exactly
// that case: present elsewhere + absent here. Absence alone never clears.
const { test, section, summary, assert, assertEq } = require("./helpers.js");
const fs = require("fs");

// --- minimal runtime for my-keepers.js ---
const store = {};
global.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
global.normalizePlayerName = (s) => String(s || "").toLowerCase()
  .normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[.']/g, "").replace(/\s+/g, " ").trim();
global.getKeeperSelections = () => ({});

eval(fs.readFileSync(__dirname + "/../js/data/my-keepers.js", "utf8"));

// Dave = team 3, Klinger = team 7 in this fixture. `const _myKeepers` doesn't
// escape eval scope, so seed/reset go through the public mutators only.
function seed() {
  for (const tid of [3, 7]) {
    for (const name of getMyTeamPicks(tid)) setMyKeeper(tid, name, false);
    setMyKeeperCost(tid, "Willson Contreras", null);
    setMyKeeper(tid, "Jose Ramirez", false);
  }
  setMyKeeper(3, "Willson Contreras", true);      // traded away → should clear
  setMyKeeper(3, "Elly De La Cruz", true);        // still on Dave → keep
  setMyKeeper(3, "Ghost Prospect", true);         // on NO roster → keep (never lost)
  setMyKeeper(7, "Jackson Chourio", true);        // Klinger's own pick → keep
  setMyKeeperCost(3, "Willson Contreras", 21);    // cost override survives the clear
}

const ROSTERS = {
  3: ["Elly De La Cruz"],
  7: ["Willson Contreras", "Jackson Chourio"],    // Contreras now lives here
};

section("cleanupTradedMyKeepers");

test("clears a pick stranded on the old team after a trade", () => {
  seed();
  const cleared = cleanupTradedMyKeepers(ROSTERS);
  assertEq(isMyKeeper(3, "Willson Contreras"), false, "Dave's stale pick cleared");
  assertEq(cleared.length, 1);
  assertEq(cleared[0].name, "Willson Contreras");
  assertEq(String(cleared[0].teamId), "3");
});

test("does not touch picks still on their own roster", () => {
  seed();
  cleanupTradedMyKeepers(ROSTERS);
  assertEq(isMyKeeper(3, "Elly De La Cruz"), true, "Dave's rostered pick kept");
  assertEq(isMyKeeper(7, "Jackson Chourio"), true, "Klinger's pick kept");
});

test("absence alone never clears (never-lost rule preserved)", () => {
  seed();
  cleanupTradedMyKeepers(ROSTERS);
  assertEq(isMyKeeper(3, "Ghost Prospect"), true, "player on no roster keeps his pick");
});

test("does not auto-check the player on his new team", () => {
  seed();
  cleanupTradedMyKeepers(ROSTERS);
  assertEq(isMyKeeper(7, "Willson Contreras"), false, "keeping him is Klinger's call, not automatic");
});

test("cost override survives the pick clear", () => {
  seed();
  cleanupTradedMyKeepers(ROSTERS);
  assertEq(getMyKeeperCost(3, "Willson Contreras"), 21, "manual cost kept for a possible trade-back");
});

test("matches names accent-insensitively across rosters", () => {
  seed();
  setMyKeeper(3, "Jose Ramirez", true);
  cleanupTradedMyKeepers({ 3: [], 7: ["José Ramírez"] });
  assertEq(isMyKeeper(3, "Jose Ramirez"), false, "accented ESPN spelling still identifies the trade");
});

test("persists the clear to localStorage", () => {
  seed();
  cleanupTradedMyKeepers(ROSTERS);
  const saved = JSON.parse(store["ud_my_keepers_v1"]);
  assert(!saved.teams[3]["Willson Contreras"] || !saved.teams[3]["Willson Contreras"].picked,
    "stale pick gone from persisted state");
});

test("no roster index → no-op", () => {
  seed();
  const cleared = cleanupTradedMyKeepers(null);
  assertEq(cleared.length, 0);
  assertEq(isMyKeeper(3, "Willson Contreras"), true, "nothing cleared without roster truth");
});

summary();
