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

First meeting free per email address (open models on c0mpute). After that, pay as you go: connect your c0mpute account (your CoinPay account) and each meeting runs on Claude Opus 5.5, charged to your c0mpute balance at Anthropic cost + 20%. A Profullstack Pass covers meetings while it is active.

Voice meetings (with recording): a free trial per account (up to 90 days), starting with your first
voice meeting; after that a voice pass is $19 per 30 days through CoinPay (`BOARD_VOICE_PRICE_USD`). A
voice meeting also uses one meeting credit, like a text meeting. When the trial is over the API
answers `402 {"code":"voice_trial_ended","checkout_url":...}` and text meetings keep working.

### Premium: the branded LinkedIn video

Every recorded voice meeting gets the captioned meeting video for free. Premium adds a branded
1080x1080 rendition made to post on LinkedIn (title banner, waveform, subtitles coloured per
speaker, every pause cut to 0.35 s) and its trimmed MP3. Premium is `$29` per 30 days through
CoinPay (`BOARD_PREMIUM_PRICE_USD`, `BOARD_PREMIUM_DAYS`), mirroring the voice pass:
`POST /api/v1/premium/checkout` returns the checkout link and the CoinPay webhook (metadata
`premium_account`) adds the days. **An active Profullstack Pass includes Premium.** Admins grant it
on `/admin` (days, or with no expiry).

It is made by itself after each recorded voice meeting of a premium account (and on boot for their
older recorded meetings), or on demand: `POST /api/v1/meetings/:id/branded-video` (202 while it
renders, 1 to 2 minutes for a 15-minute meeting; `402 {"code":"premium_required","checkout_url":...}`
without Premium), MCP `make_branded_video`, CLI `board-saas linkedin <id>`. Served like the
recording, decrypted on the fly with Range: the owner at `/api/v1/meetings/:id/branded.mp4` and
`/trimmed.mp3` (or a 6-hour link from `POST /api/v1/meetings/:id/branded-video/link`), listen shares
at `/s/<token>/branded.mp4`, a public meeting published with its recording at
`/m/<public id>/branded.mp4`. `get_meeting` carries `branded_video.video_url`.

How (`renderBrandedVideo` in `src/video.js`, ffmpeg under `nice -n 19`, one render at a time):
silencedetect (-40 dB, 0.6 s) on the saved recording; each pause shortened to 0.35 s by explicit
atrim segments joined with concat (10 ms fades); the transcript moved through the same cuts; ASS
banner + subtitles over the waveform; H.264 high crf 23, AAC 128k, faststart. Both files are
encrypted like recordings (their own keys, wrapped under `BOARD_RECORDING_KEK`) and deleted with the
recording. `BOARD_VIDEO=0` turns automatic renders off; `FFPROBE`, `BOARD_VIDEO_NICE` (`off` for none).

### /admin

`/admin` looks up an account by id, email (email accounts only) or CoinPay sub, shows credits,
premium, voice trial and Pass state, and tops up credits, grants, extends or revokes premium. Who
may use it: the admin key (`BOARD_SAAS_ADMIN_KEY`), or an account flagged admin using its own API
key (what the browser keeps after an email code or Sign in with CoinPay). An OAuth token from a
connected app never gets admin. Only the admin key can make or remove admins, by account id;
nothing is ever granted from an email, least of all CoinPay's unverified one. Every change is
written to the `admin_audit` table (who, what, before/after, when, IP); admin POSTs refuse a
cross-site Origin and admin answers carry no CORS headers. API: `GET /api/v1/admin/me`,
`GET /api/v1/admin/accounts?q=`, `POST /api/v1/admin/accounts/:id`
(`{action: credits|premium|revoke_premium|admin, delta|days|forever|value, note}`),
`GET /api/v1/admin/audit?account=`.

The trial length is an A/B test: each account is assigned 90 days (the control) or 30 days at its
first voice meeting, and keeps that length (`GET /api/v1/account` shows `voice.trial_days` and
`voice.trial_days_left`). Trials that started before the test keep 90 days. Assignment, exposures
(trial started), `voice_meeting` engagement events, conversions (paid voice pass) and revenue go to
CrawlProof through [`@profullstack/abtest`](https://www.npmjs.com/package/@profullstack/abtest);
results are at `https://crawlproof.com/dashboard/experiments/board-saas.voice-trial-length`. Env:
`CRAWLPROOF_TOKEN` (a crp_ token), optional `CRAWLPROOF_URL`, and `BOARD_VOICE_TRIAL_EXPERIMENT`
(`off` gives everyone the 90-day control). If CrawlProof is unreachable the same arm is computed
locally, so a meeting never waits on it.

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
- Anyone on the meeting can ask the board: by speaking (transcribed by PairUX's self-hosted
  Whisper), typing in the call chat, the PairUX Q&A panel, `board-saas ask <id> "..."`,
  `POST /api/v1/meetings/:id/questions`, MCP `submit_question`, or the "Ask the board" box on a
  listen or join invite page (`POST /s/<token>/questions`). The chair says people's PairUX names
  (never an id); answers land in the report under "Questions to the board" with who asked.
- `qa_mode` (per meeting: `--qa realtime|queued`, `"qa_mode"` in the API and MCP `run_meeting`):
  - `realtime` (default): the agenda yields at the next sentence, the chair acknowledges, ONE
    member answers (the one the question touches most, or the chair), and the agenda resumes.
    The answer is written while the chair speaks, on a fast model (`BOARD_LIVE_MODELS`, default
    `claude-haiku-5-5,claude-sonnet-5-5`, then the main model; `off` for the main model only),
    20 s timeout (`BOARD_LIVE_TIMEOUT_MS`), and a 429 moves to the next model instead of backing
    off. Measured 2026-11-25: 1.1-2.3 s per answer; first board audio is the chair's
    acknowledgement, a few seconds after the question ends. The log says
    `voice: answered <name> in N s` for each one.
  - `queued`: the chair says "noted, we will take it in the Q&A" at once, then picks questions
    (a host's bump first, then votes, then relevance to who just spoke) after the verdicts, after
    the debate, in a Q&A before the minutes and while the board is still thinking; each is read
    out with who asked, answered by a short round of the relevant members, and summed up by the
    chair in one line.
  - Either way, while a round is not ready the chair keeps the floor open for questions instead
    of dead air. Every model call of a meeting goes through one limiter
    (`BOARD_LLM_CONCURRENCY`, default 3, one slot always kept for live answers), so a meeting
    cannot 429 itself.
- Recording (on by default for voice, `--no-record` / `"record": false` to skip): everyone in the
  call is told it is recorded (the chair says so and posts it in the chat; the chair's name
  carries "recording"). The mix is encoded to MP3 and encrypted on the server with a fresh
  AES-256-GCM key per recording (chunked, so players can seek); the key is stored only wrapped
  under `BOARD_RECORDING_KEK` from the vault. Deleting a recording destroys its key.

## Private by default, shared by invite, public if you publish

Every meeting made since 0.3.0 is private to its owner: the status, the report, the recording and
the transcript need the owner's key (the web page signs in from the browser). Meetings made before
0.3.0 keep their old link. There are two ways to let someone else in.

**Invite links (shares).** A share is a token this server checks on every request. It has a role,
an optional label (who it is for), an expiry (never, 24 hours, 7 or 30 days) and can be revoked at
any time; a revoked or expired link stops working at once, on the page, its state and its
recording.

| role | what the link opens |
| --- | --- |
| `view` | the report |
| `listen` | the report, the live audio while the meeting runs, the recording and transcript afterwards |
| `join` | everything in `listen`, plus the PairUX join link while the call is open |

A `view` link needs a finished meeting. `listen` and `join` invites to a voice meeting can be made
as soon as the meeting exists, so you can invite people before it starts and while it runs. The
join link is read from the live call on every request and is never shown once the meeting has
ended. Downloads are off unless you allow them. Older shares keep working: "with recording" reads
as `listen`, "report only" as `view`.

Where: the web "Share and invite" panel (on the meeting page while a voice meeting is pending or
running, and on the report), `board-saas share|invite|shares|unshare`,
`POST /meetings/:id/shares {role, label, allow_download, expires}`, MCP `share_meeting` /
`invite_to_meeting` / `list_shares` / `revoke_share`. Every answer carries the full share URL
(`/s/<token>`) and the role.

**Publishing.** `PATCH /meetings/:id {"visibility":"public"}` (web "Make this meeting public",
`board-saas publish <id>`, MCP `publish_meeting`) gives the meeting a public page at
`/m/<public id>`. The public id is random and is not the meeting id. A public meeting is listed
on `/meetings` (newest first) and in `/sitemap.xml`, and its page is indexable; private pages
stay `noindex`. While the meeting runs the public page plays the live audio (it never shows the
join link); afterwards it shows the report, and the recording only if you asked for it
(`"include_recording": true`). Company data is never shown. `{"visibility":"private"}` takes the
page down again; the same public link comes back if you publish again.

`GET /api/v1/shareables` (MCP `list_shareables`, `board-saas shareables`) lists everything you can
hand to someone, per meeting: title, status, visibility, the public URL, every active share (role,
label, URL, expiry), the live playback URL while it runs, and the recording's private c0mpute link.

### Live listening (c0mpute Live)

With `BOARD_C0MPUTE_KEY` set, a voice meeting's audio is pushed to c0mpute only while someone can
listen: the meeting is public, or it has at least one `listen` or `join` share that is neither
revoked nor expired. A private meeting nobody was invited to makes no c0mpute call at all. The
unlisted c0mpute Live stream opens at the start if that audience exists, or mid-meeting when the
first such invite is made or the meeting is published. If the last invite is revoked or expires
and the meeting is not public, the push stops and the stream is deleted (expiry is noticed
within `BOARD_LIVE_CHECK_SECONDS`, default 15). The server mixes, in real time, the same audio the recorder collects and pushes it with
ffmpeg over RTMP (AAC audio plus a small black picture, so every HLS player accepts it). `listen`
and `join` invite pages and the public page play it with an HLS player (native where the browser
has one, otherwise hls.js from jsDelivr). The stream is deleted when the meeting ends.

Be clear about what this is: the stream is unlisted, not encrypted. c0mpute does not check who
plays it, so anyone who has the playback URL can listen while the meeting runs. The share token
gates the page that reveals the URL; it cannot take back a URL someone already copied. The stream
key is kept in memory only and is never stored, logged or put on a page. Without
`BOARD_C0MPUTE_KEY` there is no live audio and everything else works the same.

### Recording archive (c0mpute private storage)

With `BOARD_C0MPUTE_STORAGE_TOKEN` set, the finished MP3 is also sealed with
[`@profullstack/c0mpute-sealed`](https://www.npmjs.com/package/@profullstack/c0mpute-sealed) and
uploaded to c0mpute private storage over the app-upload API. No c0mpute node or identity is needed
on the server, but the c0mpute account that owns the token must have a linked storage identity
(`c0mpute storage key link`, once). The object lands in that account's storage, and the upload
returns a private link (`https://gateway.c0mpute.com/p/<id>/#k=<key>`).

Anyone who has that link can open the file, and revoking a board share does not revoke a link
that was already copied. So the link is stored only encrypted under `BOARD_RECORDING_KEK`, and is
shown only to the owner and to shares made with downloads allowed, always with that warning.
Deleting the recording here destroys the local key and forgets the link; it does not delete the
c0mpute object (the answer names its `c0p1:` ref so the storage account can remove it). The
encrypted copy on the server stays the primary: a failed upload is logged and changes nothing
else, and files over 192 MiB are skipped because a browser link cannot open them.

## Surfaces

All four are thin clients over the same HTTP API.

```sh
# CLI
npm i -g @profullstack/board-saas        # or: curl -fsSL https://board.saas.pit.world/install.sh | sh
board-saas login                         # OAuth device code: open the link, type the code (works over ssh)
board-saas login you@example.com         # or an emailed code and an API key
board-saas meet "Decision: ... Options: ... Constraints: ..." --data financials.txt --out report.html
board-saas meet "..." --voice                # live on PairUX; prints the join link
board-saas meet "..." --voice --qa queued    # questions taken at set Q&A points instead of at once
board-saas ask <id> "Why not hire later?" [--as "Dana"]   # ask the board while it meets
board-saas get <id> | list | clarify <id> "<answers>" | report <id> | start <id>
board-saas share <id> [--role view|listen|join] [--for "Dana"] [--download] [--expires 7d] | shares | unshare <share_id>
board-saas invite <id> [--join] [--for "Dana"] [--expires 24h]   # listen (or join) a voice meeting, before or while it runs
board-saas publish <id> [--recording] | unpublish <id> | shareables [--json]
board-saas recording <id> | transcript <id> | delete-recording <id> | voice-pass
board-saas connections | disconnect <client_id> | logout

# TUI
board-saas tui

# MCP (tools: run_meeting, get_meeting, list_meetings, clarify_meeting, share_meeting, invite_to_meeting, publish_meeting, list_shareables, list_shares, revoke_share, start_meeting_now, connect_c0mpute, make_branded_video, get_account)
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

## Sign in with CoinPay and Profullstack Pass

The web pages (front page, `/account`, private meeting pages, and the OAuth consent and device
pages) offer **Sign in with CoinPay** next to the email code. board.saas is a confidential client
of coinpayportal.com: authorization code + PKCE S256 + `state` + `nonce`, scopes `openid profile
email`, through `@profullstack/coinpay-onboard/oauth`. State, nonce and verifier stay server-side
in single-use rows that live 10 minutes, and an httpOnly cookie ties each flow to the browser
that started it.

- An account is bound to the CoinPay `sub` only. The CoinPay email is unverified: it never finds,
  signs into or changes an account. A CoinPay identity nobody has linked gets a new account with
  no email (a placeholder that is never shown or mailed).
- To use CoinPay with an existing email account, sign in with the email code and press
  **Connect CoinPay** on `/account`. The last step is finished by that account's own key, so a
  link someone else started cannot attach your CoinPay to their account. If one CoinPay identity
  is connected to several accounts, the sign-in asks which one.
- **Profullstack Pass**: while CoinPay reports an active pass, board meetings (text and voice)
  and Premium (the branded LinkedIn video) are included until the pass's `expires_at`: they do not use the free meeting or paid credits.
  The pass is read again at every CoinPay sign-in or connect, and cleared when it is no longer active.

Routes: `GET /auth/coinpay/start?return_to=/path`, `GET /auth/coinpay/callback`,
`POST /auth/coinpay/choose`, and with a bearer `POST /api/v1/auth/coinpay/link`,
`POST /api/v1/auth/coinpay/confirm`, `DELETE /api/v1/auth/coinpay`. Configuration:
`COINPAY_OAUTH_CLIENT_ID`, `COINPAY_OAUTH_CLIENT_SECRET` (the client is registered on
coinpayportal.com with the redirect URI `https://board.saas.pit.world/auth/coinpay/callback`),
optional `COINPAY_OAUTH_BASE`.

## Running it

Node 22.6+ (uses `node:sqlite`). Configuration comes from the logicsrc vault
`profullstack/board-saas--prod` (synced into an env file by `deploy/deploy.sh`):
`C0MPUTE_API_KEY`, `C0MPUTE_MODELS`, `RESEND_API_KEY`, `BOARD_SAAS_ADMIN_KEY`,
`COINPAY_API_URL`, `COINPAY_BUSINESS_ID`, `COINPAY_API_KEY`, `COINPAY_WEBHOOK_SECRET`.
Voice: `PAIRUX_PARTNER_KEY` (a `pux_pk_` key registered in pairux.com's `PAIRUX_PARTNERS` with an
`ownerUserId`), `PAIRUX_URL`, `C0MPUTE_SPEECH_URL` + `C0MPUTE_SPEECH_TOKEN` (the c0mpute speech
gateway), `BOARD_RECORDING_KEK` (32 bytes, base64), `BOARD_VOICE_PRICE_USD` (default 19),
`BOARD_VOICE_WAIT_SECONDS` (default 180), `BOARD_PREMIUM_PRICE_USD` (default 29),
`BOARD_PREMIUM_DAYS` (default 30). Needs `ffmpeg` and `ffprobe` with libmp3lame on PATH (and
libx264, aac and libass for live listening and Premium videos, plus the DejaVu Sans font).
Sharing: `BOARD_C0MPUTE_KEY` (a c0mpute API key allowed to publish live streams; turns on live
listening), `BOARD_C0MPUTE_STORAGE_TOKEN` (a c0mpute OAuth token or API key with `storage:write`,
on an account with a linked storage identity; turns on the private c0mpute copy of recordings),
`BOARD_C0MPUTE_URL` (default `https://c0mpute.com`). Both are off when unset.
`BOARD_RECORDING_C0MPUTE=1` is the older path (`c0mpute storage put` through a local c0mpute CLI
and identity) and only works on a host that runs a c0mpute node.
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
