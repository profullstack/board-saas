# Board as a Service

**https://board.saas.pit.world** (Moshpit name `board.saas`)

Paste a decision brief. Five AI advisors give independent verdicts, debate each other by
name, and a chair writes the minutes: the vote, where they clashed, the strongest dissent,
a recommendation and the one question you still need to answer. You get an interactive
report at a shareable link, downloadable as one HTML file.

The advisors are AI models running on the [c0mpute](https://c0mpute.com) peer network.
They are not real directors, and nothing here is legal, tax or investment advice.

It productizes the open-source [boardroom](https://github.com/profullstack/boardroom)
Claude Code plugin: the expert personas are its skill texts (`src/experts/*.md`), the
meeting follows its `commands/meet.md`, and the report is its `render-report.mjs`.

## The board

| id | Member | Lens |
| --- | --- | --- |
| cfo | The CFO | cash, runway, unit economics, payback |
| growth | The Growth Marketer | audience, distribution, revenue growth |
| operator | The Operator | systems, delegation readiness, execution |
| founder-time | The Founder-Time Strategist | founder hours, highest-value work |
| contrarian | The Contrarian Investor | inversion, reversibility, opportunity cost |

The chair runs the meeting and never votes.

## How a meeting runs

0. **Brief check.** The chair extracts the decision, options and constraints. If one is
   missing it asks once (`needs_clarification`); anything still missing becomes a written
   assumption.
1. **Verdicts.** Five calls in parallel; each sees only the brief.
2. **Debate.** Five calls in parallel; each reads all five named verdicts.
3. **Minutes.** One chair call. The vote table is built from what each member said.

Every answer is JSON, validated per round, retried once with the error spelled out. If
c0mpute cannot answer, the meeting fails with the real error and is refunded. There is no
paid-model fallback in the code at all.

## Pricing

First meeting free per email address, then $9 per meeting through CoinPay (crypto).

Voice meetings (with recording): free 30-day trial per account, starting with your first voice
meeting; after that a voice pass is $19 per 30 days through CoinPay (`BOARD_VOICE_PRICE_USD`). A
voice meeting also uses one meeting credit, like a text meeting. When the trial is over the API
answers `402 {"code":"voice_trial_ended","checkout_url":...}` and text meetings keep working.

## Voice meetings on PairUX (optional)

Tick "Voice meeting" (web), pass `--voice` (CLI), `"voice": true` (API) or `voice: true` (MCP
`run_meeting`). Once the chair has checked the brief, the meeting carries `call.join_url`: a normal
PairUX join link that opens in the PairUX desktop app or any browser (the web app installs as a
PWA). Signed in or as a guest, you can talk. The board starts when you join, or when you press
"Start now" (`board-saas start <id>`, `POST /meetings/:id/start`, MCP `start_meeting_now`), or
after three minutes without you.

- Six PairUX agent participants: the chair and the five members, each speaking in its own Kokoro
  voice rendered on c0mpute (chair am_onyx, CFO af_sarah, Growth af_bella, Operator am_echo,
  Founder-Time af_nicole, Contrarian am_michael). Spoken text is kept short (a verdict about 35 s,
  a debate reply about 25 s); the report keeps every word.
- One speaker at a time: one process speaks for all six, so nobody guesses who holds the floor.
  The chair introduces the brief, calls each member, runs the debate and reads the
  recommendation.
- Interrupt by speaking (transcribed by PairUX's self-hosted Whisper) or by typing in the call
  chat. The chair takes it at the next turn boundary and routes it to the most relevant member
  (or the whole board); the answer is spoken and lands in the report as "Founder Q&A".
- Recording (on by default for voice, `--no-record` / `"record": false` to skip): everyone in the
  call is told it is recorded (the chair says so and posts it in the chat; the chair's name
  carries "recording"). The mix is encoded to MP3 and encrypted on the server with a fresh
  AES-256-GCM key per recording (chunked, so players can seek); the key is stored only wrapped
  under `BOARD_RECORDING_KEK` from the vault. Deleting a recording destroys its key.

## Private reports and share links

Every meeting made since 0.3.0 is private to its owner: the status, the report, the recording and
the transcript need the owner's key (the web page signs in from the browser). Meetings made before
0.3.0 keep their public link. To show someone a meeting, make a share link: report only, or with
the recording and transcript; downloads off unless you allow them; expiry never, 7 or 30 days;
revoke any time (web "Share" panel, `board-saas share|shares|unshare`, `POST /meetings/:id/shares`,
MCP `share_meeting` / `list_shares` / `revoke_share`).

## Surfaces

All four are thin clients over the same HTTP API.

```sh
# CLI
npm i -g @profullstack/board-saas        # or: curl -fsSL https://board.saas.pit.world/install.sh | sh
board-saas login                         # OAuth device code: open the link, type the code (works over ssh)
board-saas login you@example.com         # or an emailed code and an API key
board-saas meet "Decision: ... Options: ... Constraints: ..." --data financials.txt --out report.html
board-saas meet "..." --voice                # live on PairUX; prints the join link
board-saas get <id> | list | clarify <id> "<answers>" | report <id> | start <id>
board-saas share <id> [--recording] [--download] [--expires 7d] | shares | unshare <share_id>
board-saas recording <id> | transcript <id> | delete-recording <id> | voice-pass
board-saas connections | disconnect <client_id> | logout

# TUI
board-saas tui

# MCP (tools: run_meeting, get_meeting, list_meetings, clarify_meeting, share_meeting, list_shares, revoke_share, start_meeting_now, get_account)
claude mcp add --transport http board-saas https://board.saas.pit.world/mcp   # OAuth: signs in in your browser
# claude.ai / ChatGPT: add https://board.saas.pit.world/mcp as a custom connector
claude mcp add --transport http board-saas https://board.saas.pit.world/mcp --header "Authorization: Bearer $BOARD_SAAS_KEY"   # or a key
claude mcp add board-saas -- npx -y @profullstack/board-saas mcp      # stdio

# HTTP API: https://board.saas.pit.world/api/v1
curl -X POST https://board.saas.pit.world/api/v1/auth/code -H 'content-type: application/json' -d '{"email":"you@example.com"}'
curl -X POST https://board.saas.pit.world/api/v1/auth/verify -H 'content-type: application/json' -d '{"email":"you@example.com","code":"123456"}'
curl -X POST https://board.saas.pit.world/api/v1/meetings -H "Authorization: Bearer $BOARD_SAAS_KEY" -H 'content-type: application/json' -d '{"brief":"..."}'
curl https://board.saas.pit.world/api/v1/meetings/<id> -H "Authorization: Bearer $BOARD_SAAS_KEY"
```

## OAuth 2.1 and your company data

board.saas is its own OAuth 2.1 authorization server, so any OAuth client can act for an
account: the Claude and ChatGPT connectors, `claude mcp add` without a header, the CLI, or
your own app. The same access token works on `/mcp` and `/api/v1`.

| What | Where |
| --- | --- |
| Server metadata (RFC 8414) | `/.well-known/oauth-authorization-server` |
| Resource metadata (RFC 9728) | `/.well-known/oauth-protected-resource/mcp` (resource = the `/mcp` URL), `/.well-known/oauth-protected-resource/api/v1` |
| Dynamic client registration (RFC 7591) | `POST /oauth/register` (also `POST /register`); public clients, or `client_secret_post` / `client_secret_basic` |
| Authorization code + S256 PKCE | `GET /oauth/authorize` (consent page with inline email-code sign-in), `iss` on every redirect |
| Token | `POST /oauth/token`: `authorization_code`, `refresh_token` (rotated; a replayed one revokes the connection), `urn:ietf:params:oauth:grant-type:device_code` |
| Device flow (RFC 8628) | `POST /oauth/device_authorization`, the person types the code at `/oauth/device`; client id `board-saas-cli` |
| Revocation (RFC 7009) | `POST /oauth/revoke`; or `GET/DELETE /api/v1/connections[/:client_id]` |

One scope, `board`: run, read, list and clarify the account's meetings, spending its free
meeting or paid credits. Access tokens last an hour, refresh tokens 90 days.

**Company data.** `run_meeting` (MCP) and `POST /api/v1/meetings` take `company_data`
(text or JSON, up to 12,000 characters) that every advisor reads with the brief. In an
agent connected to both board.saas and your books (QuickBooks, CoinPay, Stripe), the
agent pulls the P&L, cash, runway, MRR and churn and hands them over, so the CFO argues
from your real numbers. The data never appears on the shareable report.

## Running it

Node 22.6+ (uses `node:sqlite`). Configuration comes from the logicsrc vault
`profullstack/board-saas--prod` (synced into an env file by `deploy/deploy.sh`):
`C0MPUTE_API_KEY`, `C0MPUTE_MODELS`, `RESEND_API_KEY`, `BOARD_SAAS_ADMIN_KEY`,
`COINPAY_API_URL`, `COINPAY_BUSINESS_ID`, `COINPAY_API_KEY`, `COINPAY_WEBHOOK_SECRET`.
Voice: `PAIRUX_PARTNER_KEY` (a `pux_pk_` key registered in pairux.com's `PAIRUX_PARTNERS` with an
`ownerUserId`), `PAIRUX_URL`, `C0MPUTE_SPEECH_URL` + `C0MPUTE_SPEECH_TOKEN` (the c0mpute speech
gateway), `BOARD_RECORDING_KEK` (32 bytes, base64), `BOARD_VOICE_PRICE_USD` (default 19),
`BOARD_VOICE_WAIT_SECONDS` (default 180), `BOARD_RECORDING_C0MPUTE=1` to also keep each encrypted
recording as a private c0mpute storage object (needs the server's c0mpute identity). Needs `ffmpeg`
with libmp3lame on PATH.
Optional: `C0MPUTE_CONCURRENCY` (parallel c0mpute calls, default 2), `C0MPUTE_SITE_URL` (the c0mpute-hosted copy of the front page), `PORT`,
`BOARD_DB`, `PUBLIC_URL`.

```sh
npm install
npm test
node scripts/build-static.mjs   # ./site, footers baked in; published to c0mpute hosting
node src/server.js
```

Hosting: the front page is published on the c0mpute network (three self-healing copies)
and served at board.saas.pit.world by the app, which proxies it with its own build as the
fallback. The API, MCP endpoint and meeting runner are a systemd unit on dev2 behind the
Moshpit origin (`deploy/`).

## License

MIT
