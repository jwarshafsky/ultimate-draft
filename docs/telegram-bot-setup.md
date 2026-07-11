# Telegram bot — setup

Text a Telegram bot any question about The League and it answers using live
ESPN data, your imported ROS projections, and the same standings engine as
the app's Standings tab. Trade questions run a real Monte-Carlo simulation:

> **You:** what happens to my title odds if I trade Witt to Matt for Skenes?
>
> **Bot:** This trade drops you about 1.5 projected roto points but your title
> odds barely move (24% → 23%) …
> • You: −8 R, −5 SB, +11 K, +2 QS …
> • Keeper side: Skenes at $18 through 2028 is a much better contract than …
> • Verdict: …

Everything runs inside the existing `ultimate-draft-proxy` Cloudflare Worker —
no new hosting. One-time setup below (about 10 minutes, all copy-paste).

## 1. Create the bot in Telegram

1. In Telegram, open a chat with **@BotFather** (the verified one).
2. Send `/newbot`. Give it a display name (e.g. `The League Bot`) and a
   username ending in `bot` (e.g. `TheLeague1200Bot`).
3. BotFather replies with a **token** like `7712345678:AAF...xyz`. Copy it —
   that's `TELEGRAM_BOT_TOKEN` below.

## 2. Add the Worker secrets

In Terminal, from the `ultimate-draft/proxy` folder:

```sh
npx wrangler secret put TELEGRAM_BOT_TOKEN
# paste the BotFather token

npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
# paste any random string, e.g. the output of:  openssl rand -hex 16
# (save it — you need the same value in step 4)

npx wrangler secret put TELEGRAM_ALLOWED_CHAT_IDS
# you don't know your chat id yet — just enter 0 for now; fixed in step 5
```

(ESPN cookies and the Anthropic key are already configured for the other
routes; the bot reuses them.)

## 3. Deploy the Worker

```sh
cd proxy && npx wrangler deploy
```

## 4. Point Telegram at the Worker

One curl, with your bot token and the webhook secret from step 2 filled in:

```sh
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -d "url=https://ultimate-draft-proxy.jwarshafsky.workers.dev/telegram" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>" \
  -d "drop_pending_updates=true"
```

It should reply `{"ok":true,...,"description":"Webhook was set"}`.

## 5. Allowlist yourself

1. In Telegram, open a chat with your new bot and send it anything.
2. It replies: *"This bot is private. Your chat id is 123456789 …"*
3. Store that id:

```sh
npx wrangler secret put TELEGRAM_ALLOWED_CHAT_IDS
# paste the chat id (comma-separate multiple ids to let leaguemates in)
```

4. Send the bot `/start` — you should get the welcome message. Done.

## Things to know

- **Trade math** uses banked YTD stats + your imported FanGraphs ROS source
  (Steamer/BAT X/ATC — whichever the app has, synced automatically via device
  sync). If none is imported it falls back to ESPN's preseason projections
  prorated for the rest of the season, and says so.
- **Keeper context** comes from The League app's `data.js` (salaries / years)
  plus the rules digest, so trade verdicts weigh both this season and
  contracts.
- **History**: the bot remembers the last few exchanges per chat (7 days).
  `/reset` clears it.
- **Cost**: each question is a few Claude calls (Opus). Casual use is cheap;
  it shares the same `ANTHROPIC_API_KEY` as the draft assistant.
- **Worker CPU limits**: the simulation runs ~2,500 Monte-Carlo seasons per
  trade question. If Cloudflare ever kills a request with a CPU-limit error
  (free plan is tight), the $5/mo Workers Paid plan removes it.

## Troubleshooting

- Bot never replies → check `npx wrangler tail` while sending a message.
- `403 forbidden` in the tail → the webhook secret in step 4 doesn't match
  the `TELEGRAM_WEBHOOK_SECRET` secret.
- "This bot is private" after step 5 → the chat id list didn't save; re-run
  the secret put and redeploy isn't needed (secrets apply immediately).
- Wrong/old rosters → the bot caches league data for 4 minutes; ask again.
