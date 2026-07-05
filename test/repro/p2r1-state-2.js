// p2r1-state-2 — LOT MACHINE: an already-SOLD player is re-opened as a phantom
// "on the clock" lot by a late BID/BID_ACK frame.
//
// STATE TRACE (lot machine — currentLotFromEvents):
//   The lot machine walks the whole event log. SOLD closes ONLY its own lot
//   (lot=null). But the NEXT rule for (BID|BID_ACK) is unconditional:
//       if (!lot || lot.playerId !== e.playerId) lot = { playerId: e.playerId, ... }
//   So ANY BID/BID_ACK that references a player who is NOT the current lot opens
//   a brand-new lot for that player — including a player who was ALREADY SOLD
//   earlier in the same log. ESPN's protocol notes (draft-socket-capture.js) list
//   BID_ACK as a real frame that "mirrors BID field order"; a winning BID_ACK that
//   lands just after its SOLD (network reordering / echo) therefore RE-OPENS a lot
//   for the just-sold player.
//
//   Result: the Draft Mode hero shows a player who has already been sold as
//   "On the Clock", with a bogus high bid, and updateDraftModeLive() keys the
//   change off data-player so it will full-re-render onto the phantom. There is no
//   guard that a lot's player must not already be in _liveDraft.picks.
//
// VIOLATES: S-134 (the hero MUST reflect the live lot — a sold player is not a
//   live lot), S-140 (a "change of the player on the clock" is driven off this —
//   here it flips to a ghost), S-163 (a resolved/ended lot must yield no hero lot).
//
// This script exits NONZERO while the bug exists.

const H = require("./_apploader.js");
H.install();
const log = H.realConsole;

H.setRealMode();
H.resetDraftState();
global._espnIdToName = { 39832: "Corbin Carroll", 42404: "Kyle Tucker" };

const now = Date.now();

// A completed lot for Corbin Carroll (39832): nominated, bid, SOLD. The winning
// BID_ACK echoes in AFTER the SOLD (real network reordering of ESPN frames).
global._dlog.events = [
  { seq: 1, at: now, cmd: "NOMINATION", teamId: 6, playerId: 39832 },
  { seq: 2, at: now, cmd: "BID", teamId: 6, playerId: 39832, amount: 5 },
  { seq: 3, at: now, cmd: "BID", teamId: 2, playerId: 39832, amount: 9 },
  { seq: 4, at: now, cmd: "SOLD", teamId: 2, playerId: 39832, amount: 9 },
  // Corbin Carroll is now SOLD. The lot should be closed / awaiting the next
  // nomination. But this trailing winning-bid ACK re-opens his lot:
  { seq: 5, at: now, cmd: "BID_ACK", teamId: 2, playerId: 39832, amount: 9 },
];
// Corbin Carroll is in the recorded picks (he was sold).
global._liveDraft.picks.push({
  player: "Corbin Carroll", pos: "OF", team: "saxton", price: 9, ts: now,
  espnPlayerId: 39832, espnSeq: 4,
});

const lot = global.currentLotFromEvents();

let failed = false;
if (lot && lot.playerId === 39832) {
  const alreadySold = global._liveDraft.picks.some((p) => p.espnPlayerId === lot.playerId);
  if (alreadySold) {
    failed = true;
    log.error("BUG PRESENT: currentLotFromEvents() returned an already-SOLD player as the " +
      "live lot — playerId " + lot.playerId + " (" + lot.name + ") is in _liveDraft.picks as a " +
      "completed sale, yet the hero would show him On the Clock at $" + lot.highBid + ".");
  }
}

if (!failed) {
  log.log("OK — a late BID_ACK after SOLD does not re-open a phantom lot.");
  process.exit(0);
}
log.error("\nSpec violated: S-134 / S-140 / S-163 — a trailing BID/BID_ACK for an " +
  "already-sold player re-opens a phantom lot; the lot machine has no guard that the " +
  "opened player must not already be a completed pick, so the cockpit shows a ghost.");
process.exit(1);
