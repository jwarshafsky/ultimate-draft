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
    _invalidateProjIndex();
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

// Import-time garbage guard (R17). A stats file whose every row parses to
// all-zero stat columns is almost always the WRONG file in the slot (Jeff once
// dropped an auction-$ CSV into the stats importer — names parsed, every stat 0,
// and those zero records then shadowed his real ROS projections everywhere).
// `statKeys` are the meaningful columns for the store; a row "has stats" if any
// is a finite non-zero number. Returns { total, zeroRows, allZero, ratio }.
function summarizeStatRows(rows, statKeys) {
  let zeroRows = 0;
  for (const r of rows) {
    const has = statKeys.some(k => { const v = r[k]; return v != null && isFinite(v) && Number(v) !== 0; });
    if (!has) zeroRows++;
  }
  const total = rows.length;
  return { total, zeroRows, allZero: total > 0 && zeroRows === total, ratio: total ? zeroRows / total : 0 };
}

// Throws (blocks the save) if EVERY row is stat-less; returns a non-empty warning
// string if >30% are (store-but-warn); returns "" when clean. Shared by every
// stats importer so the guard is identical in spirit everywhere (R17).
function assertStatsNotGarbage(entries, statKeys, label) {
  const s = summarizeStatRows(entries, statKeys);
  if (s.allZero) {
    throw new Error("These " + s.total + " " + (label || "rows") +
      " have names but NO stats — every stat column is zero or missing. " +
      "Did you upload a dollar-values file into the stats slot? Nothing was saved.");
  }
  if (s.ratio > 0.30) {
    return "\n\n⚠ " + s.zeroRows + " of " + s.total + " " + (label || "rows") +
      " have no stats (all-zero). They were saved, but check you uploaded the right file.";
  }
  return "";
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
  // Block an all-zero stats upload before it can shadow good projections (R17).
  // Skip the check when the file is purely a $-values file (every row carried an
  // fgDollars) — that's a legitimate FG Auction Calculator export, not garbage.
  const dollarOnly = out.length > 0 && dollarHits === out.length;
  if (!dollarOnly) assertStatsNotGarbage(out, ["R", "HR", "RBI", "SB", "PA", "OBP"], "hitters");
  _projections.hitters = out;
  _invalidateProjIndex();
  if (dollarHits > 0) console.log("Imported " + dollarHits + " FanGraphs hitter dollar values");
  _projections.meta = {
    source: sourceName || _projections.meta.source || "manual",
    importedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
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
  // Block an all-zero stats upload before it can shadow good projections (R17).
  const dollarOnly = out.length > 0 && dollarHits === out.length;
  if (!dollarOnly) assertStatsNotGarbage(out, ["QS", "K", "IP", "SV", "HLD", "ERA"], "pitchers");
  _projections.pitchers = out;
  _invalidateProjIndex();
  if (dollarHits > 0) console.log("Imported " + dollarHits + " FanGraphs pitcher dollar values");
  _projections.meta = {
    source: sourceName || _projections.meta.source || "manual",
    importedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
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
  _invalidateProjIndex();
  saveProjectionsToStorage();
  setStatus("projections", "none", "warn");
  fireProj();
}

function getHitterProjections() { return _projections.hitters; }
function getPitcherProjections() { return _projections.pitchers; }
function getProjectionMeta() { return _projections.meta; }

// Lazily-built normalized-name index for the preseason store, so a keeper whose
// name differs only by accent / suffix / middle initial (e.g. "José Berríos" vs
// "Jose Berrios") still matches its projection. Without this, an exact-string
// lookup silently returned null and the player contributed 0 to every category
// (the reported "kept SP shows 0 QS" bug). Mirrors the ROS _buildIndex fuzzy
// match. Invalidated whenever the store changes (see _invalidateProjIndex).
let _projNameIdx = null;
function _buildProjNameIndex() {
  const idx = { exact: new Map(), core: new Map() };
  if (typeof normalizePlayerName !== "function") return idx;   // normalizer not loaded yet
  const add = (p, type) => {
    const rec = { rec: p, type };
    const k = normalizePlayerName(p.name);
    if (k && !idx.exact.has(k)) idx.exact.set(k, rec);
    if (typeof coreNameKey === "function") {
      const ck = coreNameKey(p.name);
      if (ck && !idx.core.has(ck)) idx.core.set(ck, rec);
    }
  };
  for (const p of _projections.hitters) add(p, "H");
  for (const p of _projections.pitchers) add(p, "P");
  return idx;
}
function _invalidateProjIndex() { _projNameIdx = null; }

// A matched record with NO real stats must not shadow the ROS fallback below.
// Jeff's preseason slot held an upload that parsed with all-zero stat columns
// (names fine, every number 0) — those records won every lookup and made the
// whole app project 0 R / 0 QS while his ROS sources were fully loaded (R17).
function _projHasStats(rec, type) {
  const ks = type === "H" ? ["R", "HR", "RBI", "SB", "PA", "OBP"] : ["QS", "K", "IP", "SV", "HLD", "ERA"];
  return ks.some(k => { const v = rec[k]; return v != null && isFinite(v) && Number(v) !== 0; });
}

function getProjection(name) {
  const h = _projections.hitters.find(p => p.name === name);
  if (h && _projHasStats(h, "H")) return { ...h, type: "H" };
  const p = _projections.pitchers.find(p => p.name === name);
  if (p && _projHasStats(p, "P")) return { ...p, type: "P" };
  // Fuzzy (normalized) match against the preseason store — rescues accent /
  // suffix / middle-initial mismatches that the exact lookup above misses. This
  // is the common cause of a kept SP projecting 0 QS/K when preseason is the
  // active source (no ROS source to fall through to).
  if (typeof normalizePlayerName === "function") {
    if (!_projNameIdx) _projNameIdx = _buildProjNameIndex();
    const key = normalizePlayerName(name);
    let hit = _projNameIdx.exact.get(key);
    if (!hit && typeof coreNameKey === "function") hit = _projNameIdx.core.get(coreNameKey(name));
    if (hit && _projHasStats(hit.rec, hit.type)) return { ...hit.rec, type: hit.type };
  }
  // In-season the preseason store is empty — the Data tab's ROS sources are
  // the live projections. Look for STATS across ALL stats-bearing sources, not
  // just the active one: the active source is often $-ONLY (auction values with
  // no stat rows), so reading only it returned null and every category/standings
  // stat came up blank while a stats source sat right there (R17).
  if (typeof getRosLineAnySource === "function") {
    const rh = getRosLineAnySource(name, "H");
    if (rh) return rh;                                     // carries type:"H"
    const rp = getRosLineAnySource(name, "P");
    if (rp) return { ...rp, SV_HLD: (rp.SV || 0) + (rp.HLD || 0) };
  } else if (typeof activeProjSource === "function" && typeof getRosLine === "function") {
    const src = activeProjSource();
    if (src && src !== "preseason") {
      const rh = getRosLine(src, name, "H");
      if (rh) return rh;
      const rp = getRosLine(src, name, "P");
      if (rp) return { ...rp, SV_HLD: (rp.SV || 0) + (rp.HLD || 0) };
    }
  }
  return null;
}

// Load on startup so we have data before the first render.
loadProjectionsFromStorage();
