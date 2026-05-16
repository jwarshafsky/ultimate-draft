// History tab — draft history import + owner tendency analysis. Shows each
// owner's behavioral profile (aggression, position bias, closer love, stars-
// and-scrubs tendency). Profiles plug into the mock engine automatically.

function renderHistory() {
  const root = document.getElementById("view-root");
  const picks = _history.picks;
  const years = _history.meta.years || [];

  let html = '';

  // ESPN sync section (uses proxy)
  html += '<div class="card"><h2>Sync from ESPN</h2>';
  html += '<p class="muted small">Pulls draft results directly from ESPN for league 1200, seasons 2017-2026 (excluding 2020). Requires proxy URL configured in Settings tab.</p>';
  html += '<div style="display: flex; gap: 8px; align-items: center;">';
  const seasons = "2017, 2018, 2019, 2021, 2022, 2023, 2024, 2025, 2026";
  html += '<input id="hist-espn-years" placeholder="' + seasons + '" value="' + seasons + '" style="flex: 1;">';
  html += '<button class="btn primary" id="hist-espn-sync" style="width: auto; padding: 8px 14px;"' + (ESPN.proxyUrl ? '' : ' disabled') + '>Sync from ESPN</button>';
  html += '</div>';
  html += '<div class="muted small" style="margin-top: 6px;">' + (ESPN.proxyUrl ? "Proxy ready: " + esc(ESPN.proxyUrl) : "Set proxy URL in Live Draft tab first.") + '</div>';
  html += '<div id="espn-sync-log" class="small muted" style="margin-top: 10px;"></div>';
  if (picks.length) {
    html += '<div style="margin-top: 10px;"><button class="btn ghost danger" id="hist-clear-top">Clear all history</button></div>';
  }
  html += '</div>';

  // Owner alias mapping section (if data exists) — GUID-based primary
  if (picks.length) {
    const currentOwners = LEAGUE.teams.map(t => t.owner);
    const guidOwners = listHistoricalOwnerGuids();
    const totalAliases = Object.keys(_ownerAliases.byGuid).length + Object.keys(_ownerAliases.byName).length;
    html += '<div class="card"><h2>Owner Mapping <span class="muted small">' + totalAliases + ' aliases set</span></h2>';
    html += '<p class="muted small">Each row is one unique person across all years (keyed by ESPN owner GUID, so team renames AND ownership transfers roll up correctly). Map each to a current owner.</p>';

    if (guidOwners.length) {
      // Auto-save AUTO suggestions for rows that don't have an alias yet and
      // aren't excluded. One-time op per row so the bottom profile section
      // shows current owner names without requiring the user to click each dropdown.
      let autoSavedAny = false;
      for (const o of guidOwners) {
        if (_ownerAliases.byGuid[o.guid] || isOwnerExcluded(o.guid)) continue;
        const autoFromTeam = o.currentTeam?.owner;
        const autoFromName = o.teamNames.find(n => currentOwners.includes(n));
        const autoMatch = autoFromTeam || autoFromName;
        if (autoMatch) {
          _ownerAliases.byGuid[o.guid] = autoMatch;
          autoSavedAny = true;
        }
      }
      if (autoSavedAny) saveOwnerAliases();

      html += '<table style="font-size: 12px;"><thead><tr><th>Team names used</th><th>Years</th><th>Most recent (current team)</th><th class="num">Picks</th><th>→</th><th>Current Owner</th><th>Exclude</th></tr></thead><tbody>';
      for (const o of guidOwners) {
        const aliased = _ownerAliases.byGuid[o.guid];
        const excluded = isOwnerExcluded(o.guid);
        const autoFromTeam = o.currentTeam?.owner;
        const autoFromName = o.teamNames.find(n => currentOwners.includes(n));
        const autoMatch = autoFromTeam || autoFromName;
        const recentLabel = (o.mostRecentEspnTeamId != null ? "Team " + o.mostRecentEspnTeamId : "?") +
          (o.currentTeam ? ' <span class="muted">(' + esc(o.currentTeam.name) + " · " + esc(o.currentTeam.owner) + ')</span>' : "");
        html += '<tr' + (excluded ? ' style="opacity: 0.45;"' : '') + '>';
        html += '<td>' + o.teamNames.map(esc).join(", ") + (autoMatch && !aliased && !excluded ? ' <span class="kbd" style="color: var(--good); font-size: 10px;">AUTO</span>' : '') + '</td>';
        html += '<td class="small muted">' + o.years.join(", ") + '</td>';
        html += '<td class="small">' + recentLabel + '</td>';
        html += '<td class="num">' + o.pickCount + '</td>';
        html += '<td class="dim">→</td>';
        html += '<td><select class="hist-alias-guid" data-guid="' + esc(o.guid) + '"' + (excluded ? ' disabled' : '') + '>';
        html += '<option value="">(no alias)</option>';
        for (const own of currentOwners) {
          html += '<option value="' + esc(own) + '"' + (aliased === own ? ' selected' : (!aliased && autoMatch === own ? ' selected' : '')) + '>' + esc(own) + '</option>';
        }
        html += '</select></td>';
        html += '<td style="text-align: center;"><input type="checkbox" class="hist-exclude" data-guid="' + esc(o.guid) + '"' + (excluded ? ' checked' : '') + ' title="Exclude former owners from analysis"></td>';
        html += '</tr>';
      }
      html += '</tbody></table>';
      html += '<p class="muted small" style="margin-top: 8px;">Check "Exclude" for former owners who are no longer in the league — their picks won\'t count toward tendency analysis.</p>';
    } else {
      // No GUIDs available (old data): fall back to name-based mapping
      const histOwners = listHistoricalOwners();
      html += '<p class="warn small">No ESPN owner GUIDs in current data. Re-sync from ESPN to get stable owner IDs, or use the name-based fallback below.</p>';
      html += '<table style="font-size: 12px;"><thead><tr><th>Team Name</th><th>→</th><th>Current Owner</th><th class="num">Picks</th></tr></thead><tbody>';
      for (const h of histOwners) {
        const aliased = _ownerAliases.byName[h];
        const picksByThisName = picks.filter(p => p.owner === h).length;
        html += '<tr>';
        html += '<td>' + esc(h) + '</td>';
        html += '<td class="dim">→</td>';
        html += '<td><select class="hist-alias" data-name="' + esc(h) + '">';
        html += '<option value="">(no alias)</option>';
        for (const o of currentOwners) {
          html += '<option value="' + esc(o) + '"' + (aliased === o ? ' selected' : '') + '>' + esc(o) + '</option>';
        }
        html += '</select></td>';
        html += '<td class="num">' + picksByThisName + '</td>';
        html += '</tr>';
      }
      html += '</tbody></table>';
    }
    html += '</div>';
  }

  // Manual CSV import section
  html += '<div class="card"><h2>Manual CSV Import</h2>';
  html += '<p class="muted small">Alternative to ESPN sync. Expected columns: Year, Owner, Player, Pos, Price, Value (optional), Keeper (optional).</p>';
  html += '<textarea id="hist-csv" rows="6" style="width: 100%; font-family: var(--mono); font-size: 12px;" placeholder="Year,Owner,Player,Pos,Price,Value..."></textarea>';
  html += '<div style="display: flex; gap: 8px; margin-top: 8px; align-items: center;">';
  html += '<input id="hist-year" type="number" placeholder="Year (if not in CSV)" style="width: 200px;">';
  html += '<button class="btn primary" id="hist-import" style="width: auto; padding: 8px 16px;">Import</button>';
  html += '<label class="muted small">Or upload: <input type="file" id="hist-file" accept=".csv,text/csv"></label>';
  html += '</div></div>';

  if (!picks.length) {
    html += '<div class="empty"><p>No draft history yet.</p><p class="small">Import past results above to unlock per-owner tendency profiles.</p></div>';
    root.innerHTML = html;
    wireHistoryHandlers();
    return;
  }

  // Summary
  html += '<div class="card"><h2>Summary</h2><div class="grid cols-4">';
  html += '<div><div class="muted small">Picks</div><div style="font-size: 22px; font-family: var(--mono);">' + picks.length + '</div></div>';
  html += '<div><div class="muted small">Years</div><div style="font-size: 22px; font-family: var(--mono);">' + years.length + '</div><div class="small muted">' + years.join(", ") + '</div></div>';
  const totalSpent = picks.reduce((s, p) => s + p.price, 0);
  html += '<div><div class="muted small">Total $ Spent</div><div style="font-size: 22px; font-family: var(--mono);">$' + totalSpent.toLocaleString() + '</div></div>';
  const owners = Array.from(new Set(picks.map(p => p.owner)));
  html += '<div><div class="muted small">Owners</div><div style="font-size: 22px; font-family: var(--mono);">' + owners.length + '</div></div>';
  html += '</div></div>';

  // Per-owner profiles
  const profiles = computeAllOwnerProfiles();
  html += '<div class="card"><h2>Owner Tendency Profiles</h2>';
  html += '<table><thead><tr>';
  html += '<th>Owner</th><th class="num">Picks</th><th class="num">Avg $</th><th class="num">Max $</th><th class="num">Top-3 Share</th><th>Style</th><th class="num">SP Share</th><th class="num">RP Share</th><th>Spends Most On</th>';
  html += '</tr></thead><tbody>';
  const sorted = Object.values(profiles).sort((a, b) => b.totalSpent - a.totalSpent);
  for (const p of sorted) {
    const styleLabel = p.top3Share > 0.55 ? "★★★ stars+scrubs" : p.top3Share > 0.45 ? "★★ top-heavy" : p.top3Share > 0.35 ? "★ balanced" : "spread";
    const top3Class = p.top3Share > 0.5 ? "bad" : "";
    html += '<tr>';
    html += '<td><strong>' + esc(p.owner) + '</strong></td>';
    html += '<td class="num">' + p.picks + '</td>';
    html += '<td class="num">$' + p.meanPrice.toFixed(1) + '</td>';
    html += '<td class="num">$' + p.maxPrice + '</td>';
    html += '<td class="num ' + top3Class + '">' + (p.top3Share * 100).toFixed(1) + '%</td>';
    html += '<td>' + styleLabel + '</td>';
    html += '<td class="num">' + (p.spSpend * 100).toFixed(1) + '%</td>';
    html += '<td class="num ' + (p.closerBias > 0.10 ? "bad" : "") + '">' + (p.closerBias * 100).toFixed(1) + '%</td>';
    html += '<td>' + esc(p.mostSpentOn || "—") + '</td>';
    html += '</tr>';
  }
  html += '</tbody></table>';
  html += '<p class="muted small" style="margin-top: 10px;">Avg $: average price paid per non-keeper pick. Max $: highest single pick. Top-3 Share: % of total spending concentrated in their top 3 most expensive picks (high = stars+scrubs). SP/RP Share: % of budget on starters/relievers. Profiles automatically apply to mock draft simulations.</p>';
  html += '</div>';

  // Top overpays / underpays (interesting moments)
  const valued = picks.filter(p => p.value > 0);
  if (valued.length) {
    valued.sort((a, b) => (a.value - a.price) - (b.value - b.price));
    html += '<div class="card"><h2>Notable Overpays / Bargains</h2>';
    html += '<div class="grid cols-2">';
    html += '<div><h3>Worst overpays</h3><table style="font-size: 12px;"><thead><tr><th>Player</th><th>Yr</th><th>Owner</th><th class="num">Paid</th><th class="num">Val</th></tr></thead><tbody>';
    for (const p of valued.slice(0, 10)) {
      html += '<tr><td>' + esc(p.player) + '</td><td>' + p.year + '</td><td>' + esc(p.owner) + '</td><td class="num">$' + p.price + '</td><td class="num">$' + p.value + '</td></tr>';
    }
    html += '</tbody></table></div>';
    html += '<div><h3>Best bargains</h3><table style="font-size: 12px;"><thead><tr><th>Player</th><th>Yr</th><th>Owner</th><th class="num">Paid</th><th class="num">Val</th></tr></thead><tbody>';
    for (const p of valued.slice(-10).reverse()) {
      html += '<tr><td>' + esc(p.player) + '</td><td>' + p.year + '</td><td>' + esc(p.owner) + '</td><td class="num">$' + p.price + '</td><td class="num">$' + p.value + '</td></tr>';
    }
    html += '</tbody></table></div>';
    html += '</div></div>';
  }

  root.innerHTML = html;
  wireHistoryHandlers();
}

function wireHistoryHandlers() {
  // ESPN sync
  document.getElementById("hist-espn-sync")?.addEventListener("click", async () => {
    const yearsRaw = document.getElementById("hist-espn-years").value;
    const years = yearsRaw.split(/[,\s]+/).map(s => parseInt(s, 10)).filter(y => y > 2000);
    if (!years.length) { alert("Enter at least one year."); return; }
    const log = document.getElementById("espn-sync-log");
    const lines = [];
    const btn = document.getElementById("hist-espn-sync");
    btn.disabled = true; btn.textContent = "Syncing…";
    try {
      const summary = await syncAllEspnHistory({
        years,
        onProgress: (p) => {
          lines.push(p.year + " · " + p.status + (p.picks ? " (" + p.picks + " picks)" : "") + (p.error ? ": " + p.error : ""));
          log.innerHTML = lines.map(esc).join("<br>");
        },
      });
      lines.push("Done. " + summary.totalPicks + " total picks across " + summary.seasons.length + " seasons.");
      log.innerHTML = lines.map(esc).join("<br>");
    } catch (e) {
      lines.push("Error: " + (e.message || e));
      log.innerHTML = lines.map(esc).join("<br>");
    } finally {
      btn.disabled = false; btn.textContent = "Sync from ESPN";
      renderHistory();
    }
  });
  // Owner alias dropdowns (GUID-based and name-based)
  document.querySelectorAll(".hist-alias-guid").forEach(sel => {
    sel.addEventListener("change", (e) => {
      setOwnerAliasByGuid(e.target.dataset.guid, e.target.value);
    });
  });
  document.querySelectorAll(".hist-exclude").forEach(cb => {
    cb.addEventListener("change", (e) => {
      setOwnerExcluded(e.target.dataset.guid, e.target.checked);
    });
  });
  document.querySelectorAll(".hist-alias").forEach(sel => {
    sel.addEventListener("change", (e) => {
      setOwnerAlias(e.target.dataset.name, e.target.value);
    });
  });
  document.getElementById("hist-import")?.addEventListener("click", () => {
    const text = document.getElementById("hist-csv").value;
    const year = parseInt(document.getElementById("hist-year").value, 10) || null;
    if (!text.trim()) { alert("Paste CSV first."); return; }
    const added = importHistoryCSV(text, year);
    alert("Imported " + added + " picks.");
  });
  document.getElementById("hist-file")?.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const year = parseInt(document.getElementById("hist-year").value, 10) || null;
      const added = importHistoryCSV(reader.result, year);
      alert("Imported " + added + " picks from " + file.name + ".");
    };
    reader.readAsText(file);
  });
  document.getElementById("hist-clear")?.addEventListener("click", () => {
    if (confirm("Clear all draft history?")) clearHistory();
  });
  document.getElementById("hist-clear-top")?.addEventListener("click", () => {
    if (confirm("Clear all draft history?")) clearHistory();
  });
}
