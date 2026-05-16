// NFBC auction price import. NFBC publishes industry-mock and main-event
// auction values that serve as a strong consensus market price. User pastes
// or uploads a CSV; we index by name and surface as "market price" alongside
// our SGP-based dollar value.
//
// Expected columns (flexible): Name, Pos, Team, Avg$, Min$, Max$, AvgPick
// (NFBC ADP), draftCount.

const NFBC_KEY = "ud_nfbc_v1";

const _nfbc = {
  byName: {},   // { normalizedKey: { name, avg, min, max, adp, draftCount } }
  meta: { source: null, importedAt: null, count: 0 },
};

function loadNfbcFromStorage() {
  try {
    const v = JSON.parse(localStorage.getItem(NFBC_KEY) || "null");
    if (v && v.byName) { _nfbc.byName = v.byName; _nfbc.meta = v.meta || _nfbc.meta; }
  } catch (e) {}
}

function saveNfbcToStorage() {
  localStorage.setItem(NFBC_KEY, JSON.stringify({ byName: _nfbc.byName, meta: _nfbc.meta }));
}

function importNfbcCSV(text, sourceName) {
  const rows = parseCSV(text);
  let added = 0;
  const out = {};
  for (const r of rows) {
    const name = r["Name"] || r["Player"] || r["player_name"];
    if (!name) continue;
    const k = normKey(name);
    out[k] = {
      name,
      pos: r["POS"] || r["Pos"] || r["Position"] || "",
      team: r["Team"] || r["Tm"] || "",
      avg: toNum(r["Avg$"] || r["AvgPaid"] || r["Avg"] || r["Avg Price"] || r["AvgValue"]),
      min: toNum(r["Min$"] || r["MinPaid"] || r["Min"]),
      max: toNum(r["Max$"] || r["MaxPaid"] || r["Max"]),
      adp: toNum(r["ADP"] || r["AvgPick"] || r["AvgDraftPick"]),
      draftCount: toNum(r["NDC"] || r["Drafts"] || r["draftCount"] || r["#Drafts"]),
    };
    added++;
  }
  _nfbc.byName = out;
  _nfbc.meta = { source: sourceName || "NFBC", importedAt: new Date().toISOString(), count: added };
  saveNfbcToStorage();
  if (typeof rerender === "function") rerender();
  return added;
}

function getNfbc(playerName) {
  return _nfbc.byName[normKey(playerName)] || null;
}

function getNfbcMeta() { return _nfbc.meta; }

function clearNfbc() {
  _nfbc.byName = {};
  _nfbc.meta = { source: null, importedAt: null, count: 0 };
  saveNfbcToStorage();
  if (typeof rerender === "function") rerender();
}

loadNfbcFromStorage();
