// Values view — flat sortable table of all projected players with base value,
// inflated value, and the projection stats that drove them.

let _valuesState = {
  sort: "infl", dir: -1,   // sort key / direction (-1 desc)
  posFilter: "ALL",
  showKept: false,
  search: "",
};

function renderValues() {
  const root = document.getElementById("view-root");
  const values = getValues();
  if (!values.length) {
    root.innerHTML = '<div class="empty"><p>No values yet.</p><p class="small">Upload Dollar Values (or Stat Projections) on the Data tab.</p></div>';
    return;
  }
  const inflation = computeTieredInflation();
  const keptNames = new Set(collectKeepers().map(k => k.name));

  // Projection source toggle (shared app-wide with the Keepers tab).
  const sources = (typeof projectionSources === "function") ? projectionSources() : [];
  const activeSrc = (typeof activeProjSource === "function") ? activeProjSource() : null;

  let html = '<div class="card" style="margin-bottom: 8px;">';
  html += '<div style="display:flex; align-items:center; gap:8px; margin:0 0 8px;">';
  html += '<span class="small muted">Projection $</span>';
  if (sources.length) {
    html += '<select id="val-source">';
    for (const s of sources) {
      const tag = s.id === "preseason" ? "" : (s.hasDollars ? " · $" : " · no $");
      html += '<option value="' + esc(s.id) + '"' + (s.id === activeSrc ? " selected" : "") + '>' + esc(s.label) + tag + '</option>';
    }
    html += '</select>';
    html += '<span class="small dim">· shared with Keepers tab</span>';
  } else {
    html += '<span class="dim small">none loaded</span>';
  }
  html += '</div>';
  html += '<div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">';
  html += '<input id="val-search" type="search" placeholder="Search player…" style="flex: 1; min-width: 200px;" value="' + esc(_valuesState.search) + '">';
  html += '<select id="val-pos">';
  for (const p of ["ALL", "C", "1B", "2B", "SS", "3B", "OF", "UTIL", "SP", "RP"]) {
    html += '<option value="' + p + '"' + (_valuesState.posFilter === p ? ' selected' : '') + '>' + p + '</option>';
  }
  html += '</select>';
  html += '<label style="display:flex; align-items:center; gap:6px; font-size:13px;"><input type="checkbox" id="val-kept"' + (_valuesState.showKept ? ' checked' : '') + '> Show kept</label>';
  html += '</div></div>';

  // Filter + sort
  let filtered = values.filter(p => {
    if (_valuesState.posFilter !== "ALL" && p.posKey !== _valuesState.posFilter && p.pos !== _valuesState.posFilter) return false;
    if (!_valuesState.showKept && keptNames.has(p.name)) return false;
    if (_valuesState.search && !p.name.toLowerCase().includes(_valuesState.search.toLowerCase())) return false;
    return true;
  });
  const sortKey = _valuesState.sort;
  filtered.sort((a, b) => {
    let av = a[sortKey], bv = b[sortKey];
    if (sortKey === "infl") {
      av = inflatedValue(a, inflation);
      bv = inflatedValue(b, inflation);
    }
    if (typeof av === "string") return av.localeCompare(bv) * _valuesState.dir;
    return ((av || 0) - (bv || 0)) * _valuesState.dir;
  });

  html += '<div class="card">';
  html += '<table><thead><tr>';
  const cols = [
    ["name", "Player"], ["pos", "Pos"], ["team", "Tm"],
    ["sgpAbove", "vsRepl"],
    ["value", "Value"], ["infl", "Inflated"],
    ["nfbc", "NFBC"], ["xstat", "xwOBA / xERA"],
  ];
  for (const [k, lbl] of cols) {
    const arrow = _valuesState.sort === k ? (_valuesState.dir < 0 ? " ↓" : " ↑") : "";
    html += '<th class="' + (k === "name" || k === "pos" || k === "team" ? "" : "num") + '" style="cursor:pointer;" data-sort="' + k + '">' + esc(lbl) + arrow + '</th>';
  }
  html += '</tr></thead><tbody>';
  for (const p of filtered.slice(0, 400)) {
    const inflV = inflatedValue(p, inflation);
    const delta = inflV - p.value;
    const isKept = keptNames.has(p.name);
    const nfbc = getNfbc(p.name);
    const sc = getStatcast(p.name);
    const sig = statcastBuySell(p.name);
    const xstat = sc?.xwOBA ? sc.xwOBA.toFixed(3) : sc?.xERA ? sc.xERA.toFixed(2) : null;
    html += '<tr' + (isKept ? ' class="kept"' : '') + '>';
    html += '<td><span class="player-name" data-player="' + esc(p.name) + '" style="cursor: pointer;">' + esc(p.name) + '</span>' + (isKept ? ' <span class="kbd" style="color: var(--keeper);">K</span>' : '') +
      (sig ? ' <span style="color: ' + (sig.signal === "buy" ? "var(--good)" : "var(--bad)") + '; font-size: 10px;" title="' + esc(sig.reason) + '">' + (sig.signal === "buy" ? "↑" : "↓") + '</span>' : '') +
      renderTagIcons(p.name) +
      renderTargetBadge(p.name, inflV) + '</td>';
    html += '<td>' + esc(p.pos) + '</td>';
    html += '<td class="dim">' + esc(p.team) + '</td>';
    html += '<td class="num">' + p.sgpAbove.toFixed(1) + '</td>';
    html += '<td class="num">$' + p.value.toFixed(1) + '</td>';
    html += '<td class="num ' + (delta > 0 ? 'good' : delta < 0 ? 'bad' : '') + '">$' + inflV.toFixed(1) + '</td>';
    html += '<td class="num ' + (nfbc?.avg ? '' : 'dim') + '">' + (nfbc?.avg ? '$' + nfbc.avg.toFixed(0) : '—') + '</td>';
    html += '<td class="num ' + (xstat ? '' : 'dim') + '">' + (xstat || '—') + '</td>';
    html += '</tr>';
  }
  html += '</tbody></table>';
  if (filtered.length > 400) html += '<p class="muted small" style="margin-top: 8px;">Showing top 400 of ' + filtered.length + '. Refine filter to narrow.</p>';
  html += '</div>';

  root.innerHTML = html;

  // Topbar inflation badge — same shared value as every other tab.
  if (typeof updateInflationBadge === "function") updateInflationBadge();

  // Wire interactions
  const srcSel = document.getElementById("val-source");
  if (srcSel) srcSel.addEventListener("change", (e) => {
    if (typeof setKeeperProjSource === "function") setKeeperProjSource(e.target.value);
    if (typeof refreshValues === "function") refreshValues();
    renderValues();
  });
  document.getElementById("val-search").addEventListener("input", (e) => {
    _valuesState.search = e.target.value;
    renderValues();
  });
  document.getElementById("val-pos").addEventListener("change", (e) => {
    _valuesState.posFilter = e.target.value;
    renderValues();
  });
  document.getElementById("val-kept").addEventListener("change", (e) => {
    _valuesState.showKept = e.target.checked;
    renderValues();
  });
  document.querySelectorAll("th[data-sort]").forEach(th => {
    th.addEventListener("click", () => {
      const k = th.dataset.sort;
      if (_valuesState.sort === k) _valuesState.dir = -_valuesState.dir;
      else { _valuesState.sort = k; _valuesState.dir = -1; }
      renderValues();
    });
  });
  document.querySelectorAll(".player-name").forEach(el => {
    el.addEventListener("click", () => openNoteEditor(el.dataset.player));
  });
}
