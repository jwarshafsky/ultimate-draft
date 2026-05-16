// Data tab — manages projection, Statcast, and NFBC market price imports.

function renderData() {
  const root = document.getElementById("view-root");
  const meta = getProjectionMeta();
  const nfbcMeta = getNfbcMeta();
  const savantHit = Object.keys(_statcast.hitters).length;
  const savantPit = Object.keys(_statcast.pitchers).length;

  let html = "";

  // Status block
  html += '<div class="card"><h2>Data Status</h2><div class="grid cols-4">';
  html += '<div><div class="muted small">Hitter Projections</div><div style="font-size: 22px; font-family: var(--mono);">' + meta.hitterCount + '</div></div>';
  html += '<div><div class="muted small">Pitcher Projections</div><div style="font-size: 22px; font-family: var(--mono);">' + meta.pitcherCount + '</div></div>';
  html += '<div><div class="muted small">NFBC Market Prices</div><div style="font-size: 22px; font-family: var(--mono);">' + nfbcMeta.count + '</div></div>';
  html += '<div><div class="muted small">Statcast (hit / pit)</div><div style="font-size: 22px; font-family: var(--mono);">' + savantHit + ' / ' + savantPit + '</div></div>';
  html += '</div></div>';

  // === Projections ===
  html += '<div class="card"><h2>FanGraphs Projections</h2>';
  html += '<p class="muted small">Export from FanGraphs Auction Calculator or Projection page. Use your saved settings (12 teams, $260, 70/30 split, OBP/QS/SV+HLD cats — <a href="https://www.fangraphs.com/fantasy-tools/auction-calculator?teams=12&lg=MLB&dollars=260&mb=1&mp=10&msp=5&mrp=5&type=RP&players=&proj=steamer&split=70&points=c%7C1%2C2%2C3%2C4%2C5%7C2%2C3%2C4%2C13%2C14&rep=1&drp=30&pp=C%2CSS%2C2B%2C3B%2COF%2C1B&pos=1%2C1%2C1%2C1%2C5%2C1%2C1%2C1%2C0%2C1%2C6%2C4%2C0%2C0%2C0&sort=&view=0" target="_blank" rel="noopener" style="color: var(--accent);">link</a>).</p>';

  html += '<div class="grid cols-2">';
  // Hitters
  html += '<div><h3>Hitters</h3>';
  html += '<textarea id="hit-csv" rows="5" style="width: 100%; font-family: var(--mono); font-size: 12px;" placeholder="Name,Team,POS,PA,AB,H,R,HR,RBI,SB,BB,OBP,AVG"></textarea>';
  html += '<div style="display: flex; gap: 6px; margin-top: 6px;"><input id="hit-source" placeholder="Source" style="flex: 1;"><button class="btn primary" id="hit-import" style="width: auto;">Import</button></div>';
  html += '<div class="small muted" style="margin-top: 4px;">Or: <input type="file" id="hit-file" accept=".csv,text/csv"></div>';
  html += '</div>';
  // Pitchers
  html += '<div><h3>Pitchers</h3>';
  html += '<textarea id="pit-csv" rows="5" style="width: 100%; font-family: var(--mono); font-size: 12px;" placeholder="Name,Team,POS,IP,SO,W,QS,SV,HLD,ERA,WHIP"></textarea>';
  html += '<div style="display: flex; gap: 6px; margin-top: 6px;"><input id="pit-source" placeholder="Source" style="flex: 1;"><button class="btn primary" id="pit-import" style="width: auto;">Import</button></div>';
  html += '<div class="small muted" style="margin-top: 4px;">Or: <input type="file" id="pit-file" accept=".csv,text/csv"></div>';
  html += '</div>';
  html += '</div></div>';

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
  wireImport("hit-csv", "hit-file", "hit-source", importHittersCSV, "hitters");
  wireImport("pit-csv", "pit-file", "pit-source", importPitchersCSV, "pitchers");
  wireImport("nfbc-csv", "nfbc-file", "nfbc-source", importNfbcCSV, "NFBC prices");
  wireImport("savant-hit-csv", "savant-hit-file", null, importStatcastHittersCSV, "Statcast hitters");
  wireImport("savant-pit-csv", "savant-pit-file", null, importStatcastPitchersCSV, "Statcast pitchers");

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
