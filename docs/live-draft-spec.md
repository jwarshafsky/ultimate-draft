# Live Draft — Ground-Truth Specification

**Status:** Phase 0 deliverable of `live-draft-perfection-plan.md`. This document
defines what the Live Draft feature is *supposed* to do, as numbered, testable
statements. Every later phase cites these numbers. A behavior that contradicts a
statement here is a bug; a real behavior this doc missed gets added here first.

**Scope:** the Live Draft tab (Setup lobby, Draft Mode cockpit, manual-entry
fallback), the Keeper Edge extension pipeline that feeds it (`draft-socket-capture.js`,
`draft-bridge.js`, `ud-bridge.js`), and the Supabase draft-event mirror. Out of
scope: the Mock Draft simulator (separate feature), luxury-tax logic (lives in
The League App), non-draft tabs.

**How to read a statement:** `S-NNN. When <condition>, the system MUST <behavior>.`
Each is meant to be checkable by a script or a scripted preview walk. "MUST NOT"
statements are equally testable (the forbidden thing must never be observed).

---

## Plain-English summary (for Jeff — read and correct this)

The Live Draft tab is your draft-day cockpit. You paste your ESPN draft-room
link, open the ESPN draft in another tab, and the Keeper Edge browser extension
quietly watches ESPN's own draft feed and copies every nomination, bid, and
completed pick into this app — you never type picks. The app shows who's on the
clock, the live bidding, your budget and max bid, a recommended bid, and the best
available players, all updating by themselves.

There are three modes. **Off** ignores everything. **Test** is for practice
("mock") drafts — the app treats it as twelve anonymous "Team 1..12", everyone
starts at $260, there are no keepers, and the full player pool is available; none
of your real leaguemates' names, budgets, or keepers ever appear. **Real** is
only for your actual league (ID 1200) — real owners, your Keepers-tab keepers,
traded-dollar budgets — and it refuses picks from any other league, so a stray
practice run can never contaminate draft day.

Your keepers come entirely from the **Keepers tab** — nothing else. A checked
major keeper fills a slot at his salary; a minor-league keeper is stashed for $0
and isn't in the pool; anyone unchecked is draftable. No "league roster" or
"call-up" shortcuts.

It's built to survive chaos: if the ESPN tab or app reloads, it recovers
automatically from ESPN's own full-state snapshot. An old capture (over 15 minutes
with no live tab) shows "Last capture… (not live)" and a Clear button instead of
faking "live." A quiet lot says "paused," not blank. If the commissioner undoes a
pick, the app flags it and removes it in one click, and it won't creep back. A
manual pick-entry view is always one click away, and everything captured is saved
permanently to your Supabase database for later analysis.

**If any of the above is wrong or not what you want, tell me — this is the
contract everything else gets tested against.**

---

## 1. Modes (Off / Test / Real)

Feed mode is stored in `localStorage["ud_feed_mode"]` and is one of `off`,
`test`, `real` (`getFeedMode` / `setFeedMode` in `draft.js`).

S-001. When `ud_feed_mode` is unset or holds any value other than `test`/`real`, `getFeedMode()` MUST return `"off"`.
S-002. When `setFeedMode(m)` is called with anything other than `"test"` or `"real"`, it MUST persist `"off"`.
S-003. When `setFeedMode("real")` is called, it MUST clear any test-league override (`setLeagueOverride("")`) so lookups use the real league.
S-004. `draftTestMode()` MUST return true if and only if a test-league override is active (`leagueOverrideActive()`) OR `getFeedMode() === "test"`.
S-005. The real home league id MUST be 1200 (`UD_HOME_LEAGUE_ID`); the tool MUST treat 1200 as "Real" everywhere it distinguishes real from test.
S-006. When mode is `off`, incoming `draftFeed` messages MUST be ignored (`_applyDraftFeed` returns without ingesting).
S-007. When mode is `off`, incoming `draftEvents`/`draftInit` MUST NOT be accepted or logged (`_dlogAccepts` returns false).
S-008. When mode is `real`, a `draftFeed` whose `leagueId` is not 1200 MUST be rejected (no picks ingested).
S-009. When mode is `real`, a `draftEvents`/`draftInit` stream whose `leagueId` is not 1200 MUST be rejected (`_dlogAccepts` returns false).
S-010. When mode is `test`, feed/events from ANY league id MUST be accepted.
S-011. When `draftTestMode()` is true, `draftExcludedNames()` MUST return an empty set (full pool, no keeper exclusions).
S-012. When `draftTestMode()` is true, `_inflationKeeperSelections()` MUST return `{}` (no keepers feed inflation/budget math).
S-013. When `draftTestMode()` is true, `computeTeamBudgets()` MUST give every team exactly `LEAGUE.draftBudget` (=$260) with zero adjustment.
S-014. When `draftTestMode()` is true, `computeLiveTeamStates()` MUST use no keepers and a $260 base with zero budget adjustment for every team.
S-015. When `draftTestMode()` is true, `teamOpenSlotProfile()` MUST use `{}` selections (no kept players).
S-016. When `draftTestMode()` is true, `processEspnPicks` MUST attribute each pick to a generic `"espn:<teamId>"` team, never to a real owner id.
S-017. When `draftTestMode()` is true, no rendered pick/team label anywhere (Recent Picks, team strip, ticker, hero, debrief) MUST display a real owner name; it MUST use "Team N".
S-018. When `draftTestMode()` is true, no output object exposed to the AI context or standings MUST contain any of the 12 real owner ids/names (matt, saxton, sam, glix, jeff, aj, corey, jd, wein, klin, dave, jtl).
S-019. When mode is Real (not test), team labels, budgets, and keepers MUST use the real league's 12 owners and their Keepers-tab keepers.
S-020. The five engine seams (`draftExcludedNames`, `_inflationKeeperSelections`, `computeLiveTeamStates`, `teamOpenSlotProfile`, `processEspnPicks`) MUST each branch on `draftTestMode()`; nothing else in the draft engines may hardcode real-owner assumptions.

## 2. Draft context — teams and "me"

S-021. In Real mode, `draftTeams()` MUST return `LEAGUE.teams` (the 12 real owners).
S-022. In Test mode, `draftTeams()` MUST synthesize generic teams from the distinct ESPN team ids observed in `_liveDraft.picks` and `_dlog.events` (ids 1..20), each `{ id:"espn:N", name/owner:"Team N", budget-context $260 }`.
S-023. In Test mode with no observed ids, `draftTeams()` MUST default to Team 1..12.
S-024. In Test mode, the my-seat id from `ud_test_my_team` (`getMyDraftEspnId()`) MUST be included as a team even before it bids, and flagged `isMe`.
S-025. `setMyDraftEspnId(v)` MUST persist a positive integer to `ud_test_my_team` and MUST remove the key for any non-positive/blank value.
S-026. In Real mode, `getMyDraftTeam()` MUST return the real "me" team (`getMyTeam()`).
S-027. In Test mode, `getMyDraftTeam()` MUST return the synthesized team flagged `isMe`, or `null` if no my-seat is set; me-specific panels MUST degrade gracefully (no crash) when it is null.
S-028. `draftTeamLabel(teamId)` MUST resolve `"espn:N"` ids to "Team N" and real ids to the owner name.

## 3. Keeper source of truth

The Keepers tab (`getEffectiveKeeperSelections`, backed by `ud_my_keepers_v1`) is
the ONLY source. Mocks have no keepers (§1).

S-029. In Real mode, keepers MUST come from `getEffectiveKeeperSelections()` (Jeff's checked keepers), never backfilled from league-site marks.
S-030. A player checked as a major keeper (not flagged minor) MUST be treated as filling an ML slot at his current keeper salary (`getCurrentKeeperSalary`, else $0 fallback).
S-031. A player checked and flagged minor (`minorKeeper`) MUST be treated as stashed: cost $0, NO ML slot consumed, and NOT auctionable (excluded from the pool).
S-032. A player left unchecked on the Keepers tab MUST be draftable (present in `availableDraftPool()` / not in `draftExcludedNames()`).
S-033. A keeper Jeff flagged ineligible (`isMyIneligible`) MUST be excluded from the effective keeper set (i.e. becomes draftable).
S-034. `draftExcludedNames()` in Real mode MUST equal the normalized-name set of all `collectKeepers()` (major + minor), and nothing else.
S-035. The system MUST NOT consult league rosters, in-season call-up lists, or any "Call-ups" store to build the off-board set; the deleted Call-ups feature (removed 2026-07-04) MUST NOT return.
S-036. Keeper name matching for pool exclusion MUST use normalized names (`normalizePlayerName`) so accents/suffixes cannot leak a kept player back into the pool.
S-037. In `computeLiveTeamStates`, minor keepers MUST NOT consume an ML slot (only `f.keeper` entries count toward `slotsRemaining`).
S-038. When zero keepers are checked (Real mode), keeper inflation MUST read exactly 1.00× (empty effective set → baseline).

## 4. Feed lifecycle

The extension writes three chrome.storage keys (`udDraftFeed`, `udDraftEvents`,
`udDraftInitState`) plus a heartbeat (`udDraftTab`); `ud-bridge.js` forwards them
to the app.

S-039. The extension MUST re-broadcast every decoded draft frame except `CLOCK` via `postMessage({__udDraft:true,...})`.
S-040. `CLOCK` frames MUST NOT be stored, but MUST emit a throttled `LIVE` liveness ping (≤ one per 5s) so the watchdog can tell "paused" from "pipe broken".
S-041. `udDraftFeed` MUST contain completed picks only (SOLD + INIT backfill); the event log `udDraftEvents` MUST contain the full stream with per-event `seq` and `at` timestamps.
S-042. A completed pick (SOLD) MUST be flushed to chrome.storage immediately, not left on the 700ms coalescing timer.
S-043. An INIT frame MUST be flushed immediately.
S-044. On `pagehide` (tab close/reload), the extension MUST flush pending writes so the last ≤700ms of events are not lost.
S-045. When a restored event log is loaded on tab startup, `nextSeq` MUST jump forward by 100 so seq numbers already seen by the app/Supabase can never be reused.
S-046. Each event's `seq` MUST be assigned monotonically increasing within a session (`elog.nextSeq++`).
S-047. The event log MUST be capped at 15000 events (`EVENT_CAP`), dropping oldest first.
S-048. The extension MUST heartbeat `udDraftTab` (with `at` and `lastFrameAt`) every ~8s while an ESPN draft tab is open.
S-049. `draftTabOpen()` MUST return true only if a heartbeat was seen within the last 25s.
S-050. The app MUST auto-detect the ESPN draft tab's league id and sport from the heartbeat and surface them.

### Staleness gating

S-051. A `draftFeed` whose freshest timestamp (max of `updatedAt` and any pick `ts`) is older than 15 minutes AND no ESPN draft tab is open MUST NOT be ingested.
S-052. Under S-051 the panel MUST show "Last capture: league X — N picks, <age> ago (not live)" with a "Clear captured feed" button, and MUST NOT show "● Live".
S-053. A capture that is stale by time but has a live ESPN tab open (`draftTabOpen()` true) MUST still be ingestible (the tab, not age, decides "live").
S-054. Only when connected AND count > 0 AND not stale MUST the panel show the green "● Live — capturing league X: N picks" state.

### Clear / rotation round-trips

S-055. "Clear captured feed" MUST postMessage `{source:"ud-app",type:"clearFeed"}` to `ud-bridge.js`.
S-056. On `clearFeed`, `ud-bridge.js` MUST remove `udDraftFeed`/`udDraftEvents`/`udDraftInitState`/`udDraftInit`, set a `udFeedCleared` marker, reset its delta cursor (`eKey=""`,`eSeq=0`), and post `feedCleared` back.
S-057. On the `udFeedCleared` storage change, `draft-bridge.js` MUST drop its in-memory `elog`/`feed` so its next flush cannot resurrect the cleared data.
S-058. On receiving `feedCleared`, the app MUST reset `_dlog` (leagueId/startedAt/events/initState) and `_feed` state, remove the local event backup, and re-render if on the draft view.
S-059. "Clear captured feed" MUST NOT delete `_liveDraft.picks` (the recorded picks); only the captured feed/event log is cleared.
S-060. A NEW draft on the SAME league (INIT reports far fewer picks than the stored feed AND the stored feed is >60 min old) MUST rotate both stores: fresh `startedAt` (→ fresh Supabase session) and fresh `seen` map (→ fresh dedup).
S-061. Rotation MUST NOT occur merely because INIT has fewer picks; the stored-feed-stale (>60 min) condition MUST also hold.
S-062. On the app side, an incoming event stream whose `(leagueId, startedAt)` differs from `_dlog`'s current MUST be treated as a new stream and reset `_dlog.events`.

### INIT backfill & reconciliation

S-063. An INIT frame MUST parse ESPN's full pick list (`parseInitPicks`) and backfill any picks not already in `feed.seen` (late-join / reconnect recovery).
S-064. INIT-backfilled picks MUST be marked (`backfill:true`) and deduped by playerId in the feed's `seen` map.
S-065. The app MUST store the latest INIT pick list as `_dlog.initState` for undo reconciliation.
S-066. `_feedRequestSync()` (app "Re-sync") MUST ping the bridge, which MUST re-push the full current feed/events/init (`pushAll(true)`).
S-067. On app load, if the extension bridge loaded first, a one-time `_feedRequestSync()` MUST fire (~800ms) so the app isn't left blank.

## 5. Pick integrity

S-068. Completed picks MUST be deduped by ESPN `playerId` + lot `seq`: the same SOLD frame repeated (same playerId+seq) MUST be dropped.
S-069. A re-sale of the same player at a DIFFERENT seq (undo → re-nominate → re-sold) MUST REPLACE the stale pick in the feed, not be swallowed.
S-070. `processEspnPicks` MUST dedupe against existing `_liveDraft.picks` by `espnPlayerId` (no duplicate pick rows for one player).
S-071. Each recorded pick MUST carry `espnPlayerId` and (when present) `espnSeq` so re-sales vs repeats are distinguishable.
S-072. When a held pick's feed record changes (different seq, price, or teamId), `_applyDraftFeed` MUST update the held pick in place (price/team/seq) rather than duplicate it.
S-073. A manually deleted feed pick MUST get a tombstone in `_liveDraft.deleted` keyed by `espnPlayerId` (value = its seq, or a negative deletion-timestamp when it had no seq).
S-074. A tombstoned player MUST NOT be re-added by the cumulative feed UNLESS a genuine re-auction is detected.
S-075. Re-auction detection for a seq tombstone MUST be: feed carries a different `seq` for that playerId → clear tombstone, accept.
S-076. Re-auction detection for a negative (timestamp) tombstone MUST be: the feed record's `ts` is AFTER the deletion time → clear tombstone, accept.
S-077. A legacy tombstone stored as `true` MUST never resurrect (only seq-differ or later-timestamp clears it); this replaced the old "`true` blocks forever" bug.
S-078. Manual `deletePickAt(index)` MUST remove exactly one pick and (for feed picks) write its tombstone; other picks MUST be untouched.
S-079. `revertToPick(index)` MUST drop that pick and all later ones (slice to index) and clear the current lot state.
S-080. "Undo last pick" MUST pop exactly the most recent pick.
S-081. "Reset draft" MUST clear all picks and current-lot state and return to the keeper baseline (only after confirm).
S-082. Manual SOLD entry MUST push a pick with player/pos/team/price/ts; when the price exceeds the winner's computed max bid it MUST warn (confirm), not silently block.
S-083. Manual nomination of a name not in the value pool MUST NOT create a "ghost" pick silently; it MUST warn and require explicit confirmation (else inflation drifts).
S-084. A pick recorded with a placeholder name "Player <id>" (name map missing) MUST be auto-repaired to the real name once the ESPN name map loads (`_fixPlaceholderNames`).

### Commissioner-undo reconciliation

S-085. `_undoSuspects()` MUST list held picks whose `espnPlayerId` is absent from the latest INIT state AND that were recorded >3s before the INIT snapshot.
S-086. Undo suspects MUST only be judged when the INIT state's leagueId matches the feed's leagueId.
S-087. When suspects exist, the feed panel MUST show a warning listing them with a one-click "Remove them" button.
S-088. "Remove suspects" MUST tombstone and delete each suspect pick, and a genuine later re-auction MUST still be accepted (per §5 tombstone rules).

## 6. Money / pool invariants

Per-team state comes from `computeLiveTeamStates`; inflation from
`computeLiveInflation`. These are the numbers Jeff may act on.

S-089. A team's remaining budget MUST equal `base + adj − keptCost − spent`, where `base=$260`, `adj` is the (Real-mode) budget adjustment, `keptCost` is the sum of its major-keeper salaries, and `spent` is the sum of its recorded pick prices.
S-090. In Real mode, `adj` MUST be the manual Draft-Setup override when set, else the traded-draft-dollars sheet value (`getBudgetAdjustment` precedence: manual beats sheet).
S-091. In Test mode, `adj` MUST be 0 (no traded dollars).
S-092. A team's `slotsRemaining` MUST equal `LEAGUE.rosterSize − (majorKeepers + picksMade)`; minor keepers MUST NOT count.
S-093. A team's `maxBid` MUST equal `max(0, budget − max(0, slotsRemaining − 1))` (reserve $1 per other open slot).
S-094. `maxBid` MUST never be negative.
S-095. A team with `slotsRemaining` = 0 MUST have `maxBid` = 0 and MUST be flagged done in the team strip.
S-096. A pick recorded before a My-team change MUST still count for that team (`computeLiveTeamStates` matches on owner id OR raw `espnTeamId`).
S-097. Live inflation multiplier MUST equal `(leagueRemaining − spent) / remainingValue`, normalized so a no-keeper/no-picks baseline is 1.00 (`computeLiveInflation` divides by the flat baseline multiplier).
S-098. `remainingValue` MUST sum only positive-value players who are neither kept nor drafted.
S-099. `leagueRemaining` used for inflation MUST never go below 0 (`Math.max(0, ...)`).
S-100. The available pool (`availableDraftPool`) MUST be exactly `getValues()` minus drafted names minus excluded (kept) names, by normalized name, sorted by value descending.
S-101. No player MUST appear in more than one of {drafted, excluded, available} at once.
S-102. Total recorded picks MUST never exceed `teams × rosterSize` under correct operation (an invariant the Phase-1 checker asserts).
S-103. `inflatedValue(player, inflation)` for flat/live inflation MUST multiply by the hitter or pitcher multiplier per the player's type.
S-104. The `otc-maxbid-hint` and SOLD budget check MUST use the same `computeLiveTeamStates()[team].maxBid` value (one source of truth for max bid).

## 7. Supabase mirror

`draft-log.js` mirrors the event stream to `draft_sessions` / `draft_events`.

S-105. Session identity MUST be `client_key = "<leagueId>:<startedAt>"`, upserted `onConflict: client_key`, so a reload or second device cannot create a duplicate session.
S-106. `draft_events` rows MUST upsert on PK `(session_id, seq)` with `ignoreDuplicates`, so re-posting after a reload is idempotent.
S-107. Only events with `seq > uploadedSeq` MUST be queued (the per-session watermark prevents re-uploading the whole log).
S-108. The uploaded watermark MUST be persisted per session in `ud_draft_sessions_v1` and restored on session (re)start.
S-109. A session MUST be marked `is_mock = true` whenever the feed mode is not `real` (`getFeedMode() !== "real"`), and `false` only for the real league draft.
S-110. When the mode flips mid-session (test → real) and a session row already exists, the existing row's `is_mock` MUST be updated (the real draft must not stay labeled mock).
S-111. Mirror writes MUST NOT block or break the draft UI: events queue in memory and flush in batches (~2.5s); the UI never awaits a write.
S-112. On upload failure, the queue MUST be retained and retried with backoff (~15s), and the diagnostics panel MUST show the last error.
S-113. When Supabase is unreachable or the user is unauthenticated, events MUST keep queuing (not be dropped) and flush later; the session may show "events pending (session not started)".
S-114. After an app reload, the mirror MUST resume from the watermark (only missing events sent), driven by the ~3s post-load re-send in `draft.js`.
S-115. Off-mode streams MUST NOT be mirrored (nothing logged when `_dlogAccepts` is false).
S-116. The local event backup (`ud_draft_events_v1`) MUST NOT be device-synced (it is large and already mirrored to Supabase; excluded from `SYNC_EXACT_KEYS`).

## 8. UI contracts — three views

`renderDraft()` routes: Draft Mode if `_draftModeOn()` and values exist; else the
Setup lobby (`renderDraftSetup`) unless `_liveDraft.manualView`; else the manual
fallback.

S-117. When Draft Mode is on and projections exist, `renderDraft()` MUST render the fullscreen cockpit and MUST NOT fall through to the lobby/manual view.
S-118. When Draft Mode is off and `manualView` is false, `renderDraft()` MUST render the Setup lobby by default.
S-119. When `manualView` is true (and Draft Mode off), `renderDraft()` MUST render the classic manual pick-by-pick view.
S-120. When no projections are loaded, the Live Draft view MUST show an empty state directing the user to import a CSV, not a broken board.
S-121. Entering Draft Mode MUST add `body.draft-mode` (hides app tabs/topbar); exiting MUST remove it.
S-122. Exiting Draft Mode MUST always land on the Setup lobby (`manualView` reset to false).

### Setup lobby (`draft-setup.js`)

S-123. The lobby MUST provide a league-URL/id input; applying a parsed real-league (1200) URL MUST arm Real mode and clear the override; any other league MUST become a Test override + Test mode.
S-124. Applying an unparseable URL MUST show an inline "No leagueId found" error and MUST NOT change mode.
S-125. In Test mode the lobby MUST show a "My team in this mock" selector (Team 1..16) bound to `ud_test_my_team`; in Real mode it MUST NOT show it.
S-126. The lobby MUST embed the live pick-feed panel (mode segments + status + diagnostics).
S-127. The lobby MUST provide a Draft-strategy textarea with Save and "Condense for AI"; Save MUST persist text; Condense MUST produce a brief or show a failure message, never hang.
S-128. The lobby Keepers-&-budgets card MUST link to the Keepers tab and MUST state that keepers/budgets are ignored in Test mode.
S-129. Editing a team's manual budget adjustment MUST save on change and patch only that row's Budget cell in place (no full re-render / focus steal).
S-130. Saved configurations MUST snapshot league/mode, strategy text+brief, budget overrides, and keepers; "Save current setup" with the same name MUST replace the prior one.
S-131. Loading a config MUST ask about restoring keepers BEFORE applying anything, so cancelling never leaves a half-applied mix (new league/strategy with old keepers).
S-132. Loading a config that restores keepers MUST reload the page (module-cached stores) after writing them; loading without keepers MUST apply league/mode/strategy/budgets in place and re-render.
S-133. "Enter Draft" MUST switch into Draft Mode; the "Open the manual-entry view" link MUST set `manualView` and render the classic view.

### Draft Mode cockpit (`draft-mode.js`)

S-134. The hero on-the-clock card MUST be driven by the live event stream (`currentLotFromEvents`) when mode ≠ off, falling back to a manual `_liveDraft.current` lot.
S-135. With no active lot, the hero MUST show "Waiting for a nomination…", and when mode is off MUST prompt to turn the feed on.
S-136. The hero MUST show, for the player on the clock: position, model $, inflation-adjusted $, NFBC avg [min–max] when present, projected stat line, and an injury chip when the player is flagged.
S-137. The bidding ticker MUST show the current high bid + bidder and the recent bid escalation from the lot's bids.
S-138. "Your Call" MUST show walk-away $, stretch $, my-max $, a verdict (room to bid / stretch territory / walk away) relative to the current high bid, and a one-line rationale.
S-139. Bid-by-bid updates MUST patch the hero/ticker/reco/interest IN PLACE (`updateDraftModeLive`) without a full re-render, so search/scroll/typing are not disturbed.
S-140. A change of the player on the clock (new nomination or SOLD) MUST trigger a full re-render (fresh panels), detected via the `data-player` key on `#dm-otc`.
S-141. The board MUST offer BPA / Hitters / Pitchers / position modes; BPA MUST show best hitters and best pitchers side by side.
S-142. The board search box MUST preserve caret position across the re-render it triggers.
S-143. "My needs" toggle MUST filter the board to positions where my team has zero filled.
S-144. The status strip MUST show extension / ESPN-tab / feed-age / mode chips, the inflation badge, and my budget/slots/max-bid.
S-145. The projected-standings side panel MUST render nothing (an honest empty state) rather than junk when stat projections are missing.
S-146. The bottom zone (collapsed) MUST contain the feed panel, team strip, endgame panel (when active), and recent picks with revert/delete controls.

### Manual fallback (classic view, `draft.js`)

S-147. The manual view MUST provide On-The-Clock nominate/bid/SOLD controls, a player pool with search+position filter, recent picks, and the live-sources (proxy/polling) panel.
S-148. The nominate input MUST validate against the pool (`_nomResolveName`): exact/core match → start; already-drafted → who-drafted alert; kept → keeper alert; no match → suggestions + explicit "nominate anyway".
S-149. Bid +$1/+$2/+$5 buttons MUST add to the live high bid and update the max-bid hint.
S-150. Recent Picks MUST show revert (↶) and delete (✕) per pick with the semantics of §5 (revert = drop this + later; delete = only this, tombstoned).
S-151. The pool search input MUST preserve caret position across its triggered re-render.

### Cross-view UI invariants

S-152. Feed-panel buttons (mode segments, download log, re-sync, clear, remove-suspects) MUST be wired ONCE via document-level delegation so they work in all three views and survive innerHTML rebuilds.
S-153. Background feed/realtime events MUST NOT eat half-typed text in any input/textarea; the `rerender()` focus guard MUST protect an in-progress edit app-wide.
S-154. Esc MUST close the debrief overlay first if open; otherwise exit Draft Mode; and MUST never fire while focus is in an input/textarea/select.
S-155. A player-name click in any view MUST open the note editor for that player.
S-156. After every render of any of the three views, there MUST be no duplicate DOM ids (Phase-1 checker invariant).
S-157. `cloud-sync` device-reload-on-change MUST be suppressed while an auction is live (a manual `_liveDraft.current` lot OR a feed-driven lot), so a second device cannot hard-reload mid-bidding.

## 9. Failure behavior (per failing link)

Every failure must be visible and recoverable in ≤1 click or automatically.

S-158. **Extension not loaded / crashed:** `_feed.extPresent` MUST expire after 60s of bridge silence; the panel MUST show "Keeper Edge not detected" and instruct reloading it at chrome://extensions.
S-159. **ESPN tab closed:** `draftTabOpen()` MUST go false within ~25s of the last heartbeat and the panel MUST flip to "No ESPN draft tab open".
S-160. **ESPN tab reloaded mid-draft:** the socket reconnect's INIT MUST backfill any missed picks automatically (no manual re-entry).
S-161. **Feed stalled (tab open, socket quiet >30s):** with prior frames seen, a red watchdog warning MUST appear advising a reload of the ESPN tab then the app tab; it MUST also note that a mere pause looks identical.
S-162. **Lot quiet 5–60 min:** the hero MUST show an "⏸ Lot quiet Xm — paused" idle state, NOT blank and NOT a false sync error.
S-163. **Lot quiet >60 min:** `currentLotFromEvents` MUST treat the lot as ended (return null / no hero lot).
S-164. **App tab reloaded mid-draft:** `_liveDraft.picks`, `_dlog` events, and the Supabase watermark MUST restore from localStorage/cache and the mirror MUST resume from where it left off.
S-165. **Stale capture on reload:** an old capture with no live tab MUST present as "Last capture… (not live)" with Clear, never "Live" (per §4), so it can't silently refill cleared picks.
S-166. **Wrong-league tab in Real mode:** when the open draft tab's league ≠ 1200 and mode is Real, the panel MUST warn that Real accepts only league 1200 and suggest switching to Test — and MUST NOT ingest that league's picks.
S-167. **Proxy down / not configured:** ESPN name resolution and polling MUST fail soft — picks keep flowing from the socket feed; unresolved names show "Player <id>" and self-repair when the name map later loads; a failed name fetch MUST NOT poison the session.
S-168. **Proxy auth:** ESPN/Claude proxy requests MUST send the `x-ud-key` header; a missing/invalid key surfaces as a fetch failure, not a crash.
S-169. **Supabase down / offline:** per §7, events keep queuing and retry; the draft UI keeps working; diagnostics show pending count + last error.
S-170. **Rotowire/Claude unavailable:** a failed player-news/return estimate MUST show "unavailable" (not an eternal "estimating…") and a page reload MUST retry.
S-171. **AI recommendation failure:** the deterministic walk-away/stretch reco MUST still render even if the Claude judgment layer fails (the reco does not depend on a network call).
S-172. The "Download event log" button MUST export the full black-box payload (events, initState, picks, tombstones, mirror status) for post-mortem diagnosis, in every view.
S-173. Every failure state above MUST offer recovery that is automatic (INIT backfill, watermark resume, name self-repair, extPresent expiry) or ≤1 click (Clear captured feed, Re-sync, Remove suspects, switch mode, open manual view).

---

## Open questions for Jeff

These are genuinely ambiguous or where code and plan diverge — please decide:

1. **Two stale-capture thresholds.** The pick-feed staleness gate uses **15 min +
   no tab** (S-051); the same-league re-draft rotation uses **>60 min** stored-feed
   age (S-060). They serve different purposes but a mock re-run at, say, 30 min
   would show "not live" yet not rotate. Is 60 min the right rotation window, or
   should re-running a mock rotate sooner?

2. **Idle vs. ended lot window (5 min / 60 min).** A lot goes "paused" after 5 min
   quiet and "ended" after 60 min (S-162/S-163). Real ESPN commissioner pauses can
   exceed an hour — is 60 min the right hard cutoff, or should a still-open ESPN
   tab keep a lot "paused" indefinitely?

3. **Manual entry in Real mode + live feed.** If the live feed is running in Real
   mode and Jeff also manually records a SOLD, both paths write to
   `_liveDraft.picks`. The feed dedups by espnPlayerId, but a manual pick has no
   espnPlayerId — is a manual pick that later arrives on the feed expected to
   merge, or is manual entry strictly a fallback for when the feed is dead?

4. **Watchdog threshold (30s) vs. normal auction cadence.** The "feed quiet"
   alarm fires at 30s (S-161). ESPN auction lots with a long nomination clock can
   sit >30s legitimately. Is 30s too jumpy for draft day, or acceptable given the
   "could just be a pause" caveat in the message?

5. **My-team selector range (1..16) vs. 12-team assumption.** The Test-mode
   my-seat selector offers Team 1..16 (S-125) but the league is 12 teams. Mocks
   can have other sizes — keep 16, or clamp to the mock's actual team count?

6. **AI/Claude on-the-clock calls.** The 2027 plan wants per-lot AI rationale and
   injury-return estimates, but per-player Claude calls are "too slow" for the
   board. The spec assumes AI is best-effort and never blocks. Confirm: is any AI
   output allowed to be load-bearing for a bid decision, or is it always advisory?

7. **`processEspnPicks` price default.** A SOLD with a missing/zero `bidAmount`
   records `price: 0`. Is $0 the correct default, or should such picks be flagged
   for manual price entry (a $0 pick distorts spent/inflation)?

8. **Injury flag source in Test mode.** Injury chips come from the ESPN
   `kona_player_info` map fetched for the *current* league context. In a Test mock
   on a throwaway league, should injury flags still show (they'd come from the
   override league's player pool), or be suppressed?
