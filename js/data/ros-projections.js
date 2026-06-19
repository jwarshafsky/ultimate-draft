// Rest-of-season (ROS) projections layer. Separate from the preseason
// FanGraphs projections in projections.js (which drives valuation). These feed
// the in-season Standings analyzer's "Projected" mode: each rostered player's
// final line = YTD actuals (ESPN) + ROS projection (chosen source here).
//
// Three interchangeable sources, each imported as a FanGraphs CSV:
//   Steamer ROS · THE BAT X ROS · ATC ROS
// Reuses parseCSV / pickCol / toNum from projections.js (loaded earlier).

const ROS_SOURCES = [
  { id: "steamer_ros", label: "Steamer ROS" },
  { id: "batx_ros",    label: "THE BAT X ROS" },
  { id: "atc_ros",     label: "ATC ROS" },
];

const _ros = {
  // sourceId -> { hitters:[], pitchers:[], importedAt }
  data: {},
  // sourceId -> { H: Map(normName->line), P: Map(...) } built lazily
  index: {},
};

function _rosKey(sourceId) { return "ud_ros_" + sourceId + "_v1"; }

// Name normalizer for matching ESPN fullName ↔ projection Name. Strips accents,
// punctuation, and common suffixes so "José Ramírez" == "Jose Ramirez" and
// "Ronald Acuna Jr." == "Ronald Acuna".
function normalizePlayerName(s) {
  if (!s) return "";
  let n = String(s).normalize("NFD").replace(/[̀-ͯ]/g, ""); // drop accents
  n = n.toLowerCase().replace(/[.'`’]/g, "").replace(/[^a-z0-9 ]/g, " ");
  n = n.replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "");
  return n.replace(/\s+/g, " ").trim();
}

function loadRosFromStorage() {
  for (const s of ROS_SOURCES) {
    try {
      const raw = JSON.parse(localStorage.getItem(_rosKey(s.id)) || "null");
      if (raw && (raw.hitters || raw.pitchers)) {
        _ros.data[s.id] = { hitters: raw.hitters || [], pitchers: raw.pitchers || [], importedAt: raw.importedAt || null };
      }
    } catch (e) { console.warn("ROS load failed for " + s.id, e); }
  }
}

function _saveRos(sourceId) {
  const d = _ros.data[sourceId];
  if (d) localStorage.setItem(_rosKey(sourceId), JSON.stringify(d));
  delete _ros.index[sourceId]; // invalidate
}

function _ensureSource(sourceId) {
  if (!_ros.data[sourceId]) _ros.data[sourceId] = { hitters: [], pitchers: [], importedAt: null };
  return _ros.data[sourceId];
}

// Import hitters CSV for a source. Captures the components the standings engine
// can use (raw when present, else it falls back to OBP×PA).
function importRosHitters(sourceId, text) {
  const rows = parseCSV(text);
  const out = [];
  for (const r of rows) {
    const name = pickCol(r, ["Name", "Player", "name", "PlayerName"]);
    if (!name) continue;
    out.push({
      name,
      R: toNum(pickCol(r, ["R"])), HR: toNum(pickCol(r, ["HR"])),
      RBI: toNum(pickCol(r, ["RBI"])), SB: toNum(pickCol(r, ["SB"])),
      OBP: toNum(pickCol(r, ["OBP"])),
      PA: toNum(pickCol(r, ["PA"])), AB: toNum(pickCol(r, ["AB"])),
      H: toNum(pickCol(r, ["H"])), BB: toNum(pickCol(r, ["BB"])),
      HBP: toNum(pickCol(r, ["HBP"])), SF: toNum(pickCol(r, ["SF"])),
    });
  }
  const d = _ensureSource(sourceId);
  d.hitters = out;
  d.importedAt = new Date().toISOString();
  _saveRos(sourceId);
  fireData && fireData();
  return out.length;
}

// Import pitchers CSV for a source. P_H / P_BB are hits/walks allowed.
function importRosPitchers(sourceId, text) {
  const rows = parseCSV(text);
  const out = [];
  for (const r of rows) {
    const name = pickCol(r, ["Name", "Player", "name", "PlayerName"]);
    if (!name) continue;
    out.push({
      name,
      K: toNum(pickCol(r, ["SO", "K"])), QS: toNum(pickCol(r, ["QS"])),
      SV: toNum(pickCol(r, ["SV", "S"])), HLD: toNum(pickCol(r, ["HLD", "HD"])),
      IP: toNum(pickCol(r, ["IP"])), ERA: toNum(pickCol(r, ["ERA"])), WHIP: toNum(pickCol(r, ["WHIP"])),
      ER: toNum(pickCol(r, ["ER"])), HA: toNum(pickCol(r, ["H"])), BBA: toNum(pickCol(r, ["BB"])),
    });
  }
  const d = _ensureSource(sourceId);
  d.pitchers = out;
  d.importedAt = new Date().toISOString();
  _saveRos(sourceId);
  fireData && fireData();
  return out.length;
}

function clearRosSource(sourceId) {
  delete _ros.data[sourceId];
  delete _ros.index[sourceId];
  localStorage.removeItem(_rosKey(sourceId));
  fireData && fireData();
}

function _buildIndex(sourceId) {
  const d = _ros.data[sourceId];
  const idx = { H: new Map(), P: new Map() };
  if (d) {
    for (const h of d.hitters) idx.H.set(normalizePlayerName(h.name), h);
    for (const p of d.pitchers) idx.P.set(normalizePlayerName(p.name), p);
  }
  _ros.index[sourceId] = idx;
  return idx;
}

// Get a ROS line for a player by name + type ("H"|"P"), normalized to the
// shape standings.js consumes. Returns null if no match.
function getRosLine(sourceId, name, type) {
  if (!_ros.data[sourceId]) return null;
  const idx = _ros.index[sourceId] || _buildIndex(sourceId);
  const key = normalizePlayerName(name);
  if (type === "P") {
    const p = idx.P.get(key);
    if (!p) return null;
    return { name: p.name, type: "P", K: p.K, QS: p.QS, SV: p.SV, HLD: p.HLD,
      IP: p.IP, ER: p.ER || null, HA: p.HA || null, BBA: p.BBA || null, ERA: p.ERA, WHIP: p.WHIP };
  }
  const h = idx.H.get(key);
  if (!h) return null;
  return { name: h.name, type: "H", R: h.R, HR: h.HR, RBI: h.RBI, SB: h.SB,
    OBP: h.OBP, PA: h.PA, AB: h.AB || null, H: h.H || null, BB: h.BB || null,
    HBP: h.HBP || null, SF: h.SF || null };
}

function rosHasData(sourceId) {
  const d = _ros.data[sourceId];
  return !!(d && (d.hitters.length || d.pitchers.length));
}
function getRosCounts(sourceId) {
  const d = _ros.data[sourceId];
  return { hitters: d?.hitters.length || 0, pitchers: d?.pitchers.length || 0, importedAt: d?.importedAt || null };
}
function getRosSourceLabel(sourceId) {
  return (ROS_SOURCES.find(s => s.id === sourceId) || {}).label || sourceId;
}
function firstLoadedRosSource() {
  const s = ROS_SOURCES.find(s => rosHasData(s.id));
  return s ? s.id : null;
}

// --- Hosted projections (one-click load) --------------------------------
// The repo ships CSVs under projections/ that a scheduled job refreshes from
// FanGraphs. Loading them is a same-origin fetch — no CORS, no FanGraphs
// account, no manual download.
const ROS_HOSTED_PATH = "projections/";

async function _fetchCsv(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(url + " → " + r.status);
  return r.text();
}

// Manual-override flag: when the user uploads their own CSV for a source, we
// stop auto-overwriting it with the hosted/live data.
function setRosManual(sourceId, isManual) {
  const d = _ensureSource(sourceId);
  d.manual = !!isManual;
  _saveRos(sourceId);
}
function rosIsManual(sourceId) { return !!_ros.data[sourceId]?.manual; }
function getRosUpdated(sourceId) { return _ros.data[sourceId]?.updated || null; }

// Load one hosted source (bat + pit) into its ROS store. Marks it as live
// (not a manual override) and stamps the manifest's updated date.
async function fetchHostedRos(sourceId, updated) {
  const base = ROS_HOSTED_PATH + sourceId;
  const [bat, pit] = await Promise.all([
    _fetchCsv(base + "_bat.csv"),
    _fetchCsv(base + "_pit.csv"),
  ]);
  const h = importRosHitters(sourceId, bat);
  const p = importRosPitchers(sourceId, pit);
  const d = _ensureSource(sourceId);
  d.manual = false;
  if (updated) d.updated = updated;
  _saveRos(sourceId);
  return { hitters: h, pitchers: p };
}

// Load every hosted source (explicit "Load latest" — re-enables auto for all).
async function loadAllHostedRos() {
  const manifest = await fetchRosManifest();
  const out = {};
  for (const s of ROS_SOURCES) {
    try { out[s.id] = await fetchHostedRos(s.id, manifest?.[s.id]?.updated); }
    catch (e) { out[s.id] = { error: e.message || String(e) }; }
  }
  return out;
}

// Auto-populate hosted projections as the default — but never clobber a source
// the user manually uploaded, and skip sources already at the latest date.
// Returns true if anything was (re)loaded. Safe to call on every startup.
async function autoloadHostedRos() {
  const manifest = await fetchRosManifest();
  if (!manifest) return false;
  let changed = false;
  for (const s of ROS_SOURCES) {
    const m = manifest[s.id];
    if (!m) continue;
    if (rosIsManual(s.id)) continue;                       // user override wins
    if (rosHasData(s.id) && getRosUpdated(s.id) === m.updated) continue; // current
    try { await fetchHostedRos(s.id, m.updated); changed = true; }
    catch (e) { /* file missing / offline — keep whatever we have */ }
  }
  return changed;
}

// Read the hosted manifest (labels / counts / last-updated date) if present.
async function fetchRosManifest() {
  try {
    const r = await fetch(ROS_HOSTED_PATH + "manifest.json", { cache: "no-store" });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

loadRosFromStorage();
