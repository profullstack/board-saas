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

## Surfaces

All four are thin clients over the same HTTP API.

```sh
# CLI
npm i -g @profullstack/board-saas        # or: curl -fsSL https://board.saas.pit.world/install.sh | sh
board-saas login you@example.com
board-saas meet "Decision: ... Options: ... Constraints: ..." --out report.html
board-saas get <id> | list | clarify <id> "<answers>" | report <id>

# TUI
board-saas tui

# MCP (tools: run_meeting, get_meeting)
claude mcp add --transport http board-saas https://board.saas.pit.world/mcp --header "Authorization: Bearer $BOARD_SAAS_KEY"
claude mcp add board-saas -- npx -y @profullstack/board-saas mcp      # stdio

# HTTP API: https://board.saas.pit.world/api/v1
curl -X POST https://board.saas.pit.world/api/v1/auth/code -H 'content-type: application/json' -d '{"email":"you@example.com"}'
curl -X POST https://board.saas.pit.world/api/v1/auth/verify -H 'content-type: application/json' -d '{"email":"you@example.com","code":"123456"}'
curl -X POST https://board.saas.pit.world/api/v1/meetings -H "Authorization: Bearer $BOARD_SAAS_KEY" -H 'content-type: application/json' -d '{"brief":"..."}'
curl https://board.saas.pit.world/api/v1/meetings/<id>
```

## Running it

Node 22.6+ (uses `node:sqlite`). Configuration comes from the logicsrc vault
`profullstack/board-saas--prod` (synced into an env file by `deploy/deploy.sh`):
`C0MPUTE_API_KEY`, `C0MPUTE_MODELS`, `RESEND_API_KEY`, `BOARD_SAAS_ADMIN_KEY`,
`COINPAY_API_URL`, `COINPAY_BUSINESS_ID`, `COINPAY_API_KEY`, `COINPAY_WEBHOOK_SECRET`.
Optional: `C0MPUTE_SITE_URL` (the c0mpute-hosted copy of the front page), `PORT`,
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
