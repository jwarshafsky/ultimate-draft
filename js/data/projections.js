// Projections layer — manages player projection imports (FanGraphs CSV) and
// persists them to localStorage. The valuation engine reads from here.

const PROJ_HITTER_KEY = "ud_proj_hitters_v1";
const PROJ_PITCHER_KEY = "ud_proj_pitchers_v1";
const PROJ_META_KEY = "ud_proj_meta_v1";

const _projections = {
  hitters: [],   // [{ name, team, pos, PA, AB, H, R, HR, RBI, SB, BB, OBP, AVG }]
  pitchers: [],  // [{ name, team, pos, IP, K, QS, W, SV, HLD, ERA, WHIP }]
  meta: { source: null, importedAt: null, hitterCount: 0, pitcherCount: 0 },
};

const _projListeners = [];
function onProjectionsChange(fn) {
  _projListeners.push(fn);
  fn(_projections);
}
function fireProj() {
  _projListeners.forEach(fn => { try { fn(_projections); } catch (e) { console.error(e); } });
}

function loadProjectionsFromStorage() {
  try {
    const h = JSON.parse(localStorage.getItem(PROJ_HITTER_KEY) || "[]");
    const p = JSON.parse(localStorage.getItem(PROJ_PITCHER_KEY) || "[]");
    const m = JSON.parse(localStorage.getItem(PROJ_META_KEY) || "null") || _projections.meta;
    _projections.hitters = Array.isArray(h) ? h : [];
    _projections.pitchers = Array.isArray(p) ? p : [];
    _projections.meta = m;
    if (_projections.hitters.length || _projections.pitchers.length) {
      setStatus("projections", `${_projections.hitters.length} hit / ${_projections.pitchers.length} pit`, "ok");
    } else {
      setStatus("projections", "none", "warn");
    }
  } catch (e) {
    console.warn("projection load failed:", e);
    setStatus("projections", "load error", "bad");
  }
}

function saveProjectionsToStorage() {
  localStorage.setItem(PROJ_HITTER_KEY, JSON.stringify(_projections.hitters));
  localStorage.setItem(PROJ_PITCHER_KEY, JSON.stringify(_projections.pitchers));
  localStorage.setItem(PROJ_META_KEY, JSON.stringify(_projections.meta));
}

// Parses a CSV string. Handles quoted fields. Returns array of objects keyed by header.
function parseCSV(text) {
  const rows = [];
  let row = []; let cell = ""; let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i+1] === '"') { cell += '"'; i++; }
      else if (c === '"') { inQ = false; }
      else cell += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") { row.push(cell); cell = ""; }
      else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
      else if (c === "\r") { /* skip */ }
      else cell += c;
    }
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows[0].map(h => h.trim());
  return rows.slice(1).filter(r => r.length && r.some(c => c.length))
    .map(r => {
      const o = {};
      headers.forEach((h, i) => { o[h] = r[i] != null ? r[i].trim() : ""; });
      return o;
    });
}

const HIT_HEADER_MAP = {
  name: ["Name", "Player", "name", "PlayerName"],
  team: ["Team", "team", "Tm"],
  pos:  ["POS", "Pos", "Position", "pos"],
  PA: ["PA"], AB: ["AB"], H: ["H"], R: ["R"], HR: ["HR"],
  RBI: ["RBI"], SB: ["SB"], BB: ["BB"], OBP: ["OBP"], AVG: ["AVG"],
  // FanGraphs Auction Calculator output gives pre-computed dollar values:
  dollars: ["Dollars", "$", "Auction $", "Value", "Dollar Value"],
};
const PIT_HEADER_MAP = {
  name: ["Name", "Player", "name", "PlayerName"],
  team: ["Team", "team", "Tm"],
  pos:  ["POS", "Pos", "Position", "pos"],
  IP: ["IP"], K: ["SO", "K"], W: ["W"], QS: ["QS"], SV: ["SV", "S"],
  HLD: ["HLD", "HD"], ERA: ["ERA"], WHIP: ["WHIP"],
  dollars: ["Dollars", "$", "Auction $", "Value", "Dollar Value"],
};

function pickCol(row, names) {
  for (const n of names) if (row[n] != null && row[n] !== "") return row[n];
  return null;
}
function toNum(v) {
  if (v == null || v === "") return 0;
  const n = parseFloat(String(v).replace(/,/g, ""));
  return isFinite(n) ? n : 0;
}

function importHittersCSV(text, sourceName) {
  const rows = parseCSV(text);
  const out = [];
  let dollarHits = 0;
  for (const r of rows) {
    const name = pickCol(r, HIT_HEADER_MAP.name);
    if (!name) continue;
    const dollars = pickCol(r, HIT_HEADER_MAP.dollars);
    const entry = {
      name: name,
      team: pickCol(r, HIT_HEADER_MAP.team) || "",
      pos:  pickCol(r, HIT_HEADER_MAP.pos) || "",
      PA: toNum(pickCol(r, HIT_HEADER_MAP.PA)),
      AB: toNum(pickCol(r, HIT_HEADER_MAP.AB)),
      H:  toNum(pickCol(r, HIT_HEADER_MAP.H)),
      R:  toNum(pickCol(r, HIT_HEADER_MAP.R)),
      HR: toNum(pickCol(r, HIT_HEADER_MAP.HR)),
      RBI: toNum(pickCol(r, HIT_HEADER_MAP.RBI)),
      SB: toNum(pickCol(r, HIT_HEADER_MAP.SB)),
      BB: toNum(pickCol(r, HIT_HEADER_MAP.BB)),
      OBP: toNum(pickCol(r, HIT_HEADER_MAP.OBP)),
      AVG: toNum(pickCol(r, HIT_HEADER_MAP.AVG)),
    };
    // If FanGraphs Auction Calculator dollar value is present, store it.
    // Valuation engine will prefer it over its own SGP-based calc.
    if (dollars != null && dollars !== "") {
      const d = toNum(dollars);
      if (d !== 0 || /[0-9]/.test(String(dollars))) {
        entry.fgDollars = d;
        dollarHits++;
      }
    }
    out.push(entry);
  }
  _projections.hitters = out;
  if (dollarHits > 0) console.log("Imported " + dollarHits + " FanGraphs hitter dollar values");
  _projections.meta = {
    source: sourceName || _projections.meta.source || "manual",
    importedAt: new Date().toISOString(),
    hitterCount: out.length,
    pitcherCount: _projections.pitchers.length,
  };
  saveProjectionsToStorage();
  setStatus("projections", `${out.length} hit / ${_projections.pitchers.length} pit`, "ok");
  fireProj();
  return out.length;
}

function importPitchersCSV(text, sourceName) {
  const rows = parseCSV(text);
  const out = [];
  let dollarHits = 0;
  for (const r of rows) {
    const name = pickCol(r, PIT_HEADER_MAP.name);
    if (!name) continue;
    const dollars = pickCol(r, PIT_HEADER_MAP.dollars);
    const entry = {
      name: name,
      team: pickCol(r, PIT_HEADER_MAP.team) || "",
      pos:  pickCol(r, PIT_HEADER_MAP.pos) || "",
      IP: toNum(pickCol(r, PIT_HEADER_MAP.IP)),
      K: toNum(pickCol(r, PIT_HEADER_MAP.K)),
      W: toNum(pickCol(r, PIT_HEADER_MAP.W)),
      QS: toNum(pickCol(r, PIT_HEADER_MAP.QS)),
      SV: toNum(pickCol(r, PIT_HEADER_MAP.SV)),
      HLD: toNum(pickCol(r, PIT_HEADER_MAP.HLD)),
      ERA: toNum(pickCol(r, PIT_HEADER_MAP.ERA)),
      WHIP: toNum(pickCol(r, PIT_HEADER_MAP.WHIP)),
    };
    if (dollars != null && dollars !== "") {
      const d = toNum(dollars);
      if (d !== 0 || /[0-9]/.test(String(dollars))) {
        entry.fgDollars = d;
        dollarHits++;
      }
    }
    out.push(entry);
  }
  _projections.pitchers = out;
  if (dollarHits > 0) console.log("Imported " + dollarHits + " FanGraphs pitcher dollar values");
  _projections.meta = {
    source: sourceName || _projections.meta.source || "manual",
    importedAt: new Date().toISOString(),
    hitterCount: _projections.hitters.length,
    pitcherCount: out.length,
  };
  saveProjectionsToStorage();
  setStatus("projections", `${_projections.hitters.length} hit / ${out.length} pit`, "ok");
  fireProj();
  return out.length;
}

function clearProjections() {
  _projections.hitters = [];
  _projections.pitchers = [];
  _projections.meta = { source: null, importedAt: null, hitterCount: 0, pitcherCount: 0 };
  saveProjectionsToStorage();
  setStatus("projections", "none", "warn");
  fireProj();
}

function getHitterProjections() { return _projections.hitters; }
function getPitcherProjections() { return _projections.pitchers; }
function getProjectionMeta() { return _projections.meta; }
function getProjection(name) {
  const h = _projections.hitters.find(p => p.name === name);
  if (h) return { ...h, type: "H" };
  const p = _projections.pitchers.find(p => p.name === name);
  if (p) return { ...p, type: "P" };
  return null;
}

// Load on startup so we have data before the first render.
loadProjectionsFromStorage();
