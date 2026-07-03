# Live Draft Sync via ESPN Draft WebSocket — Build Plan

**Status:** SCOPED, not built. Manual pick entry remains the shipping draft-day path.
**Audience:** an Opus build session. This doc is ground truth — protocol facts below are
reverse-engineered from ESPN's own `draft.js` bundle (verified Jul 3 2026), not guessed.
**Author context:** Jeff's Ultimate Draft (personal tool). See `project_ultimate_draft.md`
memory. The proxy is a Cloudflare Worker at `ultimate-draft-proxy.jwarshafsky.workers.dev`.

---

## 0. Why this exists / the honest risk read

The Live Draft tab polls `mDraftDetail` (REST). **Empirically proven Jul 3 2026** (90 polls /
6 min of a live mock draft): that endpoint returns all-placeholder picks (`playerId:-1`)
during a live draft and only fills post-draft. So REST polling CANNOT drive live sync.

The real-time picks flow over an **authenticated, binary-framed WebSocket** — the same
channel third-party draft-sync apps use. This plan builds a relay for it.

**Risks the build session must accept up front:**
- The protocol is **undocumented and binary**; ESPN can change it with no notice.
- It can only be **trusted after a live-draft test** (hard to arrange; see Phase 5).
- If any phase can't be verified against real frames, **STOP and ship manual entry** —
  do not guess the binary decode into production.
- **Non-negotiable:** manual pick entry stays fully working and is the default. Live sync
  is additive, behind a toggle, with an obvious "it stopped — enter manually" fallback.

---

## 1. The protocol (reverse-engineered, verbatim facts)

### 1a. Connect
Client opens ONE WebSocket. URL construction (from `draft.js`):

```
host   = "fantasydraft.espn.com/game-<gameId>/"      // getHost(); "espnqa.com" for QA
url    = wss://<host>/JOIN?1=<gameId>&2=<leagueId>&3=<teamId>&4=<userProfileId>&5=<draftToken>&6=false&7=false&8=KONA&nocache=<rand>
```

- `userProfileId` = the account **SWID/memberId** (e.g. `{8C28BDD5-...}`).
- `gameId`, `draftToken` come from a REST **`draftInit`** call (see 1c).
- `teamId` = the team you're viewing as.

### 1b. Messages (server → client), binary-framed
Message type constants (verbatim):
```js
{ MESSAGE:1, PICK_MADE:2, MEMBER_JOINED:3, MEMBER_LEFT:4, PICK_UNDONE:5 }
```
Frames are **binary**: the client reads fields with a byte reader (`t.readInt()`,
`bytesRead`, custom framing class hierarchy `Ge→We→Ue→Ye`). There is a keepalive
(`sendPing`), `reconnect`/`reconnectInterval` logic, and an **EventSource (SSE) fallback**
(`g.espncdn.com/lm-static/draft/EventSource.js`).

**`PICK_MADE` (type 2)** carries the pick — code references `e.data.pickNumber`, `pick.*`,
`teamId`. The EXACT field order/encoding (opcode byte, length prefix, int widths, how
playerId / bidAmount / teamId are packed) is **NOT known from the minified source** and
MUST be recovered from captured real frames (Phase 1).

### 1c. Token acquisition (must confirm exact shape in Phase 1)
A REST call with the `draftInit` view returns `gameId` + `draftToken`. Likely on the
league draft endpoint (`/apis/v3/games/ffl|flb/seasons/<yr>/segments/0/leagues/<id>?view=...`).
Confirm the exact path + response JSON path to `draftToken`/`gameId` by watching the
network tab right before the socket opens.

---

## 2. Architecture

Browser can't open this socket (auth cookie, cross-origin, ESPN one-session limit). Route
through Cloudflare. A plain Worker is request-scoped and can't hold a multi-hour socket, so:

```
Live Draft tab ──HTTP poll every 2–3s──► Worker ──► Durable Object (LiveDraftRelay)
                                                        │ holds ONE wss to ESPN
   (or WS to the DO, phase 4)                           │ decodes PICK_MADE → array
                                                        ▼
                                              ESPN fantasydraft.espn.com  (wss, binary)
```

- **Durable Object `LiveDraftRelay`** (keyed by leagueId): on start, does `draftInit` →
  opens the ESPN wss → on each `PICK_MADE`/`PICK_UNDONE`, updates an in-memory + storage
  list of normalized picks `{playerId, playerName, teamId, bidAmount, overallPickNumber}`.
  Handles ping keepalive + reconnect. Exposes `GET /relay/picks?leagueId=` (returns
  accumulated picks + status) and `POST /relay/start` / `POST /relay/stop`.
- ESPN cookie stays server-side (already a Worker secret: `ESPN_S2`/`ESPN_SWID`).
- Auth: reuse the existing `x-ud-key` shared-secret gate.

Cloudflare specifics the build session must handle:
- Workers open outbound WS via `fetch(url, { headers: { Upgrade: "websocket" }})` →
  `resp.webSocket.accept()`. Verify ESPN doesn't require an `Origin`/`Sec-WebSocket-Protocol`
  the Worker must forge (capture the browser's handshake headers in Phase 1 and mirror them).
- DO needs `wrangler.toml` migration (new_sqlite_classes) + binding. Confirm the account
  plan allows Durable Objects.

---

## 3. Build phases (each has a hard acceptance gate — do not proceed if it fails)

### Phase 0 — Prep (no ESPN live draft needed)
- Read `proxy/worker.js` (auth gate, `espnFetch`, `proxyEspnDraft`) and `js/data/espn.js`
  (`processEspnPicks`, `startEspnPolling`) — the relay's output must match the shape
  `processEspnPicks` already consumes so the UI needs ~zero change.
- Add DO scaffolding + `wrangler.toml` binding. Deploy a no-op DO. **Gate:** DO deploys and
  a `GET /relay/picks` returns `{picks:[], status:"idle"}`.

### Phase 1 — Capture real frames (REQUIRES a live mock draft; the crux)
This is the make-or-break research step. Do it during an ESPN **football mock** (fills with
bots on demand, year-round; Jeff can start one — league is disposable).
- In the browser DevTools → Network → WS, open the draft, record the `/JOIN` frames.
- Capture: the `draftInit` request+response (exact path, where `draftToken`/`gameId` live),
  the WS handshake request headers, and several raw `PICK_MADE` binary frames alongside the
  human-readable pick they correspond to (watch the draft board).
- Decode the framing: opcode, length, field encoding for pickNumber/teamId/playerId/bidAmount.
  Write a `decodePickMade(bytes)` with unit tests using the captured frames as fixtures.
- **Gate:** given captured bytes, `decodePickMade` reproduces the known picks exactly. If the
  framing can't be decoded confidently, STOP — document findings, ship nothing.

### Phase 2 — DO connects and decodes (server-side, headless)
- Implement `LiveDraftRelay`: `draftInit` → open wss (mirror captured handshake headers +
  cookie) → decode PICK_MADE/PICK_UNDONE → maintain normalized pick list → ping + reconnect.
- Test with a `wrangler dev` DO against a live mock (Jeff starts one; you drive via curl to
  `/relay/start` then poll `/relay/picks`).
- **Gate:** during a live mock, `/relay/picks` grows in real time and matches the draft board,
  including a `PICK_UNDONE` correctly removing a pick.

### Phase 3 — Wire into the app (minimal UI change)
- In `js/data/espn.js`, add a polling mode that hits `/relay/picks` instead of `/espn/draft`
  and feeds results through the EXISTING `processEspnPicks` (de-dupe by playerId already
  handled). Keep the 5s poll; the DO is doing the realtime part.
- Live Draft tab: a toggle "ESPN live sync (beta)" that starts the relay + polls it; a clear
  status line (connected / N picks / stale) and a one-click "stop & enter manually".
- **Gate:** with the relay running, picks appear in Recent Picks within a few seconds of the
  bot drafting; stopping the toggle reverts to pure manual with no state loss.

### Phase 4 — (optional) push instead of poll
- Replace browser→Worker polling with a WS from the tab to the DO for instant updates.
  Nice-to-have; only if Phase 3 latency feels bad. Skippable.

### Phase 5 — Draft-day hardening
- Reconnect storms, token expiry mid-draft, DO eviction/restart re-syncs from `mDraftDetail`
  snapshot on reconnect, kill-switch that flips the tab to manual instantly.
- Pre-draft checklist item: verify the ESPN cookie in the Worker is fresh (they expire ~yearly).
- **Gate:** kill the DO mid-draft → tab shows "sync lost, enter manually", no picks lost.

---

## 4. Integration facts (so Opus doesn't hunt)
- Normalized pick shape the UI already eats (`js/data/espn.js` `processEspnPicks`):
  `{ playerId, playerName, teamId, bidAmount, overallPickNumber }`. Match it exactly.
- `espnTeamIdToOwnerId()` maps ESPN teamId→internal owner id (real league only; test mode
  returns generic — see `leagueOverrideActive()`).
- Sport is now configurable: `proxyEspnDraft` takes `?sport=ffl|flb` (`espnBaseForSport`).
- Proxy secrets already set: `ESPN_S2`, `ESPN_SWID`, `UD_PROXY_KEY`, `ALLOWED_ORIGIN`,
  `ANTHROPIC_API_KEY`. Deploy: `cd proxy && CLOUDSDK_PYTHON=…python@3.12 npx wrangler deploy`.
- Standalone probe already exists: `draft-feed-test.html`.

## 5. Effort & go/no-go
- Phase 1 (frame capture/decode) is 60% of the risk and ~40% of the time. If it fails, total
  cost is small and we've lost nothing.
- Rough estimate assuming frames decode cleanly: Phase 0–3 ≈ a focused multi-session build;
  Phase 1 gated on access to a live mock draft.
- **Decision rule:** commit to Phases 0–1 first (cheap, answers "is the binary decodable?").
  Only greenlight Phases 2–5 if Phase 1's gate passes.

## 6. What NOT to do
- Don't ship a guessed binary decoder. Don't remove/By-pass manual entry. Don't hold the ESPN
  cookie anywhere client-side. Don't poll `mDraftDetail` for live picks (proven dead).
