// Data tab — manages projection, Statcast, and NFBC market price imports.

let _dataRosSel = null; // currently-selected ROS source in the Data tab

// ---------------------------------------------------------------------------
// Data health (R17). Inventory every importable / refetchable user-data store:
// row counts, last-updated stamp (or "no stamp — old data"), and warnings —
// all-zero stats, stale-past-TTL cache, empty-but-referenced. The incident this
// prevents: a zero-stat projection upload silently shadowed good data for weeks
// because nothing flagged the store as garbage. See _projHasStats / R17.
//
// Only "flaggable" stores (refetchable caches + re-importable feeds) can be
// cleaned up. Work-product stores (keepers, notes, strategy, saved mocks, draft
// history) are Jeff's own — LISTED with age info, NEVER auto-flagged.
// ---------------------------------------------------------------------------

// Days since an ISO/date stamp, or null if no stamp.
function _dhAgeDays(stamp) {
  if (!stamp) return null;
  const t = (typeof stamp === "string" && stamp.length <= 10) ? new Date(stamp + "T12:00:00").getTime() : new Date(stamp).getTime();
  if (!isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

// All-zero-stats check over an array of stat records (the import-time garbage
// signature). statKeys are the meaningful columns. Empty array → not all-zero.
function _dhAllZero(records, statKeys) {
  if (!records || !records.length) return false;
  return records.every(r => !statKeys.some(k => { const v = r[k]; return v != null && isFinite(v) && Number(v) !== 0; }));
}

// Build the health report: { flaggable: [store…], workProduct: [store…], hosted }.
// Each store: { key, label, rows, stamp, ageDays, warnings:[], canClean }.
function buildDataHealth() {
  const flaggable = [];
  const workProduct = [];

  // --- Preseason projection store (the R17 incident's origin) ---
  const meta = (typeof getProjectionMeta === "function") ? getProjectionMeta() : {};
  const hit = (typeof getHitterProjections === "function") ? getHitterProjections() : [];
  const pit = (typeof getPitcherProjections === "function") ? getPitcherProjections() : [];
  if ((meta.hitterCount || 0) + (meta.pitcherCount || 0) > 0 || hit.length || pit.length) {
    const w = [];
    // Only flag all-zero when there are no fgDollars either (a pure $-file is valid).
    const hitStatless = _dhAllZero(hit, ["R", "HR", "RBI", "SB", "PA", "OBP"]) && !hit.some(h => h.fgDollars != null);
    const pitStatless = _dhAllZero(pit, ["QS", "K", "IP", "SV", "HLD", "ERA"]) && !pit.some(p => p.fgDollars != null);
    if (hitStatless && hit.length) w.push("hitters have names but ALL stats zero — likely a $-file in the stats slot");
    if (pitStatless && pit.length) w.push("pitchers have names but ALL stats zero — likely a $-file in the stats slot");
    flaggable.push({
      keys: ["ud_proj_hitters_v1", "ud_proj_pitchers_v1", "ud_proj_meta_v1"],
      label: "Preseason projections (" + (meta.source || "FanGraphs") + ")",
      rows: hit.length + " hit / " + pit.length + " pit",
      stamp: meta.updatedAt || meta.importedAt || null,
      ageDays: _dhAgeDays(meta.updatedAt || meta.importedAt), warnings: w,
      onClean: (typeof clearProjections === "function") ? clearProjections : null,
    });
  }

  // --- ROS sources (stats + $) ---
  for (const s of (typeof ROS_SOURCES !== "undefined" ? ROS_SOURCES : [])) {
    const has = (typeof rosHasData === "function" && rosHasData(s.id));
    const hasDol = (typeof rosHasDollars === "function" && rosHasDollars(s.id));
    if (!has && !hasDol) continue;
    const d = (typeof _ros !== "undefined" && _ros.data[s.id]) || {};
    const c = (typeof getRosCounts === "function") ? getRosCounts(s.id) : { hitters: 0, pitchers: 0 };
    const dc = (typeof getRosDollarCounts === "function") ? getRosDollarCounts(s.id) : { hitters: 0, pitchers: 0 };
    const w = [];
    if (_dhAllZero(d.hitters, ["R", "HR", "RBI", "SB", "PA", "OBP"]) && (d.hitters || []).length)
      w.push("hitter stats all zero — likely a $-file in the stats slot");
    if (_dhAllZero(d.pitchers, ["QS", "K", "IP", "SV", "HLD", "ERA"]) && (d.pitchers || []).length)
      w.push("pitcher stats all zero — likely a $-file in the stats slot");
    const stamp = d.updatedAt || d.updated || c.importedAt || null;
    const age = _dhAgeDays(stamp);
    // Drafting-season imports — flag if very stale (>60d), since a new season's
    // ROS numbers should be re-pulled well before then.
    if (age != null && age > 60) w.push("older than 60 days — refresh before drafting");
    flaggable.push({
      keys: [_rosKey(s.id)], label: s.label + " (ROS)",
      rows: c.hitters + " hit / " + c.pitchers + " pit · $" + dc.hitters + "h/" + dc.pitchers + "p",
      stamp, ageDays: age, warnings: w,
      onClean: (typeof clearRosSource === "function") ? () => { clearRosSource(s.id); } : null,
    });
  }

  // --- NFBC market prices ---
  const nfbcMeta = (typeof getNfbcMeta === "function") ? getNfbcMeta() : { count: 0 };
  if (nfbcMeta.count) {
    const recs = (typeof _nfbc !== "undefined") ? Object.values(_nfbc.byName) : [];
    const w = [];
    if (_dhAllZero(recs, ["avg", "min", "max", "adp"])) w.push("all prices/ADP zero — wrong file uploaded?");
    const age = _dhAgeDays(nfbcMeta.updatedAt || nfbcMeta.importedAt);
    if (age != null && age > 60) w.push("older than 60 days — a stale market read");
    flaggable.push({
      keys: ["ud_nfbc_v1"], label: "NFBC market prices", rows: nfbcMeta.count + " players",
      stamp: nfbcMeta.updatedAt || nfbcMeta.importedAt || null, ageDays: age, warnings: w,
      onClean: (typeof clearNfbc === "function") ? clearNfbc : null,
    });
  }

  // --- Statcast / Savant ---
  const scHit = (typeof _statcast !== "undefined") ? Object.keys(_statcast.hitters).length : 0;
  const scPit = (typeof _statcast !== "undefined") ? Object.keys(_statcast.pitchers).length : 0;
  if (scHit || scPit) {
    const recs = (typeof _statcast !== "undefined") ? Object.values(_statcast.hitters).concat(Object.values(_statcast.pitchers)) : [];
    const w = [];
    if (_dhAllZero(recs, ["xwOBA", "xBA", "xSLG", "xERA", "wOBA", "EV", "barrel"])) w.push("all expected-stats zero — wrong export uploaded?");
    const stamp = (typeof getStatcastUpdatedAt === "function") ? getStatcastUpdatedAt() : null;
    const age = _dhAgeDays(stamp);
    if (age != null && age > 60) w.push("older than 60 days — a stale Statcast read");
    flaggable.push({
      keys: ["ud_savant_hit_v1", "ud_savant_pit_v1"], label: "Statcast (Baseball Savant)",
      rows: scHit + " hit / " + scPit + " pit", stamp, ageDays: age, warnings: w,
      onClean: (typeof clearStatcast === "function") ? clearStatcast : null,
    });
  }

  // --- League rosters cache (12h TTL) ---
  if (typeof getLeagueRostersUpdatedAt === "function") {
    const at = getLeagueRostersUpdatedAt();
    if (at || localStorage.getItem("ud_league_rosters_v1")) {
      const hrs = at ? (Date.now() - new Date(at).getTime()) / 3600000 : null;
      const w = [];
      if (hrs != null && hrs > 12) w.push("older than its 12h refresh window — reload the Keepers tab");
      flaggable.push({
        keys: ["ud_league_rosters_v1"], label: "League rosters/contracts cache",
        rows: "cache", stamp: at, ageDays: _dhAgeDays(at), warnings: w,
        onClean: () => { localStorage.removeItem("ud_league_rosters_v1"); if (typeof _leagueRosters !== "undefined") { _leagueRosters = null; _leagueRostersAt = null; _leagueIdx = null; } },
      });
    }
  }

  // --- Draft-dollar sheet cache (~1d) ---
  if (typeof getDraftDollarsUpdatedAt === "function") {
    const at = getDraftDollarsUpdatedAt();
    if (at || localStorage.getItem("ud_draft_dollars_v1")) {
      const w = [];
      const age = _dhAgeDays(at);
      if (age != null && age > 1) w.push("older than a day — reload to catch traded draft dollars");
      flaggable.push({
        keys: ["ud_draft_dollars_v1"], label: "Traded draft-dollars cache",
        rows: "cache", stamp: at, ageDays: age, warnings: w,
        onClean: () => { localStorage.removeItem("ud_draft_dollars_v1"); if (typeof _draftDollars !== "undefined") { _draftDollars = {}; _draftDollarsAt = null; } },
      });
    }
  }

  // --- Hosted-feed availability (the projections/ dir is never committed) ---
  const hosted = { available: (typeof _dhHostedAvailable !== "undefined") ? _dhHostedAvailable : null };

  // --- Work product (listed, never flagged for cleanup) ---
  const wp = (label, key, count) => { if (count) workProduct.push({ label, key, rows: count }); };
  try {
    if (typeof _myKeepers !== "undefined") {
      let n = 0; for (const t in _myKeepers.teams) n += Object.keys(_myKeepers.teams[t] || {}).length;
      wp("My keeper picks/predictions", "ud_my_keepers_v1", n && (n + " marks"));
    }
    if (typeof _notes !== "undefined") wp("Player notes/tags", "ud_player_notes_v1", Object.keys(_notes.byName || {}).length && (Object.keys(_notes.byName).length + " players"));
    if (typeof getSavedMocks === "function") { const m = getSavedMocks(); wp("Saved mock drafts", "ud_saved_mocks_v1", m.length && (m.length + " mocks")); }
    if (typeof getDraftStrategy === "function") { const s = getDraftStrategy(); wp("Draft strategy", "ud_draft_strategy_v1", (s.text || s.brief) && "written"); }
  } catch (e) { /* best-effort listing */ }

  return { flaggable, workProduct, hosted };
}

// Hosted-feed availability, probed once. The repo's projections/ directory is
// never committed (scripts/fetch_ros_projections.py exists but nothing runs it),
// so the manifest fetch 404s. We surface that FACT in the panel instead of
// letting the auto-load fail silently. null = not probed yet.
let _dhHostedAvailable = null;
function probeHostedFeed() {
  if (typeof fetchRosManifest !== "function") { _dhHostedAvailable = false; return; }
  fetchRosManifest().then(m => {
    const next = !!m;
    if (next !== _dhHostedAvailable) { _dhHostedAvailable = next; if (typeof renderData === "function" && _activeTabIsData()) renderData(); }
    else _dhHostedAvailable = next;
  }).catch(() => { _dhHostedAvailable = false; });
}
function _activeTabIsData() {
  return (location.hash || "").indexOf("data") >= 0;
}

// Escape helper alias — data.js already relies on the global esc().
function renderDataHealthCard() {
  if (_dhHostedAvailable === null) probeHostedFeed();
  const rep = buildDataHealth();
  const flaggedCount = rep.flaggable.filter(s => s.warnings.length).length;

  let h = '<div class="card"><h2>Data health</h2>';
  h += '<p class="muted small">Every imported / cached data store, its freshness, and any problems. Warnings in red mean a store may be garbage or stale — the kind of thing that once silently zeroed out the whole app.</p>';

  // Hosted-feed status line.
  if (rep.hosted.available === false) {
    h += '<div class="small" style="margin-bottom:8px; color: var(--warn);">⚠ Hosted projection feed: <b>not available</b> — the refresh job isn\'t wired up, so ROS sources are <b>manual upload only</b> (paste/upload each source below).</div>';
  } else if (rep.hosted.available === true) {
    h += '<div class="small muted" style="margin-bottom:8px;">Hosted projection feed: available.</div>';
  }

  h += '<table><thead><tr><th>Store</th><th class="num">Rows</th><th>Last updated</th><th>Status</th></tr></thead><tbody>';
  for (const s of rep.flaggable) {
    const stampTxt = s.stamp
      ? esc(new Date(s.stamp).toLocaleDateString()) + (s.ageDays != null ? ' <span class="muted">(' + s.ageDays + 'd)</span>' : '')
      : '<span class="bad">no stamp — old data</span>';
    const status = s.warnings.length
      ? s.warnings.map(w => '<span class="bad">⚠ ' + esc(w) + '</span>').join('<br>')
      : '<span class="good">ok</span>';
    h += '<tr><td>' + esc(s.label) + '</td><td class="num">' + esc(String(s.rows)) + '</td><td>' + stampTxt + '</td><td>' + status + '</td></tr>';
  }
  h += '</tbody></table>';

  // Work product — listed with age, never cleanup-flagged.
  if (rep.workProduct.length) {
    h += '<div class="small muted" style="margin-top:8px;"><b>Your work (kept, never auto-cleared):</b> ' +
      rep.workProduct.map(w => esc(w.label) + ' — ' + esc(String(w.rows))).join(' · ') + '</div>';
  }

  // Cleanup button — only offered when something is actually flagged.
  if (flaggedCount) {
    h += '<div style="margin-top:12px;"><button class="btn danger" id="dh-cleanup" style="width:auto;">🧹 Clean up flagged data (' + flaggedCount + ')</button></div>';
  }
  h += '</div>';
  return h;
}

// The confirm-first cleanup flow. Lists ONLY flagged stores with per-item
// checkboxes; NEVER deletes without the confirm step. Clears localStorage +
// resets the store's in-memory copy + refreshes.
function openDataCleanup() {
  const rep = buildDataHealth();
  const flagged = rep.flaggable.filter(s => s.warnings.length && s.onClean);
  if (!flagged.length) { alert("Nothing is flagged — nothing to clean up."); return; }

  let host = document.getElementById("dh-cleanup-modal");
  if (host) host.remove();
  host = document.createElement("div");
  host.id = "dh-cleanup-modal";
  host.className = "modal-host";
  let rows = "";
  flagged.forEach((s, i) => {
    rows += '<label style="display:block; margin:6px 0;">' +
      '<input type="checkbox" class="dh-ck" data-i="' + i + '" checked> <b>' + esc(s.label) + '</b>' +
      '<div class="small bad" style="margin-left:22px;">' + s.warnings.map(esc).join('; ') + '</div></label>';
  });
  host.innerHTML =
    '<div class="modal-bg"></div><div class="modal-card">' +
    '<h3>Clean up flagged data</h3>' +
    '<p class="muted small">These stores look garbage or stale. Unchecked ones are left alone. Your keeper picks, notes, strategy, saved mocks, and draft history are never touched.</p>' +
    rows +
    '<div style="display:flex; gap:8px; margin-top:14px; justify-content:flex-end;">' +
    '<button class="btn" id="dh-cancel">Cancel</button>' +
    '<button class="btn danger" id="dh-confirm" style="width:auto; padding:8px 16px;">Clear selected</button></div></div>';
  document.body.appendChild(host);
  const close = () => host.remove();
  host.querySelector(".modal-bg").addEventListener("click", close);
  host.querySelector("#dh-cancel").addEventListener("click", close);
  host.querySelector("#dh-confirm").addEventListener("click", () => {
    const picked = Array.from(host.querySelectorAll(".dh-ck")).filter(c => c.checked).map(c => flagged[+c.dataset.i]);
    if (!picked.length) { close(); return; }
    for (const s of picked) {
      try { s.onClean(); } catch (e) { console.warn("cleanup failed for " + s.label, e); }
      // Belt-and-suspenders: ensure every backing key is gone even if onClean
      // only reset in-memory state.
      for (const k of (s.keys || [])) { try { localStorage.removeItem(k); } catch (e) {} }
    }
    if (typeof refreshValues === "function") refreshValues();
    if (typeof fireData === "function") fireData();
    close();
    if (typeof rerender === "function") rerender(); else renderData();
    alert("Cleared " + picked.length + " store" + (picked.length > 1 ? "s" : "") + ".");
  });
}

function renderData() {
  const root = document.getElementById("view-root");
  const meta = getProjectionMeta();
  const nfbcMeta = getNfbcMeta();
  const savantHit = Object.keys(_statcast.hitters).length;
  const savantPit = Object.keys(_statcast.pitchers).length;

  let html = "";

  // === Data health (R17) ===
  html += renderDataHealthCard();

  // Status block — per-source stat + dollar coverage.
  html += '<div class="card"><h2>Data Status</h2>';
  html += '<table><thead><tr><th>Source</th><th class="num">Stat projections (H / P)</th><th class="num">Dollar values (H / P)</th><th>Data as of</th></tr></thead><tbody>';
  for (const s of ROS_SOURCES) {
    const c = getRosCounts(s.id);
    const dc = (typeof getRosDollarCounts === "function") ? getRosDollarCounts(s.id) : { hitters: 0, pitchers: 0 };
    // "Data as of" = the projection's own date (manifest/import), NOT the last
    // fetch time — a dead refresh job shows up here as a reddening date.
    const upd = getRosUpdated(s.id);
    const ageDays = upd ? Math.floor((Date.now() - new Date(upd + "T12:00:00").getTime()) / 86400000) : null;
    const stale = ageDays != null && ageDays > 7;
    const updTxt = upd
      ? esc(upd) + (stale ? ' <span class="bad">(' + ageDays + 'd old)</span>' : '') +
        (rosIsManual(s.id) ? ' <span class="muted">· manual</span>' : '')
      : '<span class="muted">—</span>';
    html += '<tr><td>' + esc(s.label) + '</td>' +
      '<td class="num">' + c.hitters + ' / ' + c.pitchers + '</td>' +
      '<td class="num">' + dc.hitters + ' / ' + dc.pitchers + '</td>' +
      '<td>' + updTxt + '</td></tr>';
  }
  html += '</tbody></table>';
  html += '<div class="grid cols-2" style="margin-top:10px;">';
  html += '<div><div class="muted small">NFBC Market Prices</div><div style="font-size: 22px; font-family: var(--mono);">' + nfbcMeta.count + '</div></div>';
  html += '<div><div class="muted small">Statcast (hit / pit)</div><div style="font-size: 22px; font-family: var(--mono);">' + savantHit + ' / ' + savantPit + '</div></div>';
  html += '</div></div>';

  // Shared current source for both Stat Projections and Dollar Values.
  const rosSel = (typeof _dataRosSel !== "undefined" && _dataRosSel) || (firstLoadedRosSource() || ROS_SOURCES[0].id);
  _dataRosSel = rosSel;

  // === Stat Projections ===
  html += '<div class="card"><h2>Stat Projections</h2>';
  html += '<p class="muted small">Raw projected stats per source (Steamer / ATC / BATX). Feeds the <b>Standings</b> tab. Paste from your own browser (FanGraphs blocks automated downloads) — open each link, copy, paste. Updating every week or two is plenty.</p>';
  html += '<label class="small muted" style="display:inline-flex; align-items:center; gap:6px;">Source ' +
    '<select id="ros-src-sel">';
  for (const s of ROS_SOURCES) {
    const c = getRosCounts(s.id);
    html += '<option value="' + s.id + '"' + (s.id === rosSel ? ' selected' : '') + '>' +
      esc(s.label) + ' (' + c.hitters + ' hit / ' + c.pitchers + ' pit)</option>';
  }
  html += '</select></label>';

  // --- Paste FanGraphs JSON (primary) ---
  html += '<div class="grid cols-2" style="margin-top:8px;">';
  html += '<div><h3>Hitters</h3>';
  html += '<div class="small" style="margin-bottom:4px;"><a href="' + esc(fangraphsApiUrl(rosSel, "bat")) + '" target="_blank" rel="noopener" style="color:var(--accent);">1) Open hitters JSON ↗</a> → select all, copy</div>';
  html += '<textarea id="ros-hit-json" rows="3" style="width:100%; font-family:var(--mono); font-size:11px;" placeholder="2) paste the JSON here"></textarea>';
  html += '<div style="margin-top:6px;"><button class="btn primary" id="ros-hit-json-import" style="width:auto;">Import hitters</button> <span class="small muted">or save the page & </span><input type="file" id="ros-hit-json-file" accept=".json,.txt,application/json"></div></div>';
  html += '<div><h3>Pitchers</h3>';
  html += '<div class="small" style="margin-bottom:4px;"><a href="' + esc(fangraphsApiUrl(rosSel, "pit")) + '" target="_blank" rel="noopener" style="color:var(--accent);">1) Open pitchers JSON ↗</a> → select all, copy</div>';
  html += '<textarea id="ros-pit-json" rows="3" style="width:100%; font-family:var(--mono); font-size:11px;" placeholder="2) paste the JSON here"></textarea>';
  html += '<div style="margin-top:6px;"><button class="btn primary" id="ros-pit-json-import" style="width:auto;">Import pitchers</button> <span class="small muted">or save the page & </span><input type="file" id="ros-pit-json-file" accept=".json,.txt,application/json"></div></div>';
  html += '</div>';
  html += '<p class="small muted" style="margin-top:6px;">The JSON page should start with <code>[{"Team"…</code>. It’s large — if pasting drops players (check the <b>Projection coverage</b> on the Standings tab), instead <b>save the page</b> (⌘S / right-click → Save As) and use the file picker, which never truncates. (ATC’s in-season feed is FanGraphs’ “ATC DC (RoS)”.)</p>';

  if (rosHasData(rosSel)) {
    const c = getRosCounts(rosSel);
    html += '<div class="small muted" style="margin-top:6px;">' + esc(getRosSourceLabel(rosSel)) + ': ' +
      c.hitters + ' hitters / ' + c.pitchers + ' pitchers' +
      (c.importedAt ? ' · updated ' + new Date(c.importedAt).toLocaleDateString() : '') +
      ' <button class="btn danger" id="ros-clear" style="width:auto; padding:2px 8px; margin-left:8px;">Clear this source</button></div>';
  }

  // --- CSV import (fallback, collapsed) ---
  html += '<details style="margin-top:10px;"><summary class="small muted" style="cursor:pointer;">Advanced: import a CSV instead</summary>';
  html += '<div class="grid cols-2" style="margin-top:8px;">';
  html += '<div><textarea id="ros-hit-csv" rows="3" style="width:100%; font-family:var(--mono); font-size:11px;" placeholder="Hitters CSV: Name,PA,AB,H,R,HR,RBI,SB,BB,OBP"></textarea>';
  html += '<div style="margin-top:6px;"><button class="btn" id="ros-hit-import" style="width:auto;">Import hitters CSV</button> <input type="file" id="ros-hit-file" accept=".csv,text/csv"></div></div>';
  html += '<div><textarea id="ros-pit-csv" rows="3" style="width:100%; font-family:var(--mono); font-size:11px;" placeholder="Pitchers CSV: Name,IP,GS,SO,QS,SV,HLD,ER,H,BB,ERA,WHIP"></textarea>';
  html += '<div style="margin-top:6px;"><button class="btn" id="ros-pit-import" style="width:auto;">Import pitchers CSV</button> <input type="file" id="ros-pit-file" accept=".csv,text/csv"></div></div>';
  html += '</div></details>';
  html += '</div>';

  // === Dollar Values ===
  html += '<div class="card"><h2>Dollar Values</h2>';
  html += '<p class="muted small">FanGraphs Auction Calculator <b>$</b> per source, split hitters / pitchers — drives the Keepers page <b>Predicted $</b> / Value. Open the calculator (your exact league settings baked in), click <b>Export Data</b> for hitters and again for pitchers, and upload each below. A column named Dollars / $ / Value / PV is detected.</p>';
  html += '<label class="small muted" style="display:inline-flex; align-items:center; gap:6px;">Source ' +
    '<select id="dol-src-sel">';
  for (const s of ROS_SOURCES) {
    const dc = (typeof getRosDollarCounts === "function") ? getRosDollarCounts(s.id) : { hitters: 0, pitchers: 0 };
    html += '<option value="' + s.id + '"' + (s.id === rosSel ? ' selected' : '') + '>' +
      esc(s.label) + ' ($' + dc.hitters + ' hit / $' + dc.pitchers + ' pit)</option>';
  }
  html += '</select></label>';
  html += '<div class="small" style="margin:6px 0;"><a href="' + esc(fangraphsAuctionUrl(rosSel)) + '" target="_blank" rel="noopener" style="color:var(--accent); font-weight:600;">Open FanGraphs Auction Calculator — ' + esc(getRosSourceLabel(rosSel)) + ' ↗</a> → Export Data</div>';
  html += '<div class="grid cols-2" style="margin-top:4px;">';
  html += '<div><h3>Hitters $</h3>';
  html += '<textarea id="dol-hit-csv" rows="3" style="width:100%; font-family:var(--mono); font-size:11px;" placeholder="Name,$&#10;Aaron Judge,42"></textarea>';
  html += '<div style="margin-top:6px;"><button class="btn primary" id="dol-hit-import" style="width:auto;">Import hitter $</button> <input type="file" id="dol-hit-file" accept=".csv,text/csv"></div></div>';
  html += '<div><h3>Pitchers $</h3>';
  html += '<textarea id="dol-pit-csv" rows="3" style="width:100%; font-family:var(--mono); font-size:11px;" placeholder="Name,$&#10;Tarik Skubal,28"></textarea>';
  html += '<div style="margin-top:6px;"><button class="btn primary" id="dol-pit-import" style="width:auto;">Import pitcher $</button> <input type="file" id="dol-pit-file" accept=".csv,text/csv"></div></div>';
  html += '</div>';
  if (typeof rosHasDollars === "function" && rosHasDollars(rosSel)) {
    const dc = getRosDollarCounts(rosSel);
    html += '<div class="small muted" style="margin-top:8px;">✓ ' + esc(getRosSourceLabel(rosSel)) + ': ' + dc.hitters + ' hitter $ / ' + dc.pitchers + ' pitcher $' +
      ' <button class="btn danger" id="dol-clear" style="width:auto; padding:2px 8px; margin-left:8px;">Clear $ for this source</button></div>';
  }
  html += '</div>';

  // === NFBC market prices ===
  html += '<div class="card"><h2>NFBC Market Prices</h2>';
  html += '<p class="muted small">Industry-mock + main-event auction averages. Surfaces as "market price" in Values, Board, and Live Draft. Expected columns: Name, Pos, Avg$, Min$, Max$, ADP. <a href="https://nfc.shgn.com/baseball/" target="_blank" rel="noopener" style="color: var(--accent);">NFBC source</a>.</p>';
  html += '<textarea id="nfbc-csv" rows="5" style="width: 100%; font-family: var(--mono); font-size: 12px;" placeholder="Name,Pos,Team,Avg$,Min$,Max$,ADP,#Drafts"></textarea>';
  html += '<div style="display: flex; gap: 6px; margin-top: 6px;"><input id="nfbc-source" placeholder="Source (e.g. NFBC Main Event 2026)" style="flex: 1;"><button class="btn primary" id="nfbc-import" style="width: auto;">Import</button></div>';
  html += '<div class="small muted" style="margin-top: 4px;">Or: <input type="file" id="nfbc-file" accept=".csv,text/csv"></div>';
  html += '</div>';

  // === Statcast / Baseball Savant ===
  html += '<div class="card"><h2>Statcast / Baseball Savant</h2>';
  html += '<p class="muted small">Export Custom Leaderboards from <a href="https://baseballsavant.mlb.com/leaderboard/custom?type=batter" target="_blank" rel="noopener" style="color: var(--accent);">Baseball Savant</a>. xwOBA vs wOBA gap drives buy/sell signals. Recommended hitter cols: Name, Team, BBE, EV, Barrel%, HardHit%, xBA, xSLG, xwOBA, wOBA. Pitcher: xERA, K%, BB%, Barrel%.</p>';
  html += '<div class="grid cols-2">';
  html += '<div><h3>Hitters</h3>';
  html += '<textarea id="savant-hit-csv" rows="4" style="width: 100%; font-family: var(--mono); font-size: 12px;"></textarea>';
  html += '<div style="display: flex; gap: 6px; margin-top: 6px;"><button class="btn primary" id="savant-hit-import" style="width: auto;">Import</button></div>';
  html += '<div class="small muted" style="margin-top: 4px;">Or: <input type="file" id="savant-hit-file" accept=".csv,text/csv"></div>';
  html += '</div>';
  html += '<div><h3>Pitchers</h3>';
  html += '<textarea id="savant-pit-csv" rows="4" style="width: 100%; font-family: var(--mono); font-size: 12px;"></textarea>';
  html += '<div style="display: flex; gap: 6px; margin-top: 6px;"><button class="btn primary" id="savant-pit-import" style="width: auto;">Import</button></div>';
  html += '<div class="small muted" style="margin-top: 4px;">Or: <input type="file" id="savant-pit-file" accept=".csv,text/csv"></div>';
  html += '</div>';
  html += '</div></div>';

  // === Reset ===
  if (meta.hitterCount || meta.pitcherCount || nfbcMeta.count || savantHit || savantPit) {
    html += '<div class="card"><h3>Reset</h3>';
    html += '<div style="display: flex; gap: 8px; flex-wrap: wrap;">';
    if (meta.hitterCount || meta.pitcherCount) html += '<button class="btn danger" id="clear-proj">Clear projections</button>';
    if (nfbcMeta.count) html += '<button class="btn danger" id="clear-nfbc">Clear NFBC</button>';
    if (savantHit || savantPit) html += '<button class="btn danger" id="clear-savant">Clear Statcast</button>';
    html += '</div></div>';
  }

  root.innerHTML = html;

  // Data health cleanup button.
  document.getElementById("dh-cleanup")?.addEventListener("click", openDataCleanup);

  // Wire all imports with a consistent helper
  function wireImport(textareaId, fileId, sourceId, fn, label) {
    const btnId = textareaId.replace("-csv", "-import");
    const btn = document.getElementById(btnId);
    if (btn) btn.addEventListener("click", () => {
      const text = document.getElementById(textareaId).value;
      const source = sourceId ? document.getElementById(sourceId)?.value : null;
      if (!text.trim()) { alert("Paste CSV data first."); return; }
      const count = sourceId ? fn(text, source) : fn(text);
      alert("Imported " + count + " " + label + ".");
    });
    const fileInput = document.getElementById(fileId);
    if (fileInput) fileInput.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const source = sourceId ? (document.getElementById(sourceId)?.value || file.name) : null;
        const count = sourceId ? fn(reader.result, source) : fn(reader.result);
        alert("Imported " + count + " " + label + " from " + file.name + ".");
      };
      reader.readAsText(file);
    });
  }
  wireImport("nfbc-csv", "nfbc-file", "nfbc-source", importNfbcCSV, "NFBC prices");
  wireImport("savant-hit-csv", "savant-hit-file", null, importStatcastHittersCSV, "Statcast hitters");
  wireImport("savant-pit-csv", "savant-pit-file", null, importStatcastPitchersCSV, "Statcast pitchers");

  // ROS projections wiring.
  document.getElementById("ros-src-sel")?.addEventListener("change", (e) => {
    _dataRosSel = e.target.value;
    renderData();
  });
  // Paste-FanGraphs-JSON import (primary path).
  function wireJsonImport(id, kind, label) {
    document.getElementById(id)?.addEventListener("click", () => {
      const ta = document.getElementById(id.replace("-import", ""));
      const text = (ta?.value || "").trim();
      if (!text) { alert("Open the link, copy the page, and paste it first."); return; }
      try {
        const count = importRosJSON(_dataRosSel, kind, text);
        setRosManual(_dataRosSel, true);   // your paste overrides the live default
        if (ta) ta.value = "";
        alert("Imported " + count + " " + label + " into " + getRosSourceLabel(_dataRosSel) + ". This source will no longer auto-update (your manual override). Use “Load latest projections” to switch back to live." + rosImportWarning(kind, count));
        renderData();
      } catch (e) { alert(e.message || String(e)); }
    });
  }
  wireJsonImport("ros-hit-json-import", "bat", "hitters");
  wireJsonImport("ros-pit-json-import", "pit", "pitchers");
  // JSON file upload (no paste-truncation for the big files).
  function wireJsonFile(fileId, kind, label) {
    document.getElementById(fileId)?.addEventListener("change", (ev) => {
      const file = ev.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const count = importRosJSON(_dataRosSel, kind, String(reader.result));
          setRosManual(_dataRosSel, true);   // your upload overrides the live default
          alert("Imported " + count + " " + label + " into " + getRosSourceLabel(_dataRosSel) + " from " + file.name + ". Manual override set; use “Load latest projections” to switch back to live." + rosImportWarning(kind, count));
          renderData();
        } catch (e) { alert(e.message || String(e)); }
      };
      reader.readAsText(file);
    });
  }
  wireJsonFile("ros-hit-json-file", "bat", "hitters");
  wireJsonFile("ros-pit-json-file", "pit", "pitchers");
  function wireRosImport(textareaId, fileId, fn, label) {
    const btnId = textareaId.replace("-csv", "-import");
    document.getElementById(btnId)?.addEventListener("click", () => {
      const text = document.getElementById(textareaId).value;
      if (!text.trim()) { alert("Paste CSV data first."); return; }
      try {
        const count = fn(_dataRosSel, text);
        setRosManual(_dataRosSel, true);   // your upload overrides the live default
        alert("Imported " + count + " " + label + " into " + getRosSourceLabel(_dataRosSel) + ". This source will no longer auto-update (your manual override). Use “Load latest projections” to switch back to live.");
        renderData();
      } catch (e) { alert(e.message || String(e)); }
    });
    document.getElementById(fileId)?.addEventListener("change", (ev) => {
      const file = ev.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const count = fn(_dataRosSel, reader.result);
          setRosManual(_dataRosSel, true);
          alert("Imported " + count + " " + label + " into " + getRosSourceLabel(_dataRosSel) + " from " + file.name + ". Manual override set; use “Load latest projections” to switch back to live.");
          renderData();
        } catch (e) { alert(e.message || String(e)); }
      };
      reader.readAsText(file);
    });
  }
  wireRosImport("ros-hit-csv", "ros-hit-file", importRosHitters, "ROS hitters");
  wireRosImport("ros-pit-csv", "ros-pit-file", importRosPitchers, "ROS pitchers");

  document.getElementById("ros-clear")?.addEventListener("click", () => {
    if (confirm("Clear " + getRosSourceLabel(_dataRosSel) + " stat projections?")) { clearRosSource(_dataRosSel); renderData(); }
  });

  // === Dollar Values wiring (split hitters / pitchers, per source) ===
  document.getElementById("dol-src-sel")?.addEventListener("change", (e) => { _dataRosSel = e.target.value; renderData(); });
  function wireDollarImport(textareaId, fileId, kind, label) {
    const btnId = textareaId.replace("-csv", "-import");
    document.getElementById(btnId)?.addEventListener("click", () => {
      const text = document.getElementById(textareaId).value;
      if (!text.trim()) { alert("Paste a Name,$ CSV first."); return; }
      const n = importRosDollars(_dataRosSel, kind, text);
      alert("Imported " + n + " " + label + " $ into " + getRosSourceLabel(_dataRosSel) + ".");
      renderData();
    });
    document.getElementById(fileId)?.addEventListener("change", (ev) => {
      const file = ev.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const n = importRosDollars(_dataRosSel, kind, String(reader.result));
        alert("Imported " + n + " " + label + " $ into " + getRosSourceLabel(_dataRosSel) + " from " + file.name + ".");
        renderData();
      };
      reader.readAsText(file);
    });
  }
  wireDollarImport("dol-hit-csv", "dol-hit-file", "bat", "hitter");
  wireDollarImport("dol-pit-csv", "dol-pit-file", "pit", "pitcher");
  document.getElementById("dol-clear")?.addEventListener("click", () => {
    if (confirm("Clear " + getRosSourceLabel(_dataRosSel) + " dollar values?")) { clearRosDollars(_dataRosSel); renderData(); }
  });

  document.getElementById("clear-proj")?.addEventListener("click", () => {
    if (confirm("Clear all projections?")) clearProjections();
  });
  document.getElementById("clear-nfbc")?.addEventListener("click", () => {
    if (confirm("Clear NFBC market prices?")) clearNfbc();
  });
  document.getElementById("clear-savant")?.addEventListener("click", () => {
    if (confirm("Clear Statcast data?")) clearStatcast();
  });
}
