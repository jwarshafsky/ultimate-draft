// Telegram bot (proxy/) — league-data assembly + webhook flow, fully offline.
// Patches global fetch so ESPN / Anthropic / Telegram / GH Pages calls hit
// fixtures, and stubs the UD_SYNC KV binding. The proxy files are ES modules
// (proxy/package.json type:module), so they're loaded via dynamic import().
const { test, section, summary, assert, assertEq } = require("./helpers.js");
const path = require("path");

const YEAR = new Date().getFullYear();

// --- fixtures --------------------------------------------------------------

function statEntry(sourceId, stats) {
  return { statSourceId: sourceId, statSplitTypeId: 0, seasonId: YEAR, stats };
}
// Hitter stats map: R(20) HR(5) RBI(21) SB(23) OBP(17) PA(16) AB(0) H(1) BB(10) HBP(12) SF(13)
function hStats(m) {
  return { "20": m.R, "5": m.HR, "21": m.RBI, "23": m.SB, "17": m.OBP, "16": m.PA,
    "0": m.AB, "1": m.H, "10": m.BB, "12": m.HBP || 2, "13": m.SF || 2 };
}
// Pitcher: K(48) QS(63) SV(57) HLD(60) OUTS(34) ER(45) HA(37) BBA(39) ERA(47) WHIP(41) GS(33)
function pStats(m) {
  return { "48": m.K, "63": m.QS, "57": m.SV || 0, "60": m.HLD || 0, "34": m.IP * 3,
    "45": m.ER, "37": m.HA, "39": m.BBA, "47": m.ERA, "41": m.WHIP, "33": m.GS || 0 };
}
function hitter(name, ytd, proj, lineupSlotId) {
  return {
    lineupSlotId: lineupSlotId != null ? lineupSlotId : 3,
    playerPoolEntry: { player: {
      id: Math.floor(Math.random() * 1e6), fullName: name, defaultPositionId: 5,
      eligibleSlots: [3, 7, 12, 16, 17], injuryStatus: "ACTIVE",
      stats: [statEntry(0, hStats(ytd)), statEntry(1, hStats(proj))],
    } },
  };
}
function pitcher(name, ytd, proj, lineupSlotId) {
  return {
    lineupSlotId: lineupSlotId != null ? lineupSlotId : 13,
    playerPoolEntry: { player: {
      id: Math.floor(Math.random() * 1e6), fullName: name, defaultPositionId: 1,
      eligibleSlots: [13, 14, 16, 17], injuryStatus: "ACTIVE",
      stats: [statEntry(0, pStats(ytd)), statEntry(1, pStats(proj))],
    } },
  };
}
// Team YTD totals (valuesByStat) roughly consistent with the roster fixtures.
function vbs(h, p) {
  return { ...hStats(h), ...pStats(p) };
}

// Three teams — ESPN ids 5 (jeff), 1 (matt), 12 (dave).
const H = { R: 45, HR: 14, RBI: 48, SB: 9, OBP: 0.355, PA: 320, AB: 285, H: 88, BB: 30 };
const HP = { R: 38, HR: 12, RBI: 40, SB: 6, OBP: 0.340, PA: 310, AB: 280, H: 82, BB: 26 };
const P = { K: 95, QS: 10, IP: 90, ER: 32, HA: 75, BBA: 25, ERA: 3.20, WHIP: 1.11, GS: 15 };
const PP = { K: 80, QS: 8, IP: 82, ER: 35, HA: 78, BBA: 30, ERA: 3.84, WHIP: 1.32, GS: 14 };

const ESPN_PAYLOAD = {
  teams: [
    { id: 5, abbrev: "Jeff", valuesByStat: vbs({ ...H, R: 300, HR: 90, RBI: 310, SB: 60 }, { ...P, K: 600, QS: 55, IP: 560 }),
      points: 22, roster: { entries: [
        hitter("Bobby Witt Jr.", H, { ...H, R: 95, HR: 30, RBI: 100, SB: 25, PA: 660, AB: 590, H: 185, BB: 60 }),
        hitter("Bryce Harper", HP, { ...HP, R: 85, HR: 28, RBI: 90, PA: 620, AB: 560, H: 170, BB: 55 }),
        pitcher("Logan Gilbert", P, { ...P, K: 200, QS: 22, IP: 190, ER: 68, HA: 160, BBA: 50, GS: 31 }),
        pitcher("Chris Sale", PP, { ...PP, K: 180, QS: 19, IP: 175, GS: 29 }),
      ] } },
    { id: 1, abbrev: "MV3", valuesByStat: vbs({ ...H, R: 320, HR: 100, RBI: 330, SB: 45 }, { ...P, K: 580, QS: 60, IP: 570 }),
      points: 24, roster: { entries: [
        hitter("Matt Chapman", HP, { ...HP, R: 80, HR: 26, RBI: 85, PA: 600, AB: 545, H: 160, BB: 50 }),
        hitter("Cal Raleigh", H, { ...H, R: 88, HR: 34, RBI: 95, SB: 4, PA: 630, AB: 570, H: 175, BB: 55 }),
        pitcher("Paul Skenes", P, { ...P, K: 230, QS: 25, IP: 200, ER: 58, HA: 140, BBA: 45, ERA: 2.61, WHIP: 0.93, GS: 32 }),
        pitcher("Garrett Crochet", PP, { ...PP, K: 190, QS: 20, IP: 180, GS: 30 }),
      ] } },
    { id: 12, abbrev: "Dave", valuesByStat: vbs({ ...H, R: 280, HR: 80, RBI: 290, SB: 70 }, { ...P, K: 550, QS: 50, IP: 540 }),
      points: 18, roster: { entries: [
        hitter("Julio Rodriguez", H, { ...H, R: 90, HR: 27, RBI: 92, SB: 22, PA: 640, AB: 580, H: 178, BB: 52 }),
        hitter("Jazz Chisholm Jr.", HP, { ...HP, R: 78, HR: 24, RBI: 80, SB: 20, PA: 590, AB: 535, H: 155, BB: 48 }),
        pitcher("Yoshinobu Yamamoto", P, { ...P, K: 195, QS: 21, IP: 185, GS: 30 }),
        pitcher("Tarik Skubal", PP, { ...PP, K: 210, QS: 23, IP: 190, GS: 31 }),
      ] } },
  ],
};

// FanGraphs-style ROS rows (the shape ros-projections.js stores). One rostered
// player (Tarik Skubal) is deliberately missing → coverage 11/12.
const ROS_KV = {
  hitters: [
    { name: "Bobby Witt Jr.", R: 50, HR: 16, RBI: 52, SB: 14, OBP: 0.365, PA: 340, AB: 305, H: 98, BB: 32 },
    { name: "Bryce Harper", R: 44, HR: 15, RBI: 47, SB: 3, OBP: 0.372, PA: 320, AB: 285, H: 88, BB: 33 },
    { name: "Matt Chapman", R: 40, HR: 13, RBI: 44, SB: 2, OBP: 0.330, PA: 310, AB: 282, H: 78, BB: 26 },
    { name: "Cal Raleigh", R: 45, HR: 18, RBI: 50, SB: 2, OBP: 0.345, PA: 325, AB: 295, H: 85, BB: 28 },
    { name: "Julio Rodríguez", R: 47, HR: 14, RBI: 48, SB: 12, OBP: 0.350, PA: 330, AB: 300, H: 92, BB: 27 },
    { name: "Jazz Chisholm Jr.", R: 40, HR: 12, RBI: 41, SB: 11, OBP: 0.335, PA: 300, AB: 272, H: 76, BB: 25 },
  ],
  pitchers: [
    { name: "Logan Gilbert", K: 105, QS: 12, SV: 0, HLD: 0, GS: 16, IP: 100, ER: 36, HA: 84, BBA: 26, ERA: 3.24, WHIP: 1.10 },
    { name: "Chris Sale", K: 95, QS: 10, SV: 0, HLD: 0, GS: 15, IP: 92, ER: 38, HA: 86, BBA: 30, ERA: 3.72, WHIP: 1.26 },
    { name: "Paul Skenes", K: 120, QS: 14, SV: 0, HLD: 0, GS: 17, IP: 105, ER: 30, HA: 74, BBA: 24, ERA: 2.57, WHIP: 0.93 },
    { name: "Garrett Crochet", K: 100, QS: 11, SV: 0, HLD: 0, GS: 16, IP: 95, ER: 39, HA: 82, BBA: 30, ERA: 3.69, WHIP: 1.18 },
    { name: "Yoshinobu Yamamoto", K: 102, QS: 11, SV: 0, HLD: 0, GS: 16, IP: 97, ER: 36, HA: 80, BBA: 28, ERA: 3.34, WHIP: 1.11 },
  ],
};

// Snippet in the-league data.js format (contracts parser fixture).
const DATA_JS_SNIPPET = `
const LEAGUE_DATA = {
  season: 2026,
  teams: [
    {
      id: "jeff",
      name: "Jeff",
      majors: [
        { name: "Bryce Harper", price: 24, yearAcquired: 2023, fromMinors: false },
        { name: "Bobby Witt Jr.", price: 49, yearAcquired: 2024, fromMinors: false }
      ],
      callups: [],
      minors: [
        { name: "Roch Cholowsky", yearAcquired: 2026, careerStat: 0, statType: "AB" }
      ],
    },
    {
      id: "matt",
      name: "Matt",
      majors: [
        { name: "Cal Raleigh", price: 31, yearAcquired: 2025, fromMinors: false }
      ],
      callups: [
        { name: "Some Callup", yearAcquired: 2024, careerStat: 0, statType: "AB" }
      ],
      minors: [],
    }
  ]
};
`;

// --- stubs ------------------------------------------------------------------

function makeKV(initial) {
  const store = new Map(Object.entries(initial || {}));
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, String(v)); },
    async list({ prefix }) {
      const keys = [...store.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name }));
      return { keys, list_complete: true };
    },
  };
}

// Routes fetch() by hostname; records telegram + anthropic traffic.
function patchFetch(state) {
  global.fetch = async (url, opts) => {
    const u = String(url);
    const ok = (body) => ({ ok: true, status: 200,
      json: async () => body, text: async () => JSON.stringify(body) });
    if (u.includes("lm-api-reads.fantasy.espn.com")) return ok(ESPN_PAYLOAD);
    if (u.includes("jwarshafsky.github.io/the-league/js/data.js")) {
      return { ok: true, status: 200, text: async () => DATA_JS_SNIPPET, json: async () => ({}) };
    }
    if (u.includes("api.anthropic.com")) {
      state.anthropicCalls.push(JSON.parse(opts.body));
      const resp = state.anthropicScript.shift();
      if (!resp) throw new Error("anthropic script exhausted");
      return ok(resp);
    }
    if (u.includes("api.telegram.org")) {
      const method = u.split("/").pop();
      state.telegramCalls.push({ method, payload: JSON.parse(opts.body) });
      return ok({ ok: true });
    }
    throw new Error("unexpected fetch in test: " + u);
  };
}

// --- tests -------------------------------------------------------------------

// NOTE: helpers.test() is synchronous — every await happens OUT here, in
// sequence, and each test() body only asserts on already-settled results.
(async () => {
  const proxyDir = path.join(__dirname, "..", "proxy");
  const LD = await import(path.join(proxyDir, "league-data.js"));

  const state = { telegramCalls: [], anthropicCalls: [], anthropicScript: [] };
  patchFetch(state);

  const kv = makeKV({ "u:test-user:ud_ros_steamer_ros_v1": JSON.stringify(ROS_KV) });
  const env = { UD_SYNC: kv, ESPN_S2: "s2", ESPN_SWID: "{swid}" };

  section("league-data: assembly");
  const league = await LD.assembleLeague(env);
  test("3 fixture teams parsed with pools + YTD lines", () => {
    assertEq(Object.keys(league.pools).length, 3);
    assertEq(Object.keys(league.ytdTeam).length, 3);
    assert(league.rosSource.includes("Steamer"), "ROS source should be the KV import");
  });
  test("ROS coverage counts the missing Skubal line", () => {
    assertEq(league.coverage.total, 12);
    assertEq(league.coverage.matched, 11);
  });
  test("accented KV name matches ESPN name (Julio Rodríguez)", () => {
    const dave = league.pools.dave.find(p => p.name === "Julio Rodriguez");
    assert(dave && dave.ros, "Julio should have a ROS line despite the accent");
  });

  section("league-data: projected standings");
  const report = LD.projectedStandingsReport(league, 500);
  test("projected + current tables with odds fields", () => {
    assertEq(report.projectedFinal.length, 3);
    assertEq(report.currentYTD.length, 3);
    const top = report.projectedFinal[0];
    assert(top.rotoPoints > 0, "roto points positive");
    assert(/%$/.test(top.pFirst) || top.pFirst === "<1%", "pFirst formatted");
    assert(top.cats.OBP.includes("pt)"), "per-cat value+points present");
  });
  test("YTD standings ranked by roto points", () => {
    const pts = report.currentYTD.map(t => t.rotoPoints);
    assert(pts[0] >= pts[1] && pts[1] >= pts[2], "sorted descending");
  });

  section("league-data: trade simulation");
  const sim = LD.simulateTradeReport(league, {
    team_a: "Jeff", team_a_sends: ["Bobby Witt Jr."],
    team_b: "Matt", team_b_sends: ["Matt Chapman"],
    sims: 500,
  });
  test("trade report has both sides with before/after", () => {
    assert(!sim.error, "no error: " + sim.error);
    assertEq(sim.teamA.team, "Jeff");
    assertEq(sim.teamA.sends[0], "Bobby Witt Jr.");
    assertEq(sim.teamA.receives[0], "Matt Chapman");
    assert(typeof sim.teamA.rotoPoints.delta === "number");
    assert(sim.leagueAfter.length === 3);
  });
  test("downgrade trade doesn't raise Jeff's projected points", () => {
    // Witt >> Chapman in every category — delta must be <= 0.
    assert(sim.teamA.rotoPoints.delta <= 0, "delta was " + sim.teamA.rotoPoints.delta);
  });
  test("player-on-wrong-team is rejected with a clear error", () => {
    const bad = LD.simulateTradeReport(league, {
      team_a: "Jeff", team_a_sends: ["Paul Skenes"], team_b: "Matt", team_b_sends: [],
    });
    assert(bad.error && bad.error.includes("Matt"), "got: " + bad.error);
  });
  test("unknown player yields suggestions-style error", () => {
    const bad = LD.simulateTradeReport(league, {
      team_a: "Jeff", team_a_sends: ["Nonexistent Guy"], team_b: "Matt", team_b_sends: [],
    });
    assert(bad.error && bad.error.includes("not found"), "got: " + bad.error);
  });

  section("league-data: rosters, players, teams");
  test("resolveTeam handles labels, partials, and JD split", () => {
    assertEq(LD.resolveTeam("jeff"), "jeff");
    assertEq(LD.resolveTeam("Glicksman"), "glix");
    assertEq(LD.resolveTeam("doug"), "jd");
    assertEq(LD.resolveTeam("j"), null); // ambiguous
  });
  test("rosterReport lists players with YTD + ROS flag", () => {
    const r = LD.rosterReport(league, "Dave");
    assertEq(r.team, "Dave");
    assertEq(r.players.length, 4);
    const skubal = r.players.find(p => p.name === "Tarik Skubal");
    assertEq(skubal.hasRosProjection, false);
  });
  test("playerReport finds a player fuzzily", () => {
    const p = LD.playerReport(league, "witt");
    assertEq(p.team, "Jeff");
    assert(p.restOfSeasonProjection && p.restOfSeasonProjection.PA === 340);
  });

  section("league-data: contracts parser");
  const contracts = await LD.contractsReport(env, "Jeff");
  const mattContracts = await LD.contractsReport(env, "Matt");
  test("data.js contracts parsed with prices + sections", () => {
    assertEq(contracts.majors.length, 2);
    assertEq(contracts.majors[0].name, "Bryce Harper");
    assertEq(contracts.majors[0].price, 24);
    assertEq(contracts.minors[0].name, "Roch Cholowsky");
    assertEq(contracts.callups.length, 0);
  });
  test("inline-empty callups don't swallow the next section", () => {
    assertEq(mattContracts.callups.length, 1);
    assertEq(mattContracts.callups[0].name, "Some Callup");
  });

  section("telegram: webhook flow");
  const TG = await import(path.join(proxyDir, "telegram.js"));
  const tgEnv = { ...env, TELEGRAM_BOT_TOKEN: "tok", TELEGRAM_WEBHOOK_SECRET: "sekret",
    TELEGRAM_ALLOWED_CHAT_IDS: "111", ANTHROPIC_API_KEY: "key" };
  const mkReq = (body, secret) => ({
    headers: { get: (h) => h.toLowerCase() === "x-telegram-bot-api-secret-token" ? secret : null },
    json: async () => body,
  });
  const bg = [];
  const ctx = { waitUntil: (p) => bg.push(p) };
  const drainBg = () => Promise.all(bg.splice(0));

  // wrong secret
  const r403 = await TG.handleTelegram(mkReq({}, "nope"), tgEnv, ctx);
  test("wrong webhook secret → 403", () => assertEq(r403.status, 403));

  // non-allowlisted chat
  state.telegramCalls.length = 0;
  const rDenied = await TG.handleTelegram(mkReq(
    { update_id: 1, message: { text: "hi", chat: { id: 999 }, from: { first_name: "X" } } },
    "sekret"), tgEnv, ctx);
  await drainBg();
  const deniedSent = state.telegramCalls.find(c => c.method === "sendMessage");
  test("non-allowlisted chat gets the chat-id hint", () => {
    assertEq(rDenied.status, 200);
    assert(deniedSent && deniedSent.payload.text.includes("999"), "chat id hint sent");
  });

  // full question → tool loop → answer
  state.telegramCalls.length = 0;
  state.anthropicCalls.length = 0;
  state.anthropicScript = [
    { stop_reason: "tool_use", content: [
      { type: "text", text: "Let me check." },
      { type: "tool_use", id: "tu_1", name: "get_projected_standings", input: {} },
    ] },
    { stop_reason: "end_turn", content: [
      { type: "text", text: "You project 2nd with a 24% shot at the title." },
    ] },
  ];
  const askUpdate = { update_id: 2, message: { text: "where do I finish?", chat: { id: 111 }, from: { first_name: "Jeff" } } };
  const rAsk = await TG.handleTelegram(mkReq(askUpdate, "sekret"), tgEnv, ctx);
  await drainBg();
  const askCalls = state.telegramCalls.slice();
  const anthropicCalls = state.anthropicCalls.slice();
  test("full question → Claude tool loop → answer sent", () => {
    assertEq(rAsk.status, 200);
    assertEq(anthropicCalls.length, 2);
    const toolResultMsg = anthropicCalls[1].messages.at(-1);
    assertEq(toolResultMsg.role, "user");
    assertEq(toolResultMsg.content[0].type, "tool_result");
    assert(toolResultMsg.content[0].content.includes("projectedFinal"), "tool result payload present");
    const sent = askCalls.filter(c => c.method === "sendMessage").at(-1);
    assert(sent.payload.text.includes("24%"), "final answer relayed to Telegram");
  });
  test("claude request uses opus + adaptive thinking + tools", () => {
    const req = anthropicCalls[0];
    assertEq(req.model, "claude-opus-4-8");
    assertEq(req.thinking.type, "adaptive");
    assert(req.tools.length >= 6, "tools attached");
    assert(req.system.includes("keeper"), "system prompt present");
  });

  // duplicate delivery (Telegram retry) is a no-op
  state.telegramCalls.length = 0;
  await TG.handleTelegram(mkReq(askUpdate, "sekret"), tgEnv, ctx);
  await drainBg();
  const dupCalls = state.telegramCalls.length;
  test("duplicate update_id is ignored (Telegram retry)", () => assertEq(dupCalls, 0));

  section("worker: module wiring");
  const W = await import(path.join(proxyDir, "worker.js"));
  test("worker.js imports cleanly with the new routes", () => {
    assert(typeof W.default.fetch === "function");
  });

  summary("Telegram bot (proxy)");
})();
