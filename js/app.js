// Ultimate Draft — top-level shell. Wires auth, view routing, and data load.

let currentView = "overview";

const VIEWS = {
  overview:  { render: () => renderOverview() },
  standings: { render: () => renderStandings() },
  keepers:   { render: () => renderKeepers() },
  values:    { render: () => renderValues() },
  board:     { render: () => renderBoard() },
  compare:   { render: () => renderCompare() },
  trade:     { render: () => renderTrade() },
  scenarios: { render: () => renderScenarios() },
  mock:      { render: () => renderMock() },
  draft:     { render: () => renderDraft() },
  roster:    { render: () => renderRoster() },
  history:   { render: () => renderHistory() },
  data:      { render: () => renderData() },
  settings:  { render: () => renderSettings() },
};

function switchView(name) {
  if (!VIEWS[name]) name = "overview";
  currentView = name;
  document.querySelectorAll(".tab").forEach(t => {
    t.classList.toggle("active", t.dataset.view === name);
  });
  const root = document.getElementById("view-root");
  root.innerHTML = '<div class="loading">Loading…</div>';
  try {
    VIEWS[name].render();
  } catch (e) {
    console.error(e);
    root.innerHTML = '<div class="empty"><p>View error:</p><p class="small">' + (e.message || e) + '</p></div>';
  }
}

function rerender() {
  if (!dataReady()) return;
  switchView(currentView);
}

function initApp() {
  // Auth UI
  document.getElementById("auth-google").addEventListener("click", signInGoogle);
  document.getElementById("auth-magic").addEventListener("click", () => {
    const email = document.getElementById("auth-email").value;
    sendMagicLink(email);
  });
  document.getElementById("auth-email").addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("auth-magic").click();
  });
  document.getElementById("sign-out").addEventListener("click", signOut);
  document.querySelectorAll(".tab").forEach(t => {
    t.addEventListener("click", () => switchView(t.dataset.view));
  });

  // Auth-driven shell visibility
  onAuthChange((user) => {
    const gate = document.getElementById("auth-gate");
    const app = document.getElementById("app");
    if (user) {
      gate.hidden = true;
      app.hidden = false;
      const sub = document.getElementById("brand-sub");
      sub.textContent = "· " + (user.email.split("@")[0]);
      // Kick off data load and realtime subscriptions.
      loadLeagueData();
      subscribeRealtime();
    } else {
      gate.hidden = false;
      app.hidden = true;
      unsubscribeRealtime();
    }
  });

  // Re-render when league data updates
  onDataChange(() => rerender());

  // Also rerender when projections load
  if (typeof onProjectionsChange === "function") {
    onProjectionsChange(() => rerender());
  }
}

document.addEventListener("DOMContentLoaded", initApp);
