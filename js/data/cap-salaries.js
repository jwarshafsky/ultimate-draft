// Per-player luxury-tax salaries from Jeff's published salary-cap tracker —
// the same CSV both Chrome extensions read. The tracker's Apps Script resolves
// acquisition CHAINS that ESPN's per-entry acquisitionType can't: a FAAB
// pickup keeps a $1 cap salary even after being traded onward, while a drafted
// player's trade carries his auction price. Keeper pricing uses exactly one
// bit of this: acquisitionType TRADE + $1 cap salary = FAAB-chain player → $6.
//
// Cross-origin fetch works (Google sets access-control-allow-origin: *).
// Refetchable cache — deliberately NOT in the device-sync whitelist.

const CAP_SALARY_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQFC_MfVGEmcv1IAjKNYipNC5vKQRGbb-bYwSxE9R4DWSCtO9Qw8JVkUz2SJwzvYezbDGebvx2fsNCj/pub?gid=1045339023&single=true&output=csv";
const CAP_SALARY_KEY = "ud_cap_salaries_v1";
const CAP_SALARY_FRESH_MS = 6 * 60 * 60 * 1000;   // published CSV changes rarely; 6h is plenty

let _capSalaries = null;     // { normalizedName: salary } or null before first load
let _capSalariesAt = null;
let _capSalariesLoading = false;

function _capNorm(s) {
  return (typeof normalizePlayerName === "function")
    ? normalizePlayerName(s) : String(s || "").toLowerCase();
}

// The sheet has no header row for the player columns — each data row is
// `owner,player,salary,salary,...` with team-total columns tacked on the
// right. Keep any row whose 2nd column is a name and 3rd parses as a number.
function _parseCapSalaries(csv) {
  const out = {};
  for (const line of String(csv || "").split(/\r?\n/)) {
    const cols = line.split(",").map(c => c.replace(/^"|"$/g, "").trim());
    if (cols.length < 3 || !cols[1]) continue;
    const v = parseFloat(cols[2]);
    if (!isFinite(v)) continue;
    out[_capNorm(cols[1])] = v;
  }
  return out;
}

function _loadCapSalariesFromCache() {
  try {
    const c = JSON.parse(localStorage.getItem(CAP_SALARY_KEY) || "null");
    if (c && c.map) { _capSalaries = c.map; _capSalariesAt = c.at || null; }
  } catch (e) {}
}

async function loadCapSalaries(force) {
  if (_capSalariesLoading) return _capSalaries;
  if (_capSalaries === null) _loadCapSalariesFromCache();
  const fresh = _capSalariesAt && (Date.now() - new Date(_capSalariesAt).getTime()) < CAP_SALARY_FRESH_MS;
  if (_capSalaries && !force && fresh) return _capSalaries;
  _capSalariesLoading = true;
  try {
    const r = await fetch(CAP_SALARY_URL, { cache: "no-store" });
    if (!r.ok) throw new Error("cap sheet responded " + r.status);
    const map = _parseCapSalaries(await r.text());
    if (Object.keys(map).length) {          // never clobber the cache with an empty parse
      _capSalaries = map;
      _capSalariesAt = new Date().toISOString();
      try { localStorage.setItem(CAP_SALARY_KEY, JSON.stringify({ map, at: _capSalariesAt })); } catch (e) {}
    }
  } catch (e) {
    // Offline / sheet unreachable → keep whatever cache we have.
  } finally {
    _capSalariesLoading = false;
  }
  return _capSalaries;
}

// Sync lookup for keeper pricing. Returns the cap salary as a number, or
// null when the sheet has never loaded or doesn't list the player.
function capSheetSalary(name) {
  if (_capSalaries === null) _loadCapSalariesFromCache();
  if (!_capSalaries) return null;
  const v = _capSalaries[_capNorm(name)];
  return typeof v === "number" ? v : null;
}
