// Data tab — projection imports (FanGraphs CSV), data status, manual overrides.

function renderData() {
  const root = document.getElementById("view-root");
  const meta = getProjectionMeta();

  let html = "";

  // Status block
  html += '<div class="card"><h2>Data Status</h2><div class="grid cols-3">';
  html += '<div><div class="muted small">Hitter Projections</div><div style="font-size: 22px; font-family: var(--mono);">' + meta.hitterCount + '</div></div>';
  html += '<div><div class="muted small">Pitcher Projections</div><div style="font-size: 22px; font-family: var(--mono);">' + meta.pitcherCount + '</div></div>';
  html += '<div><div class="muted small">Last Import</div><div style="font-size: 14px;">' + (meta.importedAt ? new Date(meta.importedAt).toLocaleString() : '<span class="dim">never</span>') + '</div></div>';
  html += '</div></div>';

  // Hitter import
  html += '<div class="card"><h2>Import Hitter Projections</h2>';
  html += '<p class="muted small">Export from FanGraphs (Projections → ATC/Steamer/THE BAT X → Download CSV) and paste below. Expected columns: Name, Team, POS, PA, AB, H, R, HR, RBI, SB, BB, OBP, AVG.</p>';
  html += '<textarea id="hit-csv" rows="6" style="width: 100%; font-family: var(--mono); font-size: 12px;" placeholder="Name,Team,POS,PA,AB,H,R,HR,RBI,SB,BB,OBP,AVG..."></textarea>';
  html += '<div style="display: flex; gap: 8px; margin-top: 8px;"><input id="hit-source" placeholder="Source name (e.g. ATC 2026)" style="flex:1;"><button class="btn primary" id="hit-import" style="width: auto; padding: 8px 16px;">Import Hitters</button></div>';
  html += '<div style="margin-top: 6px;"><label class="muted small" style="cursor:pointer;">…or upload CSV file: <input type="file" id="hit-file" accept=".csv,text/csv" style="display: inline-block;"></label></div>';
  html += '</div>';

  // Pitcher import
  html += '<div class="card"><h2>Import Pitcher Projections</h2>';
  html += '<p class="muted small">Expected columns: Name, Team, POS, IP, K/SO, W, QS, SV, HLD, ERA, WHIP.</p>';
  html += '<textarea id="pit-csv" rows="6" style="width: 100%; font-family: var(--mono); font-size: 12px;" placeholder="Name,Team,POS,IP,SO,W,QS,SV,HLD,ERA,WHIP..."></textarea>';
  html += '<div style="display: flex; gap: 8px; margin-top: 8px;"><input id="pit-source" placeholder="Source name" style="flex:1;"><button class="btn primary" id="pit-import" style="width: auto; padding: 8px 16px;">Import Pitchers</button></div>';
  html += '<div style="margin-top: 6px;"><label class="muted small" style="cursor:pointer;">…or upload CSV file: <input type="file" id="pit-file" accept=".csv,text/csv" style="display: inline-block;"></label></div>';
  html += '</div>';

  // Clear button
  if (meta.hitterCount || meta.pitcherCount) {
    html += '<div class="card"><h2>Reset</h2>';
    html += '<button class="btn danger" id="clear-proj">Clear all projections</button>';
    html += '</div>';
  }

  root.innerHTML = html;

  // Wire it
  const wireImport = (textareaId, fileId, sourceId, fn, label) => {
    document.getElementById(textareaId + "-import" === undefined ? null : null);
    const importBtn = document.getElementById(textareaId.split("-")[0] + "-import");
    importBtn.addEventListener("click", () => {
      const text = document.getElementById(textareaId).value;
      const source = document.getElementById(sourceId).value;
      if (!text.trim()) { alert("Paste CSV data first."); return; }
      const count = fn(text, source);
      alert("Imported " + count + " " + label + ".");
    });
    document.getElementById(fileId).addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const source = document.getElementById(sourceId).value || file.name;
        const count = fn(reader.result, source);
        alert("Imported " + count + " " + label + " from " + file.name + ".");
      };
      reader.readAsText(file);
    });
  };
  wireImport("hit-csv", "hit-file", "hit-source", importHittersCSV, "hitters");
  wireImport("pit-csv", "pit-file", "pit-source", importPitchersCSV, "pitchers");

  const clearBtn = document.getElementById("clear-proj");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      if (confirm("Clear all projections?")) clearProjections();
    });
  }
}
