// Traded draft-dollar adjustments, pulled live from Jeff's published Google
// Sheet (Team, Change in Cash). A team's draft budget = $260 + its change.
// Cross-origin fetch works (Google sets access-control-allow-origin: *).

const DRAFT_DOLLARS_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQ0ScTAp4FMkVOzcMwF5MJjM49yntFXe-8EhQa__zEUV_ntVSPkLGjQW3FfII7uwOtw1MTK_OId41Fl/pub?gid=504023199&single=true&output=csv";
const DRAFT_DOLLARS_KEY = "ud_draft_dollars_v1";

let _draftDollars = {};      // teamId -> change in cash ($, signed)
let _draftDollarsAt = null;

// Sheet names that don't exactly match our owner labels.
const _DD_ALIAS = { glicksman: "glix", zack: "klin" };

function _ddNorm(s) { return String(s || "").toLowerCase().replace(/\s+/g, " ").trim(); }

// Map a sheet "Team" name to our internal team id.
function _ddResolveTeamId(name) {
  const n = _ddNorm(name);
  if (_DD_ALIAS[n]) return _DD_ALIAS[n];
  for (const t of LEAGUE.teams) if (_ddNorm(t.owner) === n) return t.id;
  for (const t of LEAGUE.teams) { const o = _ddNorm(t.owner); if (o.startsWith(n) || n.startsWith(o)) return t.id; }
  return null;
}

function _parseDraftDollars(csv) {
  const rows = (typeof parseCSV === "function") ? parseCSV(csv) : [];
  const out = {};
  for (const r of rows) {
    const name = r.Team || r.team || r.Owner || r.owner;
    if (!name) continue;
    const id = _ddResolveTeamId(name);
    if (!id) { console.warn("draft-dollars: unmatched team", name); continue; }
    const raw = r["Change in Cash"] != null ? r["Change in Cash"] : (r.Change || r.Cash || "0");
    const v = parseFloat(String(raw).replace(/[$,\s]/g, ""));
    out[id] = isFinite(v) ? v : 0;
  }
  return out;
}

function _loadDDFromCache() {
  try {
    const c = JSON.parse(localStorage.getItem(DRAFT_DOLLARS_KEY) || "null");
    if (c && c.data) { _draftDollars = c.data; _draftDollarsAt = c.at || null; }
  } catch (e) { /* ignore */ }
}

async function loadDraftDollars() {
  try {
    const r = await fetch(DRAFT_DOLLARS_URL, { cache: "no-store" });
    if (!r.ok) throw new Error("draft dollars → " + r.status);
    const data = _parseDraftDollars(await r.text());
    _draftDollars = data;
    _draftDollarsAt = new Date().toISOString();
    localStorage.setItem(DRAFT_DOLLARS_KEY, JSON.stringify({ data, at: _draftDollarsAt }));
  } catch (e) {
    console.warn("loadDraftDollars:", e.message || e);
    if (!Object.keys(_draftDollars).length) _loadDDFromCache();
  }
  return _draftDollars;
}

function getDraftDollarAdjustment(teamId) { return _draftDollars[teamId] || 0; }
function getDraftDollarsUpdatedAt() { return _draftDollarsAt; }

_loadDDFromCache();   // seed from cache; refresh async on startup
