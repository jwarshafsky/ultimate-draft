// Hot FAs — xwOBA leaders among ESPN free agents across trailing date windows
// (7/14/30/60d + season). Joins the FanGraphs windowed-xwOBA data layer against
// the ESPN free-agent pool by normalized name. xwOBA over short windows is
// small-sample, so PA is shown alongside and a min-PA filter is provided.

const _hotfa = {
  win: "14d",
  minPA: 10,
  faPool: null,      // normKey → FA hitter object (cached for the session)
  loading: false,
  progress: {},      // winId → status string
  loadedFa: false,
  sortKey: "xwOBA",  // column sort
  sortDir: -1,       // -1 desc, 1 asc
};

// Premium-position-first order for sorting the Pos column.
const _HOTFA_POS_ORDER = ["C", "1B", "2B", "3B", "SS", "OF", "DH", "UT"];
function _hotfaPosRank(eligiblePos) {
  let best = 99;
  const list = (eligiblePos && eligiblePos.length) ? eligiblePos : [""];
  for (const p of list) {
    const i = _HOTFA_POS_ORDER.indexOf(p);
    if (i >= 0 && i < best) best = i;
  }
  return best;
}

// fgKeys of every player stashed on a team's minor-league roster in our league.
// ESPN lists these as free agents (onTeamId 0), so they must be filtered out.
function _hotfaMinorLeagueKeys() {
  const set = new Set();
  if (typeof getKeeperSelections !== "function") return set;
  const sel = getKeeperSelections() || {};
  for (const teamId in sel) {
    const players = sel[teamId] || {};
    for (const name in players) {
      if (players[name] && players[name].minorKeeper) set.add(fgKey(name));
    }
  }
  return set;
}

async function _hotfaLoadFaPool() {
  if (_hotfa.faPool) return _hotfa.faPool;
  const list = await fetchEspnFreeAgents(0);
  const map = {};
  for (const p of list) {
    if (p.type !== "H") continue;
    map[fgKey(p.name)] = p;
  }
  _hotfa.faPool = map;
  _hotfa.loadedFa = true;
  return map;
}

async function _hotfaRefresh() {
  if (_hotfa.loading) return;
  _hotfa.loading = true;
  _hotfa.progress = {};
  renderHotFa();
  try {
    await _hotfaLoadFaPool();
    await fetchAllFgxWindows((winId, status) => {
      _hotfa.progress[winId] = status;
      _updateHotfaStatus();
    });
  } catch (e) {
    _hotfa.progress.error = e.message || String(e);
  } finally {
    _hotfa.loading = false;
    renderHotFa();
  }
}

function _updateHotfaStatus() {
  const el = document.getElementById("hotfa-status");
  if (!el) return;
  el.innerHTML = FGX_WINDOWS.map(w => {
    const s = _hotfa.progress[w.id] || "";
    const dot = s === "done" ? "✓" : s === "fetching" ? "…" : s.startsWith("error") ? "✕" : "·";
    return '<span style="margin-right:10px;">' + dot + ' ' + esc(w.label) + '</span>';
  }).join("");
}

function renderHotFa() {
  const root = document.getElementById("view-root");

  if (!ESPN.proxyUrl) {
    root.innerHTML = '<div class="card"><h2>Hot FAs — xwOBA</h2>' +
      '<p class="muted">Set your proxy URL in <b>Settings</b> first — this view pulls FanGraphs xwOBA and the ESPN free-agent pool through it.</p></div>';
    return;
  }

  const win = FGX_WINDOWS.find(w => w.id === _hotfa.win) || FGX_WINDOWS[1];
  const winData = getFgxWindow(win.id);

  let html = '<div class="card" style="margin-bottom:8px;">';
  html += '<div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap;">';
  html += '<h2 style="margin:0;">Hot FAs — xwOBA</h2>';
  html += '<div class="tabs" style="gap:4px;">';
  for (const w of FGX_WINDOWS) {
    const active = w.id === _hotfa.win ? ' primary' : '';
    html += '<button class="btn' + active + ' hotfa-win" data-win="' + w.id + '" style="width:auto; padding:4px 10px;">' + esc(w.label) + '</button>';
  }
  html += '</div>';
  html += '<label class="small muted" style="display:inline-flex; align-items:center; gap:6px;">min PA ' +
    '<input id="hotfa-minpa" type="number" min="0" step="5" value="' + _hotfa.minPA + '" style="width:64px;"></label>';
  html += '<button class="btn primary hotfa-refresh" style="width:auto;"' + (_hotfa.loading ? ' disabled' : '') + '>' +
    (_hotfa.loading ? 'Loading…' : 'Refresh data') + '</button>';
  html += '</div>';
  html += '<div id="hotfa-status" class="small muted" style="margin-top:6px;"></div>';
  if (_hotfa.progress.error) {
    html += '<div class="small" style="color:var(--bad); margin-top:4px;">' + esc(_hotfa.progress.error) + '</div>';
  }
  html += '<p class="small muted" style="margin-top:6px;">True free agents only — excludes players on a team’s minor-league roster. Click any column header to sort (incl. <b>Pos</b> by qualified position). Short windows are small-sample — watch PA. <b>Gap</b> = xwOBA − wOBA (positive = under-performing, heating up).</p>';
  html += '</div>';

  if (!winData) {
    html += '<div class="empty"><p>No data yet for ' + esc(win.label) + '.</p>' +
      '<p class="small">Click <b>Refresh data</b> to pull all windows from FanGraphs.</p></div>';
    root.innerHTML = html;
    _wireHotfa();
    _updateHotfaStatus();
    return;
  }

  // Join leaders ∩ free agents, dropping league minor-league stashes.
  const fa = _hotfa.faPool || {};
  const minorKeys = _hotfaMinorLeagueKeys();
  const rows = [];
  let minorHidden = 0;
  for (const lead of fgxLeaders(win.id)) {
    const key = fgKey(lead.name);
    const faMatch = fa[key];
    if (!faMatch) continue; // rostered or not in ESPN pool → skip
    if (lead.PA != null && lead.PA < _hotfa.minPA) continue;
    if (minorKeys.has(key)) { minorHidden++; continue; } // on a team's MiL roster
    const eligiblePos = (faMatch.eligiblePos && faMatch.eligiblePos.length) ? faMatch.eligiblePos : (faMatch.pos ? [faMatch.pos] : []);
    rows.push({
      name: lead.name,
      eligiblePos,
      posStr: eligiblePos.join("/") || (faMatch.pos || ""),
      team: lead.team || "",
      xwOBA: lead.xwOBA,
      wOBA: lead.wOBA,
      PA: lead.PA,
      pctOwned: faMatch.pctOwned,
      gap: (lead.xwOBA != null && lead.wOBA != null) ? (lead.xwOBA - lead.wOBA) : null,
    });
  }

  // Sort by the active column.
  const k = _hotfa.sortKey, dir = _hotfa.sortDir;
  const cmp = (a, b) => {
    let av, bv;
    if (k === "pos") { av = _hotfaPosRank(a.eligiblePos); bv = _hotfaPosRank(b.eligiblePos); }
    else if (k === "name") { return dir * String(a.name).localeCompare(String(b.name)); }
    else { av = a[k]; bv = b[k]; }
    if (av == null) av = -Infinity;
    if (bv == null) bv = -Infinity;
    return dir * (av < bv ? -1 : av > bv ? 1 : 0);
  };
  rows.sort(cmp);

  const stamp = winData.fetchedAt ? new Date(winData.fetchedAt).toLocaleString() : "";
  const range = winData.start ? (winData.start + " → " + winData.end) : "full season";

  // Sortable header cell: shows the active sort arrow.
  const arrow = (key) => _hotfa.sortKey === key ? (_hotfa.sortDir === -1 ? ' ↓' : ' ↑') : '';
  const th = (key, label, right) => '<th data-sort="' + key + '" style="cursor:pointer;' +
    (right ? ' text-align:right;' : '') + '">' + esc(label) + arrow(key) + '</th>';

  html += '<div class="card">';
  html += '<div class="small muted" style="margin-bottom:6px;">' + esc(win.label) + ' (' + esc(range) + ') · ' +
    rows.length + ' free agents · updated ' + esc(stamp) +
    (minorHidden ? ' · ' + minorHidden + ' minor-league stash' + (minorHidden === 1 ? '' : 'es') + ' hidden' : '') +
    (_hotfa.loadedFa ? '' : ' · FA pool not loaded') + '</div>';
  html += '<table><thead><tr>' +
    '<th>#</th>' + th("name", "Player") + th("pos", "Pos") + '<th>Tm</th>' +
    th("xwOBA", "xwOBA", true) + th("wOBA", "wOBA", true) +
    th("gap", "Gap", true) + th("PA", "PA", true) + th("pctOwned", "%Own", true) +
    '</tr></thead><tbody>';
  rows.slice(0, 200).forEach((r, i) => {
    const gapStr = r.gap == null ? '' : (r.gap > 0 ? '+' : '') + r.gap.toFixed(3);
    const gapColor = r.gap == null ? '' : r.gap > 0.02 ? 'var(--good)' : r.gap < -0.02 ? 'var(--bad)' : 'var(--text-3)';
    html += '<tr>' +
      '<td class="muted">' + (i + 1) + '</td>' +
      '<td>' + esc(r.name) + '</td>' +
      '<td class="muted">' + esc(r.posStr) + '</td>' +
      '<td class="muted">' + esc(r.team) + '</td>' +
      '<td style="text-align:right; font-family:var(--mono);">' + (r.xwOBA != null ? r.xwOBA.toFixed(3) : '') + '</td>' +
      '<td style="text-align:right; font-family:var(--mono); color:var(--text-3);">' + (r.wOBA != null ? r.wOBA.toFixed(3) : '') + '</td>' +
      '<td style="text-align:right; font-family:var(--mono); color:' + gapColor + ';">' + gapStr + '</td>' +
      '<td style="text-align:right; font-family:var(--mono);">' + (r.PA != null ? r.PA : '') + '</td>' +
      '<td style="text-align:right; font-family:var(--mono); color:var(--text-3);">' + (r.pctOwned != null ? r.pctOwned.toFixed(0) + '%' : '') + '</td>' +
      '</tr>';
  });
  html += '</tbody></table>';
  if (rows.length > 200) html += '<p class="muted small" style="margin-top:8px;">Showing top 200 of ' + rows.length + '.</p>';
  if (rows.length === 0) html += '<p class="muted small">No free agents cleared the min-PA filter for this window.</p>';
  html += '</div>';

  root.innerHTML = html;
  _wireHotfa();
  _updateHotfaStatus();
}

function _wireHotfa() {
  document.querySelectorAll(".hotfa-win").forEach(b => {
    b.addEventListener("click", () => { _hotfa.win = b.dataset.win; renderHotFa(); });
  });
  const refresh = document.querySelector(".hotfa-refresh");
  if (refresh) refresh.addEventListener("click", _hotfaRefresh);
  const minpa = document.getElementById("hotfa-minpa");
  if (minpa) minpa.addEventListener("change", (e) => {
    _hotfa.minPA = Math.max(0, Number(e.target.value) || 0);
    renderHotFa();
  });
  document.querySelectorAll("th[data-sort]").forEach(th => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (_hotfa.sortKey === key) {
        _hotfa.sortDir = -_hotfa.sortDir;
      } else {
        _hotfa.sortKey = key;
        // Text columns default A→Z; numeric columns default high→low.
        _hotfa.sortDir = (key === "name" || key === "pos") ? 1 : -1;
      }
      renderHotFa();
    });
  });
}
