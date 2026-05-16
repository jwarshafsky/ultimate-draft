// Statcast / Baseball Savant data layer. User imports CSVs from
// baseballsavant.mlb.com (Custom Leaderboards). We keep a name-indexed map of
// expected stats and surface them in Values, Board, and Live Draft views.
//
// Recommended exports from Savant:
//   Hitters: Name, Team, Year, BBE, EV, LA, Barrel%, HardHit%, xBA, xSLG, xwOBA, xwOBAcon
//   Pitchers: Name, Team, Year, IP, K%, BB%, EV, Barrel%, xERA, xBA, xSLG, xwOBA
//
// Players are matched by name (Savant uses "Last, First" → we normalize).

const STATCAST_HIT_KEY = "ud_savant_hit_v1";
const STATCAST_PIT_KEY = "ud_savant_pit_v1";

const _statcast = {
  hitters: {}, // { normalizedName: { xBA, xSLG, xwOBA, Barrel, HardHit, EV, ... } }
  pitchers: {},
};

function loadStatcastFromStorage() {
  try {
    _statcast.hitters = JSON.parse(localStorage.getItem(STATCAST_HIT_KEY) || "{}");
    _statcast.pitchers = JSON.parse(localStorage.getItem(STATCAST_PIT_KEY) || "{}");
  } catch (e) {
    _statcast.hitters = {};
    _statcast.pitchers = {};
  }
}

function saveStatcastToStorage() {
  localStorage.setItem(STATCAST_HIT_KEY, JSON.stringify(_statcast.hitters));
  localStorage.setItem(STATCAST_PIT_KEY, JSON.stringify(_statcast.pitchers));
}

// "Smith, Will" → "Will Smith"; "Will Smith" → "Will Smith".
function normalizeName(raw) {
  if (!raw) return "";
  const s = String(raw).trim();
  if (s.includes(",")) {
    const [last, first] = s.split(",").map(p => p.trim());
    return first + " " + last;
  }
  return s;
}

function normKey(name) { return normalizeName(name).toLowerCase().replace(/[^a-z0-9]/g, ""); }

function importStatcastHittersCSV(text) {
  const rows = parseCSV(text);
  let added = 0;
  for (const r of rows) {
    const raw = r["last_name, first_name"] || r["Name"] || r["Player"] || r["player_name"];
    if (!raw) continue;
    const key = normKey(raw);
    _statcast.hitters[key] = {
      name: normalizeName(raw),
      xBA:    toNum(r["xba"] || r["xBA"] || r["est_ba"]),
      xSLG:   toNum(r["xslg"] || r["xSLG"] || r["est_slg"]),
      xwOBA:  toNum(r["xwoba"] || r["xwOBA"] || r["est_woba"]),
      wOBA:   toNum(r["woba"] || r["wOBA"]),
      barrel: toNum(r["brl_percent"] || r["barrel_batted_rate"] || r["Barrel%"] || r["Brl%"]),
      hardHit:toNum(r["hard_hit_percent"] || r["HardHit%"]),
      EV:     toNum(r["avg_hit_speed"] || r["exit_velocity_avg"] || r["EV"]),
      LA:     toNum(r["avg_hit_angle"] || r["launch_angle_avg"] || r["LA"]),
    };
    added++;
  }
  saveStatcastToStorage();
  setStatus("projections", document.getElementById("status-projections")?.textContent.replace(/ \+ savant.*/, "") + " + savant " + added + " hit", "ok");
  if (typeof rerender === "function") rerender();
  return added;
}

function importStatcastPitchersCSV(text) {
  const rows = parseCSV(text);
  let added = 0;
  for (const r of rows) {
    const raw = r["last_name, first_name"] || r["Name"] || r["Player"] || r["player_name"];
    if (!raw) continue;
    const key = normKey(raw);
    _statcast.pitchers[key] = {
      name: normalizeName(raw),
      xERA:   toNum(r["xera"] || r["xERA"]),
      xBA:    toNum(r["xba"] || r["xBA"]),
      xSLG:   toNum(r["xslg"] || r["xSLG"]),
      xwOBA:  toNum(r["xwoba"] || r["xwOBA"]),
      K_pct:  toNum(r["k_percent"] || r["K%"]),
      BB_pct: toNum(r["bb_percent"] || r["BB%"]),
      barrel: toNum(r["brl_percent"] || r["barrel_batted_rate"] || r["Barrel%"] || r["Brl%"]),
      EV:     toNum(r["avg_hit_speed"] || r["exit_velocity_avg"]),
    };
    added++;
  }
  saveStatcastToStorage();
  setStatus("projections", document.getElementById("status-projections")?.textContent.replace(/ \+ savant.*/, "") + " + savant " + added + " pit", "ok");
  if (typeof rerender === "function") rerender();
  return added;
}

function clearStatcast() {
  _statcast.hitters = {};
  _statcast.pitchers = {};
  saveStatcastToStorage();
  if (typeof rerender === "function") rerender();
}

function getStatcast(playerName) {
  const k = normKey(playerName);
  return _statcast.hitters[k] || _statcast.pitchers[k] || null;
}

function statcastBuySell(playerName) {
  const sc = getStatcast(playerName);
  if (!sc) return null;
  // Hitter signal: xwOBA - wOBA (positive = buy-low candidate)
  if (sc.xwOBA && sc.wOBA) {
    const delta = sc.xwOBA - sc.wOBA;
    if (delta > 0.015) return { signal: "buy", reason: "xwOBA " + sc.xwOBA.toFixed(3) + " > wOBA " + sc.wOBA.toFixed(3) + " (under-performing — regress up)" };
    if (delta < -0.015) return { signal: "sell", reason: "xwOBA " + sc.xwOBA.toFixed(3) + " < wOBA " + sc.wOBA.toFixed(3) + " (over-performing — regress down)" };
  }
  return null;
}

loadStatcastFromStorage();
