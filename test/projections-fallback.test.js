// getProjection must fall back to the active ROS source in-season (Jeff's
// Jul 4 mock: projected standings said "needs projections" while the Data tab
// was loaded — preseason store empty, ROS store full).
const { test, section, summary, assertEq } = require("./helpers.js");
const fs = require("fs");
global.window = global;
global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
global.normalizePlayerName = (x) => String(x || "").toLowerCase();
global.setStatus = () => {};
global.fireData = () => {};
global.onDataChange = undefined;
eval(fs.readFileSync(__dirname + "/../js/data/projections.js", "utf8"));
// preseason store stays empty; provide the ROS layer
activeProjSource = () => "steamer";
getRosLine = (src, name, type) => {
  if (name === "Juan Soto" && type === "H") return { name, type: "H", R: 108, HR: 38, RBI: 102, SB: 12, OBP: 0.415, PA: 650 };
  if (name === "Tarik Skubal" && type === "P") return { name, type: "P", K: 220, QS: 22, SV: 0, HLD: 0, IP: 190, ERA: 2.9, WHIP: 1.02 };
  return null;
};
section("Projections — in-season ROS fallback");
test("hitter + pitcher resolve from the active ROS source; SV_HLD composed", () => {
  assertEq(getProjection("Juan Soto")?.R, 108, "hitter via ROS");
  const p = getProjection("Tarik Skubal");
  assertEq(p?.K, 220, "pitcher via ROS");
  assertEq(p?.SV_HLD, 0, "SV_HLD composite present");
  assertEq(getProjection("Nobody"), null, "miss stays null");
});

// A FanGraphs Auction-Calculator export loaded into the PRESEASON slot carries
// PA/IP + Dollars but ZERO counting/rate stats. It must NOT shadow the real ROS
// line (the "Live Draft Stats view shows all-zero" bug: PA counted as "has
// stats", so getProjection returned the $-only record and never reached ROS).
section("Projections — $-only preseason record must not shadow ROS stats");
test("PA/IP-only preseason record falls through to the real ROS line", () => {
  getHitterProjections().push({ name: "Juan Soto", PA: 640, R: 0, HR: 0, RBI: 0, SB: 0, OBP: 0, fgDollars: 53 });
  getPitcherProjections().push({ name: "Tarik Skubal", IP: 190, K: 0, QS: 0, SV: 0, HLD: 0, ERA: 0, WHIP: 0, fgDollars: 28 });
  _invalidateProjIndex();
  assertEq(getProjection("Juan Soto")?.R, 108, "hitter uses ROS stats, not the zeroed preseason $-record");
  assertEq(getProjection("Juan Soto")?.OBP, 0.415, "hitter OBP from ROS");
  assertEq(getProjection("Tarik Skubal")?.K, 220, "pitcher uses ROS stats, not the zeroed preseason $-record");
});
summary();
