// Player notes & tags layer. Per-player annotations stored in localStorage so
// the tool remembers what you flagged across sessions. Tags drive inline icons
// in every player table and bias the nomination assistant + AI assistant.
//
// Available tags (free to extend):
//   love       ❤  high priority to acquire
//   avoid      🚫 do not draft
//   sleeper    💤 cheap upside bet
//   breakout   📈 expecting jump in production
//   injury     🩹 health risk
//   target     ⭐ on draft-day target list

const NOTES_KEY = "ud_player_notes_v1";

const _notes = {
  byName: {}, // { normalizedKey: { tags: ["love","sleeper"], note: "string" } }
};

const TAG_DEFS = {
  love:     { icon: "❤",  color: "var(--bad)",  label: "Love" },
  avoid:    { icon: "🚫", color: "var(--text-3)", label: "Avoid" },
  sleeper:  { icon: "💤", color: "var(--accent)", label: "Sleeper" },
  breakout: { icon: "📈", color: "var(--good)", label: "Breakout" },
  injury:   { icon: "🩹", color: "var(--warn)", label: "Injury risk" },
  target:   { icon: "⭐", color: "var(--keeper)", label: "Target" },
};
const TAG_ORDER = ["target", "love", "sleeper", "breakout", "injury", "avoid"];

function notesKey(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function loadNotesFromStorage() {
  try {
    const v = JSON.parse(localStorage.getItem(NOTES_KEY) || "null");
    if (v && typeof v === "object") _notes.byName = v.byName || v;
  } catch (e) {
    _notes.byName = {};
  }
}

function saveNotesToStorage() {
  localStorage.setItem(NOTES_KEY, JSON.stringify({ byName: _notes.byName }));
}

function getPlayerNote(name) {
  return _notes.byName[notesKey(name)] || { tags: [], note: "" };
}

function setPlayerNote(name, patch) {
  const k = notesKey(name);
  const cur = _notes.byName[k] || { tags: [], note: "" };
  const next = { ...cur, ...patch };
  // Empty cleanup
  if ((!next.tags || !next.tags.length) && !next.note) {
    delete _notes.byName[k];
  } else {
    _notes.byName[k] = next;
  }
  saveNotesToStorage();
  if (typeof rerender === "function") rerender();
}

function toggleTag(name, tag) {
  const cur = getPlayerNote(name);
  const tags = cur.tags || [];
  const i = tags.indexOf(tag);
  if (i >= 0) tags.splice(i, 1); else tags.push(tag);
  setPlayerNote(name, { tags });
}

// Returns HTML for inline icons next to a player name in tables.
function renderTagIcons(name, opts) {
  const note = getPlayerNote(name);
  if (!note.tags?.length && !note.note) return "";
  let html = "";
  for (const tag of TAG_ORDER) {
    if (note.tags.includes(tag)) {
      const def = TAG_DEFS[tag];
      html += '<span title="' + def.label + '" style="color: ' + def.color + '; margin-left: 4px; font-size: 11px;">' + def.icon + '</span>';
    }
  }
  if (note.note) html += '<span title="' + esc(note.note).replace(/"/g, "&quot;") + '" style="margin-left: 4px; font-size: 11px; color: var(--text-3); cursor: help;">📝</span>';
  return html;
}

// Returns all flagged player names — handy for filtering and AI prompts.
function getFlaggedPlayers(tag) {
  const out = [];
  for (const [k, v] of Object.entries(_notes.byName)) {
    if (!tag || (v.tags && v.tags.includes(tag))) {
      out.push({ key: k, ...v });
    }
  }
  return out;
}

// Modal HTML to edit notes for a player. Called from anywhere — give it a
// player name and it'll show the editor.
function openNoteEditor(playerName) {
  const note = getPlayerNote(playerName);
  // Build a simple overlay
  let host = document.getElementById("note-modal");
  if (host) host.remove();
  host = document.createElement("div");
  host.id = "note-modal";
  host.className = "modal-host";
  host.innerHTML = `
    <div class="modal-bg"></div>
    <div class="modal-card">
      <h3>${esc(playerName)}</h3>
      <div class="tag-row">
        ${TAG_ORDER.map(tag => {
          const def = TAG_DEFS[tag];
          const on = (note.tags || []).includes(tag);
          return `<button class="tag-btn${on ? " on" : ""}" data-tag="${tag}" style="color: ${def.color};">${def.icon} ${def.label}</button>`;
        }).join("")}
      </div>
      <textarea id="note-text" rows="4" style="width: 100%; margin-top: 12px;" placeholder="Free-text note…">${esc(note.note || "")}</textarea>
      <div style="display: flex; gap: 8px; margin-top: 12px; justify-content: flex-end;">
        <button class="btn" id="note-close">Close</button>
        <button class="btn primary" id="note-save" style="width: auto; padding: 8px 16px;">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(host);
  host.querySelector(".modal-bg").addEventListener("click", () => host.remove());
  host.querySelector("#note-close").addEventListener("click", () => host.remove());
  host.querySelectorAll(".tag-btn").forEach(b => {
    b.addEventListener("click", () => {
      b.classList.toggle("on");
    });
  });
  host.querySelector("#note-save").addEventListener("click", () => {
    const tags = Array.from(host.querySelectorAll(".tag-btn.on")).map(b => b.dataset.tag);
    const note = host.querySelector("#note-text").value;
    setPlayerNote(playerName, { tags, note });
    host.remove();
  });
}

loadNotesFromStorage();
