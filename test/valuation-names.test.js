// Accented-name lookup (Jeff's Jul 4 mock: nominated "José Ramírez" / "Ronald
// Acuña Jr." / "Julio Rodríguez" showed "no value data" — ESPN sends accents,
// FanGraphs values don't, and getPlayerValue was exact-match only).
const { test, section, summary, assertEq, makeLocalStorageStub } = require("./helpers.js");
const fs = require("fs");

global.window = global;
global.localStorage = makeLocalStorageStub();
// minimal deps valuation.js touches at load/refresh time
global.normalizePlayerName = (s) => String(s || "").toLowerCase()
  .normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[.']/g, "").replace(/\s+/g, " ").trim();
global.onProjectionsChange = undefined; global.onDataChange = undefined;
eval(fs.readFileSync(__dirname + "/../js/core/valuation.js", "utf8"));
// valuation.js declares its own computeValues — override AFTER load so
// refreshValues uses this synthetic pool.
computeValues = () => [
  { name: "Jose Ramirez", posKey: "3B", value: 33 },
  { name: "Ronald Acuna Jr.", posKey: "OF", value: 41 },
  { name: "Julio Rodriguez", posKey: "OF", value: 38 },
];

section("Valuation — accented ESPN names resolve to FanGraphs value rows");
test("José Ramírez / Ronald Acuña Jr. / Julio Rodríguez all resolve", () => {
  assertEq(getPlayerValue("José Ramírez")?.value, 33, "Ramírez");
  assertEq(getPlayerValue("Ronald Acuña Jr.")?.value, 41, "Acuña");
  assertEq(getPlayerValue("Julio Rodríguez")?.value, 38, "J-Rod");
  assertEq(getPlayerValue("Jose Ramirez")?.value, 33, "exact still works");
  assertEq(getPlayerValue("Nobody Real"), null, "miss stays null");
});
summary();
