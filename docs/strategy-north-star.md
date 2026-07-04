# Auction/Keeper Strategy → Feature North-Star

Design reference for Ultimate Draft. Every draft feature should serve the strategy
of winning a **12-team, $260 auction, 5×5 roto keeper league** (OBP / QS / SV+HLD;
8 ML + 10 MiL keepers). When adding or changing a draft feature, check it against
these principles — the tool exists to operationalize them at the table.

Sources: the fantasy-kb (`Desktop/Claude/fantasy-kb/01-valuation/*`,
`07-draft-prep/*`) for deep theory; DraftKick's salary-cap auction guide for the
live-tactics framing. This file is the *bridge* to features, not a re-teaching of
the strategy — follow the KB links for the "why".

Legend: ✅ implemented · 🟡 partial · 🔲 gap/idea

---

## 1. Value discipline tempered by market realism
The engine's whole job is a trustworthy **clearing price** = value × inflation ×
positional scarcity, so the sim trains real price discipline instead of overpaying.
- ✅ FanGraphs $ (Jeff's exact settings) preferred over SGP; SGP fallback.
- ✅ Tiered keeper inflation, budget-conserving, normalized to 1.00 at zero keepers.
- ✅ Verdict chip (Buy/Fair/Overpay) + "your max bid" at the decision moment.
- 🟡 **Market vs. model gap** (NFBC AAV vs. our inflated $). NFBC prices imported;
  surface a per-player *market−model delta* as a target/fade cue on Values/Board.
- Market truths to encode (KB `adp_and_market_inefficiencies`, DraftKick):
  stars clear **$5–10 over** projection; **SB and saves carry a premium**; catchers
  deflate; first-player-in-a-tier often gets a small discount, last-in-tier pays $5–10 more.

## 2. Keeper selection = surplus, adjusted for inflation
- ✅ Keepers tab: Surplus (Pred$ − Cost) **and** Value (Pred$ − Cost÷Inflation), sorted by Value.
- ✅ Contract-year eligibility; MiL prospects estimate from ROS/next-year $.
- Rules to keep honoring (KB `keeper_surplus_value`): keep the biggest cost-vs-value
  gaps; break ties toward youth/upside; inflation can justify keeping stars "at cost";
  cheap negative-value lottery MiL stashes are fine.

## 3. Budget architecture (stars-and-scrubs vs. spread)
- ✅ Settings: hitter/pitcher split, stars-vs-scrubs slider, tier absorption, market heat, price level.
- ✅ Live team strip: budget, $/slot, **max bid = remaining − $1 per open slot** (exact DraftKick formula).
- Heuristic to preserve (KB `auction_bidding_strategy`): default stars-and-scrubs in
  shallow/$-rich spots, spread in deep pools; **you can pivot away from stars-and-scrubs
  mid-draft, never toward it** — so the tool should warn when early overspend has
  stranded the roster (endgame $/slot < ~$3).

## 4. Nomination strategy (information + budget warfare)
- ✅ Mock engine `nomMix` (target / dump / drain / blocker) + positional-run awareness.
- ✅ Nomination Targets panel (your keepers vs. opponents' open needs).
- 🔲 **Drain/enforce suggestions** during *live* draft: "nominate X (a position Y is
  desperate for) to drain their budget" — extend Nominations to opponent-need-aware picks.
- 🔲 **First-in-tier cue**: flag when nominating the first player of a tier (discount
  window) vs. waiting (supply squeeze). Tier-cliff dividers already exist on the board.

## 5. Live-bid tactics (mostly for the AI assistant + mock realism)
DraftKick's human-auction tactics — model in the AI assistant and/or mock AI:
- 🔲 **Round-number resistance** ($10/$20/$30 thresholds — more lots clear there than
  chance): the AI could advise "bid $21 to break their $20 wall," and the mock AI could
  hesitate at round numbers.
- 🔲 **Max-bid leverage**: *Shutdown* (jump to opponent's exact max) and *Squeeze*
  (push to their max, then drop) — AI plays these using `computeLiveTeamStates()` max bids.
- 🔲 **Price enforcement risk**: only bid up a player you don't want when you're *sure*
  they'll be outbid — the AI should quantify that risk before suggesting it.
- 🔲 **Bid timing**: lightning/sniper framing → the mock's stepwise bidding already
  models pacing; the AI could suggest tempo.

## 6. Category targeting & punts
- ✅ Category Pace panel (roto read: "Light on X / Strong: Y") in mock + live.
- ✅ End-of-draft scorecard projects roto finish.
- Punt frames to detect/support (KB `category_strategy`, DraftKick): punt saves (cheap
  setup men for HLD), punt power (SB/AVG anchors + cheap complements), punt SP-ratios
  (cheap RP for ERA/WHIP/HLD). 🔲 Let the pace panel *recommend* a coherent punt when a
  category is unreachable rather than just flagging it.

## 7. Owner tendencies & draft archaeology (the planned edge)
- 🔲 **Owner over-invests in hitting/pitching** → predictable nomination patterns; scout
  and exploit. This is the planned "owner tendencies via Jeff's draft history" feature.
- 🔲 **Draft archaeology**: which managers nominated players they ultimately signed =
  they telegraph targets → future price-enforcement leverage. Reconstruct from History /
  live nomination log; persist as per-owner notes for next year.

---

**Rule of thumb for new features:** if it doesn't help make a *better clearing-price
call*, *drain/deny an opponent*, *protect budget flexibility to the end*, or *exploit
an owner's known tendency*, it's probably not draft-critical. See the fantasy-kb for the
strategy depth behind any line here.
