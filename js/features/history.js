// History tab — draft history import + owner tendency analysis. Shows each
// owner's behavioral profile (aggression, position bias, closer love, stars-
// and-scrubs tendency). Profiles plug into the mock engine automatically.

function renderHistory() {
  const root = document.getElementById("view-root");
  const picks = _history.picks;
  const years = _history.meta.years || [];

  let html = '';

  // Import section
  html += '<div class="card"><h2>Import Draft History</h2>';
  html += '<p class="muted small">Paste a CSV of past auction results to fit per-owner tendency profiles. Expected columns: Year, Owner, Player, Pos, Price, Value (optional), Keeper (optional). Multiple years can be combined in one CSV.</p>';
  html += '<textarea id="hist-csv" rows="6" style="width: 100%; font-family: var(--mono); font-size: 12px;" placeholder="Year,Owner,Player,Pos,Price,Value..."></textarea>';
  html += '<div style="display: flex; gap: 8px; margin-top: 8px; align-items: center;">';
  html += '<input id="hist-year" type="number" placeholder="Year (if not in CSV)" style="width: 200px;">';
  html += '<button class="btn primary" id="hist-import" style="width: auto; padding: 8px 16px;">Import</button>';
  html += '<label class="muted small">Or upload: <input type="file" id="hist-file" accept=".csv,text/csv"></label>';
  if (picks.length) {
    html += '<button class="btn danger" id="hist-clear" style="margin-left: auto;">Clear all history</button>';
  }
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
  html += '<th>Owner</th><th class="num">Picks</th><th class="num">Avg Aggression</th><th class="num">Stars/Scrubs</th><th class="num">RP Share</th><th>Spends Most On</th><th class="num">T1 Avg</th><th class="num">T5 Avg</th>';
  html += '</tr></thead><tbody>';
  const sorted = Object.values(profiles).sort((a, b) => b.totalSpent - a.totalSpent);
  for (const p of sorted) {
    const ssLabel = p.starsScrubs > 0.7 ? "★★★ stars+scrubs" : p.starsScrubs > 0.5 ? "★★ tilted" : "★ balanced";
    const aggClass = p.aggression > 1.1 ? "bad" : p.aggression < 0.95 ? "good" : "";
    html += '<tr>';
    html += '<td><strong>' + esc(p.owner) + '</strong></td>';
    html += '<td class="num">' + p.picks + '</td>';
    html += '<td class="num ' + aggClass + '">' + p.aggression.toFixed(2) + 'x</td>';
    html += '<td class="num">' + ssLabel + '</td>';
    html += '<td class="num ' + (p.closerBias > 0.10 ? "bad" : "") + '">' + (p.closerBias * 100).toFixed(1) + '%</td>';
    html += '<td>' + esc(p.mostSpentOn || "—") + '</td>';
    html += '<td class="num">$' + (p.tierShape.T1?.avg || 0).toFixed(0) + ' <span class="muted small">(' + (p.tierShape.T1?.count || 0) + ')</span></td>';
    html += '<td class="num">$' + (p.tierShape.T5?.avg || 0).toFixed(0) + ' <span class="muted small">(' + (p.tierShape.T5?.count || 0) + ')</span></td>';
    html += '</tr>';
  }
  html += '</tbody></table>';
  html += '<p class="muted small" style="margin-top: 10px;">Aggression: avg price paid / avg projected value. >1.10 = overpayer, <0.95 = bargain hunter. Stars/Scrubs: coefficient of variation in their prices. RP Share: % of budget spent on relievers. Profiles automatically apply to mock draft simulations.</p>';
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
}
