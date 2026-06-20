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
};

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
  html += '<p class="small muted" style="margin-top:6px;">Free agents only (ESPN onTeamId 0). Short windows are small-sample — watch the PA column. <b>Gap</b> = xwOBA − wOBA (positive = under-performing, heating up).</p>';
  html += '</div>';

  if (!winData) {
    html += '<div class="empty"><p>No data yet for ' + esc(win.label) + '.</p>' +
      '<p class="small">Click <b>Refresh data</b> to pull all windows from FanGraphs.</p></div>';
    root.innerHTML = html;
    _wireHotfa();
    _updateHotfaStatus();
    return;
  }

  // Join leaders ∩ free agents.
  const fa = _hotfa.faPool || {};
  const rows = [];
  for (const lead of fgxLeaders(win.id)) {
    const key = fgKey(lead.name);
    const faMatch = fa[key];
    if (!faMatch) continue; // rostered or not in ESPN pool → skip
    if (lead.PA != null && lead.PA < _hotfa.minPA) continue;
    rows.push({
      name: lead.name,
      pos: faMatch.pos || "",
      team: lead.team || "",
      xwOBA: lead.xwOBA,
      wOBA: lead.wOBA,
      PA: lead.PA,
      pctOwned: faMatch.pctOwned,
      gap: (lead.xwOBA != null && lead.wOBA != null) ? (lead.xwOBA - lead.wOBA) : null,
    });
  }
  rows.sort((a, b) => (b.xwOBA || 0) - (a.xwOBA || 0));

  const stamp = winData.fetchedAt ? new Date(winData.fetchedAt).toLocaleString() : "";
  const range = winData.start ? (winData.start + " → " + winData.end) : "full season";

  html += '<div class="card">';
  html += '<div class="small muted" style="margin-bottom:6px;">' + esc(win.label) + ' (' + esc(range) + ') · ' +
    rows.length + ' free agents · updated ' + esc(stamp) + (_hotfa.loadedFa ? '' : ' · FA pool not loaded') + '</div>';
  html += '<table><thead><tr>' +
    '<th>#</th><th>Player</th><th>Pos</th><th>Tm</th>' +
    '<th style="text-align:right;">xwOBA</th><th style="text-align:right;">wOBA</th>' +
    '<th style="text-align:right;">Gap</th><th style="text-align:right;">PA</th><th style="text-align:right;">%Own</th>' +
    '</tr></thead><tbody>';
  rows.slice(0, 200).forEach((r, i) => {
    const gapStr = r.gap == null ? '' : (r.gap > 0 ? '+' : '') + r.gap.toFixed(3);
    const gapColor = r.gap == null ? '' : r.gap > 0.02 ? 'var(--good)' : r.gap < -0.02 ? 'var(--bad)' : 'var(--text-3)';
    html += '<tr>' +
      '<td class="muted">' + (i + 1) + '</td>' +
      '<td>' + esc(r.name) + '</td>' +
      '<td class="muted">' + esc(r.pos) + '</td>' +
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
}
