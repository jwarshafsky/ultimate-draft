// Deadline-trade model tests — loads the REAL core engines (standings.js +
// deadline.js, both pure) and asserts:
//   1. component transfer math is exact and zero-sum (trades move stats,
//      never create them),
//   2. buildTradeModel reads buyers/sellers off the base odds correctly and
//      only offers FUTURE (_ros) production as trade chips,
//   3. simulateTitleOdds with a tradeModel: a closed window is a no-op, an
//      open one moves stars bottom→top (sellers finish worse, buyers better,
//      flow report points the right way).

const fs = require("fs");
const { test, section, summary, assert, assertEq } = require("./helpers.js");

const APP = "/Users/jwars/Desktop/Claude/ultimate-draft/js/";

// Concat-eval the real files so top-level consts are shared, then export.
let bundle = ["core/standings.js", "core/deadline.js"]
  .map((f) => fs.readFileSync(APP + f, "utf8")).join("\n;\n");
bundle += "\n;globalThis.__D={aggregateTeamCats,computeStandings,simulateTitleOdds," +
  "buildTradeModel,_dlSampleTrades,_dlApplyTrade,_dlComponentsFromTotals,_dlCatValues," +
  "_dlChipValue,_dlPoisson,DEADLINE_COMP_KEYS,DEADLINE_NET_TRANSFER};";
(0, eval)(bundle);
const D = globalThis.__D;

// ---------------------------------------------------------------------------
// Fixture: a 12-team league with a clean quality gradient (t1 best … t12
// worst). Each team is one hitter line + one pitcher line (the engine doesn't
// care how many players carry the stats); t9's offense is split 65/35 so it
// owns a named star ("Bottom Star") a seller would shop.
// ---------------------------------------------------------------------------
function scaleHit(h, f) {
  return { ...h, R: h.R * f, HR: h.HR * f, RBI: h.RBI * f, SB: h.SB * f, PA: h.PA * f };
}
function mkLeague() {
  const rosters = {};
  for (let i = 1; i <= 12; i++) {
    const q = 13 - i;
    const hit = { name: "T" + i + " Hitter", type: "H", _ros: true,
      R: 600 + q * 25, HR: 150 + q * 12, RBI: 600 + q * 25, SB: 80 + q * 6,
      OBP: 0.300 + q * 0.004, PA: 7000 };
    const pit = { name: "T" + i + " Pitcher", type: "P", _ros: true,
      K: 900 + q * 35, QS: 60 + q * 5, SV: 40 + q * 4, HLD: 20,
      IP: 1000, ERA: 4.6 - q * 0.09, WHIP: 1.38 - q * 0.012 };
    if (i === 9) {
      rosters["t9"] = [
        { ...scaleHit(hit, 0.65), name: "T9 Hitter" },
        { ...scaleHit(hit, 0.35), name: "Bottom Star" },
        pit,
      ];
    } else {
      rosters["t" + i] = [hit, pit];
    }
  }
  return rosters;
}

const ROSTERS = mkLeague();
const BASE = D.simulateTitleOdds(ROSTERS, { sims: 3000 });
const rankByAvgFinish = Object.keys(ROSTERS)
  .sort((a, b) => BASE.byTeam[a].avgFinish - BASE.byTeam[b].avgFinish);

section("component transfer math");

test("apply-trade moves exactly net × chip and is zero-sum", () => {
  const seller = D._dlComponentsFromTotals(D.aggregateTeamCats(ROSTERS.t9));
  const buyer = D._dlComponentsFromTotals(D.aggregateTeamCats(ROSTERS.t1));
  const chip = D._dlComponentsFromTotals(D.aggregateTeamCats(
    ROSTERS.t9.filter(p => p.name === "Bottom Star")));
  const before = {};
  for (const k of D.DEADLINE_COMP_KEYS) before[k] = seller[k] + buyer[k];
  const s0 = { ...seller }, b0 = { ...buyer };
  D._dlApplyTrade(seller, buyer, chip, D.DEADLINE_NET_TRANSFER);
  for (const k of D.DEADLINE_COMP_KEYS) {
    const d = (chip[k] || 0) * D.DEADLINE_NET_TRANSFER;
    assert(Math.abs(seller[k] - (s0[k] - d)) < 1e-9, "seller " + k + " off");
    assert(Math.abs(buyer[k] - (b0[k] + d)) < 1e-9, "buyer " + k + " off");
    assert(Math.abs(seller[k] + buyer[k] - before[k]) < 1e-9, "league total drifted in " + k);
  }
});

test("cat values re-derive rates from moved components", () => {
  const c = D._dlComponentsFromTotals(D.aggregateTeamCats(ROSTERS.t1));
  const v = D._dlCatValues(c);
  const t = D.aggregateTeamCats(ROSTERS.t1);
  for (const cat of ["R", "HR", "RBI", "SB", "QS", "K", "SV_HLD", "OBP", "ERA", "WHIP"]) {
    assert(Math.abs(v[cat] - t[cat]) < 1e-9, cat + " mismatch vs aggregateTeamCats");
  }
});

test("poisson: lambda 0 -> 0; mean tracks lambda", () => {
  assertEq(D._dlPoisson(0), 0);
  let sum = 0;
  for (let i = 0; i < 5000; i++) sum += D._dlPoisson(2);
  const mean = sum / 5000;
  assert(mean > 1.8 && mean < 2.2, "poisson(2) mean " + mean.toFixed(2));
});

section("buildTradeModel");

test("buyers are contenders, sellers are cellar teams", () => {
  const m = D.buildTradeModel(ROSTERS, BASE, { windowFrac: 1 });
  assert(m, "model built");
  assert(m.buyerW.t1 > m.buyerW.t12, "t1 should out-buy t12");
  assert(m.sellerW.t12 > m.sellerW.t1, "t12 should out-sell t1");
  assert(m.sellerW.t9 > m.sellerW.t3, "t9 should out-sell t3");
});

test("chips: ≤3 per team, positive value, star present on t9", () => {
  const m = D.buildTradeModel(ROSTERS, BASE, { windowFrac: 1 });
  const perTeam = {};
  for (const c of m.chips) {
    perTeam[c.teamId] = (perTeam[c.teamId] || 0) + 1;
    assert(c.value > 0 && isFinite(c.value), "chip value bad for " + c.name);
    for (const k of D.DEADLINE_COMP_KEYS) assert(isFinite(c.comp[k] || 0), "comp " + k);
  }
  for (const id of Object.keys(perTeam)) assert(perTeam[id] <= 3, id + " has >3 chips");
  assert(m.chips.some(c => c.name === "Bottom Star" && c.teamId === "t9"), "t9 star is a chip");
});

test("only _ros (future) lines become chip production", () => {
  // One player with a huge banked YTD line and a small ROS line: only the ROS
  // half is tradeable (banked stats never move in a trade).
  const rosters = { ...ROSTERS, t12: [
    { name: "Mixed Guy", type: "H", R: 500, HR: 200, RBI: 500, SB: 100, OBP: 0.400, PA: 3000 },          // YTD
    { name: "Mixed Guy", type: "H", _ros: true, R: 30, HR: 10, RBI: 30, SB: 5, OBP: 0.330, PA: 250 },    // ROS
    ROSTERS.t12[1],
  ] };
  const m = D.buildTradeModel(rosters, BASE, { windowFrac: 1 });
  const chip = m.chips.find(c => c.teamId === "t12" && c.name === "Mixed Guy");
  assert(chip, "Mixed Guy is a chip");
  assert(Math.abs(chip.comp.R - 30) < 1e-9, "chip carries ROS stats only, got R=" + chip.comp.R);
});

test("closed window -> lambda 0; tiny league -> null", () => {
  const m = D.buildTradeModel(ROSTERS, BASE, { windowFrac: 0 });
  assertEq(m.lambda, 0);
  assertEq(D.buildTradeModel({ t1: ROSTERS.t1 }, BASE, { windowFrac: 1 }), null);
});

section("simulateTitleOdds with tradeModel");

test("lambda 0 is a no-op with an empty flow report", () => {
  const m = D.buildTradeModel(ROSTERS, BASE, { windowFrac: 0 });
  const od = D.simulateTitleOdds(ROSTERS, { sims: 400, tradeModel: m });
  assert(od.deadline, "deadline report present");
  assertEq(od.deadline.chips.length, 0, "no chips traded");
  assert(od.byTeam.t1 && od.byTeam.t12, "odds structure intact");
});

// One heavy shared run for the behavioral checks.
const MODEL = D.buildTradeModel(ROSTERS, BASE, { windowFrac: 1, lambda: 6 });
const ADJ = D.simulateTitleOdds(ROSTERS, { sims: 3000, tradeModel: MODEL });

test("trade flow runs bottom -> top", () => {
  const top4 = new Set(rankByAvgFinish.slice(0, 4));
  const bot5 = new Set(rankByAvgFinish.slice(-5));
  let fromBot = 0, fromTop = 0, destTop = 0, destBot = 0;
  for (const c of ADJ.deadline.chips) {
    if (bot5.has(c.from)) fromBot += c.pTraded;
    if (top4.has(c.from)) fromTop += c.pTraded;
    for (const d of c.dest) {
      assert(d.teamId !== c.from, "self-trade for " + c.name);
      if (top4.has(d.teamId)) destTop += d.p;
      if (bot5.has(d.teamId)) destBot += d.p;
    }
  }
  assert(ADJ.deadline.chips.length > 0, "some trades happened");
  assert(fromBot > fromTop, "sellers should be bottom teams (bot " + fromBot.toFixed(2) + " vs top " + fromTop.toFixed(2) + ")");
  assert(destTop > destBot, "buyers should be top teams (top " + destTop.toFixed(2) + " vs bot " + destBot.toFixed(2) + ")");
});

test("expected trade count tracks lambda", () => {
  const total = ADJ.deadline.chips.reduce((s, c) => s + c.pTraded, 0);
  assert(total > 3 && total < 9, "E[trades/season] ~ lambda 6, got " + total.toFixed(2));
});

test("sellers finish worse; title race tightens among buyers", () => {
  const sumAvg = (od, ids) => ids.reduce((s, id) => s + od.byTeam[id].avgFinish, 0);
  const sellers = rankByAvgFinish.slice(7, 11);   // 8th–11th: room to fall
  assert(sumAvg(ADJ, sellers) > sumAvg(BASE, sellers) + 0.2,
    "seller avg finish should worsen: " + sumAvg(BASE, sellers).toFixed(2) + " -> " + sumAvg(ADJ, sellers).toFixed(2));
  // Buyer side: ranks are zero-sum, so the top-4's aggregate finish barely
  // moves — the observable effect is UNCERTAINTY. Which contender lands the
  // stars is a coin flip, so the favorite's title odds drop and the top-4
  // pFirst spread compresses. (Empirically ~0.70→0.52 leader, ~0.70→0.46
  // spread on this fixture; margins are set loose.)
  const top4 = rankByAvgFinish.slice(0, 4);
  const leader = top4[0];
  const spread = (od) => Math.max(...top4.map(id => od.byTeam[id].pFirst)) -
    Math.min(...top4.map(id => od.byTeam[id].pFirst));
  assert(ADJ.byTeam[leader].pFirst < BASE.byTeam[leader].pFirst - 0.05,
    "favorite's odds should drop: " + BASE.byTeam[leader].pFirst.toFixed(3) + " -> " + ADJ.byTeam[leader].pFirst.toFixed(3));
  assert(spread(ADJ) < spread(BASE) - 0.05,
    "top-4 spread should compress: " + spread(BASE).toFixed(3) + " -> " + spread(ADJ).toFixed(3));
});

summary("standings-deadline");
