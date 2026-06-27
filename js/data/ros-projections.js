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

// Pull a projected auction dollar value from a parsed CSV row, if the source
// includes one (FanGraphs Auction Calculator ROS exports do). Returns null when
// absent so the keepers page can fall back to the preseason valuation.
const _DOLLAR_COLS = ["Dollars", "$", "Auction $", "Value", "Dollar Value", "PV", "ProjValue"];
function _pickDollars(row) {
  const raw = pickCol(row, _DOLLAR_COLS);
  if (raw == null || raw === "") return null;
  const n = parseFloat(String(raw).replace(/[$,]/g, ""));
  return isFinite(n) ? n : null;
}
// Same, for a FanGraphs API JSON object (numeric fields).
const _DOLLAR_KEYS = ["Dollars", "mDollars", "auctionDollars", "PlayerDollars", "$"];
function _pickDollarsJSON(o) {
  for (const k of _DOLLAR_KEYS) {
    const v = o[k];
    if (typeof v === "number" && isFinite(v)) return v;
    if (typeof v === "string" && v !== "") {
      const n = parseFloat(v.replace(/[$,]/g, ""));
      if (isFinite(n)) return n;
    }
  }
  return null;
}

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

// "Core" key: first + last name only, dropping middle initials. Used as a
// fallback so "Jose Ferrer" (ESPN) matches "Jose A. Ferrer" (FanGraphs).
function coreNameKey(name) {
  const toks = normalizePlayerName(name).split(" ").filter(Boolean);
  if (toks.length <= 2) return toks.join(" ");
  const mids = toks.slice(1, -1).filter(t => t.length > 1);   // keep real middle names, drop initials
  return [toks[0], ...mids, toks[toks.length - 1]].join(" ");
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
      dollars: _pickDollars(r),
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
      SV: toNum(pickCol(r, ["SV", "S"])), HLD: toNum(pickCol(r, ["HLD", "HD"])), GS: toNum(pickCol(r, ["GS"])),
      IP: toNum(pickCol(r, ["IP"])), ERA: toNum(pickCol(r, ["ERA"])), WHIP: toNum(pickCol(r, ["WHIP"])),
      ER: toNum(pickCol(r, ["ER"])), HA: toNum(pickCol(r, ["H"])), BBA: toNum(pickCol(r, ["BB"])),
      dollars: _pickDollars(r),
    });
  }
  const d = _ensureSource(sourceId);
  d.pitchers = out;
  d.importedAt = new Date().toISOString();
  _saveRos(sourceId);
  fireData && fireData();
  return out.length;
}

// FanGraphs API "type" slug per source, for the browser-paste workflow. The
// user opens these in their own browser (residential, no ban risk — FanGraphs
// blocks automated/datacenter fetching), copies the JSON, and pastes it in.
// In-season ATC is published as "ATC DC (RoS)" → slug ratcdc (verified).
const FG_API_SLUG = { steamer_ros: "steamerr", batx_ros: "rthebatx", atc_ros: "ratcdc" };

function fangraphsApiUrl(sourceId, stats) {
  const slug = FG_API_SLUG[sourceId] || "steamerr";
  return "https://www.fangraphs.com/api/projections?type=" + slug +
    "&stats=" + (stats === "pit" ? "pit" : "bat") + "&pos=all&team=0&players=0&lg=all";
}

// Import projections pasted as raw FanGraphs API JSON (an array of player rows).
// kind = "bat" | "pit". Returns the row count.
// A complete FanGraphs ROS list has well over this many players; fewer almost
// always means a truncated paste.
const ROS_MIN_EXPECTED = { bat: 700, pit: 450 };
function importRosJSON(sourceId, kind, text) {
  const t = (text || "").trim();
  let arr;
  try { arr = JSON.parse(t); }
  catch (e) {
    // A long blob that doesn't close with ']' was almost certainly cut off.
    if (t.length > 2000 && !t.endsWith("]") && !t.endsWith("}")) {
      throw new Error("This looks cut off (truncated) — the FanGraphs JSON is too big to paste reliably. Save the page to a file (⌘S) and use the file picker instead.");
    }
    throw new Error("That isn't valid JSON. Open the link, select all (⌘A), copy, and paste the whole page — or use the file picker.");
  }
  if (!Array.isArray(arr)) arr = Array.isArray(arr?.data) ? arr.data : null;
  if (!arr) throw new Error("Expected a JSON list of players from the FanGraphs API link.");
  const n = (o, k) => { const v = o[k]; return (typeof v === "number" && isFinite(v)) ? v : 0; };
  const nm = o => o.PlayerName || o.Name;
  const d = _ensureSource(sourceId);
  if (kind === "pit") {
    d.pitchers = arr.filter(nm).map(o => ({
      name: nm(o), K: n(o, "SO"), QS: n(o, "QS"), SV: n(o, "SV"), HLD: n(o, "HLD"), GS: n(o, "GS"),
      IP: n(o, "IP"), ERA: n(o, "ERA"), WHIP: n(o, "WHIP"), ER: n(o, "ER"), HA: n(o, "H"), BBA: n(o, "BB"),
      dollars: _pickDollarsJSON(o),
    }));
  } else {
    d.hitters = arr.filter(nm).map(o => ({
      name: nm(o), R: n(o, "R"), HR: n(o, "HR"), RBI: n(o, "RBI"), SB: n(o, "SB"), OBP: n(o, "OBP"),
      PA: n(o, "PA"), AB: n(o, "AB"), H: n(o, "H"), BB: n(o, "BB"), HBP: n(o, "HBP"), SF: n(o, "SF"),
      dollars: _pickDollarsJSON(o),
    }));
  }
  d.importedAt = new Date().toISOString();
  d.updated = new Date().toISOString().slice(0, 10);
  _saveRos(sourceId);
  fireData && fireData();
  return kind === "pit" ? d.pitchers.length : d.hitters.length;
}

// Warning string if an import count is suspiciously low (likely truncated /
// wrong link), else "". Shown after import.
function rosImportWarning(kind, count) {
  const min = ROS_MIN_EXPECTED[kind === "pit" ? "pit" : "bat"];
  if (count < min) {
    return "\n\n⚠ Only " + count + " players imported — a full FanGraphs list has many more. " +
      "This source may be incomplete (truncated paste, or a position-filtered link). " +
      "Check “Projection coverage” on the Standings tab.";
  }
  return "";
}

function clearRosSource(sourceId) {
  delete _ros.data[sourceId];
  delete _ros.index[sourceId];
  localStorage.removeItem(_rosKey(sourceId));
  fireData && fireData();
}

function _buildIndex(sourceId) {
  const d = _ros.data[sourceId];
  // H/P = exact normalized name; Hc/Pc = core key (no middle initials) fallback.
  const idx = { H: new Map(), P: new Map(), Hc: new Map(), Pc: new Map() };
  if (d) {
    // On duplicate keys, keep the bigger projection (the real regular over a
    // minor-league namesake) instead of last-wins.
    for (const h of d.hitters) {
      const k = normalizePlayerName(h.name), ex = idx.H.get(k);
      if (!ex || (h.PA || 0) > (ex.PA || 0)) idx.H.set(k, h);
      const ck = coreNameKey(h.name), exc = idx.Hc.get(ck);
      if (!exc || (h.PA || 0) > (exc.PA || 0)) idx.Hc.set(ck, h);
    }
    for (const p of d.pitchers) {
      const k = normalizePlayerName(p.name), ex = idx.P.get(k);
      if (!ex || (p.IP || 0) > (ex.IP || 0)) idx.P.set(k, p);
      const ck = coreNameKey(p.name), exc = idx.Pc.get(ck);
      if (!exc || (p.IP || 0) > (exc.IP || 0)) idx.Pc.set(ck, p);
    }
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
    const p = idx.P.get(key) || idx.Pc.get(coreNameKey(name));   // fallback: drop middle initials
    if (!p) return null;
    return { name: p.name, type: "P", K: p.K, QS: p.QS, SV: p.SV, HLD: p.HLD, GS: p.GS || 0,
      IP: p.IP, ER: p.ER || null, HA: p.HA || null, BBA: p.BBA || null, ERA: p.ERA, WHIP: p.WHIP };
  }
  const h = idx.H.get(key) || idx.Hc.get(coreNameKey(name));   // fallback: drop middle initials
  if (!h) return null;
  return { name: h.name, type: "H", R: h.R, HR: h.HR, RBI: h.RBI, SB: h.SB,
    OBP: h.OBP, PA: h.PA, AB: h.AB || null, H: h.H || null, BB: h.BB || null,
    HBP: h.HBP || null, SF: h.SF || null };
}

// Import a standalone "Name, $" CSV of FanGraphs projected auction values for a
// source — separate from the stats import, since FG publishes $ in the Auction
// Calculator export. Stored as a name→$ map and merged at lookup time.
function importRosDollars(sourceId, text) {
  const rows = parseCSV(text);
  const d = _ensureSource(sourceId);
  d.dollarsByName = d.dollarsByName || {};
  let n = 0;
  for (const r of rows) {
    const name = pickCol(r, ["Name", "Player", "PlayerName", "name"]);
    const dol = _pickDollars(r);
    if (name && dol != null) { d.dollarsByName[normalizePlayerName(name)] = dol; n++; }
  }
  _saveRos(sourceId);
  fireData && fireData();
  return n;
}

// Projected auction dollar value for a player in a given source. type "H"|"P"
// (or omit to try both). Checks per-record dollars first, then a separately
// uploaded name→$ map. Returns null when no $ is on file for the player.
function getRosDollar(sourceId, name, type) {
  const d = _ros.data[sourceId];
  if (!d) return null;
  const idx = _ros.index[sourceId] || _buildIndex(sourceId);
  const key = normalizePlayerName(name), ck = coreNameKey(name);
  let rec;
  if (type === "P") rec = idx.P.get(key) || idx.Pc.get(ck);
  else if (type === "H") rec = idx.H.get(key) || idx.Hc.get(ck);
  else rec = idx.H.get(key) || idx.P.get(key) || idx.Hc.get(ck) || idx.Pc.get(ck);
  if (rec && typeof rec.dollars === "number") return rec.dollars;
  if (d.dollarsByName) {
    const v = d.dollarsByName[key];
    if (typeof v === "number") return v;
  }
  return null;
}

// True if this source includes any projected dollar values (record-level or
// separately uploaded).
function rosHasDollars(sourceId) {
  const d = _ros.data[sourceId];
  if (!d) return false;
  if (d.dollarsByName && Object.keys(d.dollarsByName).length) return true;
  return (d.hitters || []).some(h => typeof h.dollars === "number") ||
         (d.pitchers || []).some(p => typeof p.dollars === "number");
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
