// My keeper picks — Jeff's OWN keeper decisions and predictions. Separate from
// the league-website marks (keeper_selections in Supabase). For his own team
// these are his choices; for the other 11 teams they're his predictions. Local
// only (single user), persisted to localStorage.
//
// Shape: { [teamId]: { [playerName]: { picked: bool, ineligible: bool } } }
//   picked     — Jeff thinks/decides this player is a keeper
//   ineligible — manual override: not keepable (e.g. FA added after the trade
//                deadline, a case we can't detect from draft history alone)
//
// Also stores the keepers-page projection-source preference.

const MYKEEPERS_KEY = "ud_my_keepers_v1";
const MYKEEPERS_SRC_KEY = "ud_my_keepers_src_v1";

const _myKeepers = { teams: {} };
let _myKeepersSource = null;

function loadMyKeepers() {
  try {
    const v = JSON.parse(localStorage.getItem(MYKEEPERS_KEY) || "null");
    if (v && v.teams) _myKeepers.teams = v.teams;
  } catch (e) { /* ignore */ }
  _myKeepersSource = localStorage.getItem(MYKEEPERS_SRC_KEY) || null;
}

function saveMyKeepers() {
  localStorage.setItem(MYKEEPERS_KEY, JSON.stringify(_myKeepers));
}

function _myTeam(teamId) {
  if (!_myKeepers.teams[teamId]) _myKeepers.teams[teamId] = {};
  return _myKeepers.teams[teamId];
}

// --- Accessors ---

function getMyKeeper(teamId, name) {
  return (_myKeepers.teams[teamId] || {})[name] || null;
}

function isMyKeeper(teamId, name) {
  return !!getMyKeeper(teamId, name)?.picked;
}

function isMyIneligible(teamId, name) {
  return !!getMyKeeper(teamId, name)?.ineligible;
}

// All player names Jeff has marked as keepers for a team.
function getMyTeamPicks(teamId) {
  const t = _myKeepers.teams[teamId] || {};
  return Object.keys(t).filter(n => t[n].picked);
}

// --- Mutators (persist + re-render) ---

function setMyKeeper(teamId, name, picked) {
  const t = _myTeam(teamId);
  if (!t[name]) t[name] = { picked: false, ineligible: false };
  t[name].picked = !!picked;
  // Clean up fully-empty entries to keep storage tidy.
  if (!t[name].picked && !t[name].ineligible) delete t[name];
  saveMyKeepers();
}

function setMyIneligible(teamId, name, ineligible) {
  const t = _myTeam(teamId);
  if (!t[name]) t[name] = { picked: false, ineligible: false };
  t[name].ineligible = !!ineligible;
  if (!t[name].picked && !t[name].ineligible) delete t[name];
  saveMyKeepers();
}

// Effective keeper set for the whole app's inflation/budget math: ONLY Jeff's
// PREDICTED keepers count (the players he's checked off), excluding any he
// flagged ineligible. This is deliberately NOT backfilled from the league-site
// marks — so before he checks anyone, the set is empty and inflation reads 1.00,
// then rises as he adds keepers. (The league-site marks still show, for
// reference, in the Keepers page "League" column via getKeeperSelections.)
// Shape matches getKeeperSelections(): { teamId: { name: { keeper, minorKeeper } } }.
function getEffectiveKeeperSelections() {
  const league = (typeof getKeeperSelections === "function") ? getKeeperSelections() : {};
  const out = {};
  for (const tid of Object.keys(_myKeepers.teams)) {
    const lg = league[tid] || {};
    const picks = getMyTeamPicks(tid).filter(n => !isMyIneligible(tid, n));
    if (!picks.length) continue;
    out[tid] = {};
    for (const name of picks) {
      // Minor (cost $0) if the league site flags it minor; else a major keeper.
      const minor = !!(lg[name] && lg[name].minorKeeper);
      out[tid][name] = { keeper: !minor, minorKeeper: minor, rule5: false, tradeBlock: false };
    }
  }
  return out;
}

// --- Prospect / dynasty values for minor-league keepers ---------------------
// MiL prospects have no auction projection, so the 8 ML keeper slots showed a
// Value and the 10 MiL slots showed nothing. Here Jeff assigns a dynasty-$
// estimate (his own read) plus an optional ETA (years to MLB); present value
// discounts the dynasty $ for time-to-arrival, so MiL keepers become rankable
// like ML keepers. Keyed by player name — a prospect's value is the same on any
// roster.

const PROSPECTS_KEY = "ud_prospect_values_v1";
const _prospects = {};                 // { [name]: { dyn: number, eta: number } }
const PROSPECT_ETA_DISCOUNT = 0.82;    // value retained per extra year to MLB

function loadProspectValues() {
  try {
    const v = JSON.parse(localStorage.getItem(PROSPECTS_KEY) || "null");
    if (v && typeof v === "object") for (const k in v) _prospects[k] = v[k];
  } catch (e) { /* ignore */ }
}

function getProspectValue(name) {
  const p = _prospects[name];
  return (p && (p.dyn > 0 || p.eta > 0)) ? p : null;
}

// Dynasty $ discounted for ETA (years to MLB). ETA 1 (or unset) = full value;
// each additional year multiplies by PROSPECT_ETA_DISCOUNT. Null if no estimate.
function prospectPresentValue(name) {
  const p = _prospects[name];
  if (!p || !(p.dyn > 0)) return null;
  const eta = p.eta > 0 ? p.eta : 1;
  return p.dyn * Math.pow(PROSPECT_ETA_DISCOUNT, Math.max(0, eta - 1));
}

function setProspectValue(name, dyn, eta) {
  if (!name) return;
  const d = Number(dyn), e = Number(eta);
  const entry = {};
  if (isFinite(d) && d > 0) entry.dyn = d;
  if (isFinite(e) && e > 0) entry.eta = e;
  if (entry.dyn || entry.eta) _prospects[name] = entry;
  else delete _prospects[name];
  localStorage.setItem(PROSPECTS_KEY, JSON.stringify(_prospects));
}

// --- Projection-source preference (keepers page) ---

function getKeeperProjSource() { return _myKeepersSource; }
function setKeeperProjSource(sourceId) {
  _myKeepersSource = sourceId || null;
  if (sourceId) localStorage.setItem(MYKEEPERS_SRC_KEY, sourceId);
  else localStorage.removeItem(MYKEEPERS_SRC_KEY);
  // Source drives valuation app-wide — recompute so every tab reflects it,
  // no matter which tab changed it.
  if (typeof refreshValues === "function") refreshValues();
}

loadMyKeepers();
loadProspectValues();
