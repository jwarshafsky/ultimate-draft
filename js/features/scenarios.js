// What-if scenarios. Save the current state of: keepers, manual price
// overrides, and any "imagined" picks. Load them later to compare two paths
// — e.g., "what if I keep Tatis at $40 vs trade him for $20 picks?"
//
// State captured per scenario:
//   - Snapshot of getKeeperSelections() (which players are kept)
//   - Snapshot of getKeeperPriceExceptions() (salary overrides)
//   - Imagined picks (off-Supabase, just this scenario)
//   - Computed: total roto points, surplus, category projections

const SCENARIOS_KEY = "ud_scenarios_v1";

const _scenarios = {
  list: [],   // [{ id, name, createdAt, keepers, priceExceptions, imaginedPicks, snapshot }]
};

function loadScenariosFromStorage() {
  try {
    const v = JSON.parse(localStorage.getItem(SCENARIOS_KEY) || "null");
    if (v) _scenarios.list = v.list || [];
  } catch (e) {}
}

function saveScenariosToStorage() {
  localStorage.setItem(SCENARIOS_KEY, JSON.stringify({ list: _scenarios.list }));
}

// Snapshot summary computed at save time so we can show it without rerunning.
function snapshotMyTeam(picks) {
  const me = getMyTeam();
  if (!me) return null;
  const sel = getKeeperSelections()[me.id] || {};
  const kept = Object.entries(sel)
    .filter(([_, f]) => f.keeper)
    .map(([n]) => n);
  const roster = [...kept, ...(picks || []).map(p => p.player)];
  const cats = projectTeamCategories(roster);
  const totalCost = (kept.reduce((s, n) => s + (getKeeperPriceExceptions()[n] || 0), 0) +
                     (picks || []).reduce((s, p) => s + p.price, 0));
  return {
    keeperCount: kept.length,
    pickCount: (picks || []).length,
    rosterCount: roster.length,
    totalCost,
    rotoPoints: cats.rotoPoints,
    ranks: cats.ranks,
    totals: cats.totals,
  };
}

function saveScenario(name) {
  const id = "sc_" + Date.now();
  const me = getMyTeam();
  const sel = getKeeperSelections()[me?.id] || {};
  const scenario = {
    id,
    name: name || "Scenario " + (_scenarios.list.length + 1),
    createdAt: new Date().toISOString(),
    keepers: JSON.parse(JSON.stringify(sel)),
    priceExceptions: JSON.parse(JSON.stringify(getKeeperPriceExceptions())),
    imaginedPicks: JSON.parse(JSON.stringify(_liveDraft?.picks || [])),
    snapshot: snapshotMyTeam(_liveDraft?.picks || []),
  };
  _scenarios.list.push(scenario);
  saveScenariosToStorage();
  if (typeof rerender === "function") rerender();
  return scenario;
}

function deleteScenario(id) {
  _scenarios.list = _scenarios.list.filter(s => s.id !== id);
  saveScenariosToStorage();
  if (typeof rerender === "function") rerender();
}

function renderScenarios() {
  const root = document.getElementById("view-root");
  let html = '';

  html += '<div class="card"><h2>What-If Scenarios</h2>';
  html += '<p class="muted small">Snapshot your current keeper/roster state and compare side-by-side. Useful for "should I keep player X?" or "what does my team look like if I draft strategy A vs B?"</p>';
  html += '<div style="display: flex; gap: 8px; align-items: center;">';
  html += '<input id="sc-name" placeholder="Scenario name (e.g. \'Keep Tatis at $40\')" style="flex: 1;">';
  html += '<button class="btn primary" id="sc-save" style="width: auto; padding: 8px 14px;">Save Current State</button>';
  html += '</div></div>';

  if (!_scenarios.list.length) {
    html += '<div class="empty"><p>No scenarios saved yet.</p><p class="small">Save the current state (your keepers + any live draft picks) to compare against later snapshots.</p></div>';
    root.innerHTML = html;
    wireScenarioHandlers();
    return;
  }

  // Side-by-side comparison table
  html += '<div class="card"><h2>Saved Scenarios</h2>';
  html += '<table><thead><tr>';
  html += '<th>Name</th><th>Saved</th><th class="num">Keepers</th><th class="num">Total $</th><th class="num">Roto Pts</th>';
  // Per-category column for quick visual diff
  const cats = ["R", "HR", "RBI", "SB", "OBP", "QS", "K", "SV_HLD", "ERA", "WHIP"];
  for (const c of cats) html += '<th class="num">' + esc(c) + '</th>';
  html += '<th></th>';
  html += '</tr></thead><tbody>';
  for (const s of _scenarios.list) {
    const snap = s.snapshot;
    html += '<tr>';
    html += '<td><strong>' + esc(s.name) + '</strong></td>';
    html += '<td class="small muted">' + new Date(s.createdAt).toLocaleString() + '</td>';
    html += '<td class="num">' + (snap?.keeperCount || 0) + '</td>';
    html += '<td class="num">$' + (snap?.totalCost || 0) + '</td>';
    html += '<td class="num">' + (snap?.rotoPoints?.toFixed(1) || "—") + '</td>';
    for (const c of cats) {
      const rank = snap?.ranks?.[c];
      const rankColor = !rank ? "" : rank <= 4 ? "good" : rank >= 9 ? "bad" : "";
      html += '<td class="num ' + rankColor + '">' + (rank ? rank.toFixed(1) : "—") + '</td>';
    }
    html += '<td><button class="btn ghost danger sc-delete" data-id="' + s.id + '" style="padding: 2px 8px; font-size: 11px;">✕</button></td>';
    html += '</tr>';
  }
  html += '</tbody></table>';
  html += '<p class="muted small" style="margin-top: 8px;">Lower rank = better. Green = top 4 in cat; Red = bottom 4.</p>';
  html += '</div>';

  root.innerHTML = html;
  wireScenarioHandlers();
}

function wireScenarioHandlers() {
  document.getElementById("sc-save")?.addEventListener("click", () => {
    const name = document.getElementById("sc-name").value.trim();
    saveScenario(name);
    document.getElementById("sc-name").value = "";
  });
  document.getElementById("sc-name")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("sc-save").click();
  });
  document.querySelectorAll(".sc-delete").forEach(b => {
    b.addEventListener("click", () => {
      if (confirm("Delete this scenario?")) deleteScenario(b.dataset.id);
    });
  });
}

loadScenariosFromStorage();
