// Position boards — auto-tiered per-position list with:
//   - $3+ tier cliff detection
//   - Per-tier "max bid" heuristic (highest player in tier - 1)
//   - Keeper highlighting
//   - Inflation-aware values
//   - Tier-level color coding (T1 red = must buy one, T5 green = endgame only)

const TIER_COLORS = {
  T1: "var(--bad)",
  T2: "var(--warn)",
  T3: "var(--keeper)",
  T4: "var(--accent)",
  T5: "var(--good)",
};

function renderBoard() {
  const root = document.getElementById("view-root");
  if (getValues().length === 0) {
    root.innerHTML = '<div class="empty"><p>No values yet.</p><p class="small">Import projections in the Data tab.</p></div>';
    return;
  }
  const inflation = computeTieredInflation();
  const keptNames = new Set(collectKeepers().map(k => k.name));
  const positions = ["C", "1B", "2B", "3B", "SS", "OF", "SP", "RP"];
  const depth = { C: 18, "1B": 22, "2B": 22, "3B": 22, "SS": 22, OF: 75, SP: 80, RP: 50 };

  // Per-position tier breakdown panel at top
  let html = '<div class="card"><h2>Tier Map</h2>';
  html += '<p class="muted small">Color = tier (T1 red elite → T5 green endgame). Max bid = highest inflated value in tier (you want to buy at or below).</p>';
  html += '<table style="font-size: 12px;"><thead><tr>';
  html += '<th>Pos</th><th>T1 $35+</th><th>T2 $20-34</th><th>T3 $10-19</th><th>T4 $5-9</th><th>T5 $1-4</th></tr></thead><tbody>';
  for (const pos of positions) {
    const all = getValues().filter(p => p.posKey === pos);
    const buckets = { T1: [], T2: [], T3: [], T4: [], T5: [] };
    for (const p of all) buckets[tierForValue(p.value)].push(p);
    html += '<tr><td><strong>' + pos + '</strong></td>';
    for (const tier of ["T1", "T2", "T3", "T4", "T5"]) {
      const b = buckets[tier];
      if (!b.length) { html += '<td class="dim">—</td>'; continue; }
      const maxInf = Math.max(...b.map(p => inflatedValue(p, inflation)));
      html += '<td><span style="color: ' + TIER_COLORS[tier] + ';">' + b.length + 'p</span> <span class="dim small">max $' + maxInf.toFixed(0) + '</span></td>';
    }
    html += '</tr>';
  }
  html += '</tbody></table></div>';

  // Side-by-side position lists
  html += '<div class="grid cols-4">';
  for (const pos of positions) {
    const all = getValues().filter(p => p.posKey === pos);
    const list = all.slice(0, depth[pos] || 30);
    // Tier cliffs: gap >= $3 between consecutive inflated values
    const cliffs = new Set();
    for (let i = 1; i < list.length; i++) {
      const prevInf = inflatedValue(list[i-1], inflation);
      const curInf = inflatedValue(list[i], inflation);
      if (prevInf - curInf >= 3) cliffs.add(i);
    }
    html += '<div class="card" style="padding: 10px 12px;">';
    html += '<h3>' + pos + ' <span class="muted small">· ' + list.length + '</span></h3>';
    html += '<table style="font-size: 12px;"><tbody>';
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const inf = inflatedValue(p, inflation);
      const isKept = keptNames.has(p.name);
      const tier = tierForValue(p.value);
      const cliff = cliffs.has(i) ? ' style="border-top: 2px solid var(--accent);"' : '';
      html += '<tr' + cliff + (isKept ? ' class="kept"' : '') + '>';
      html += '<td style="padding: 3px 4px;"><span style="color: ' + TIER_COLORS[tier] + '; font-size: 10px;">' + tier + '</span></td>';
      html += '<td style="padding: 3px 4px;">' + esc(p.name) + (isKept ? ' <span style="color: var(--keeper);">★</span>' : '') + '</td>';
      html += '<td class="num" style="padding: 3px 4px;">$' + p.value.toFixed(0) + '</td>';
      html += '<td class="num" style="padding: 3px 4px;' + (inf - p.value > 0 ? 'color: var(--good);' : '') + '">$' + inf.toFixed(0) + '</td>';
      html += '</tr>';
    }
    html += '</tbody></table>';
    html += '</div>';
  }
  html += '</div>';

  root.innerHTML = html;
}
