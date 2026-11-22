// board-saas: the CLI. A thin client over the HTTP API.
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { BoardClient, loadConfig, saveConfig } from './client.js';
import { summarize } from './mcp.js';

const HELP = `board-saas: Board as a Service from the terminal (https://board.saas.pit.world)
Five AI advisors and a chair on any decision. The advisors are AI models, not real directors.

  board-saas login                           sign in with OAuth in your browser (device code; works over ssh)
  board-saas login <email> [--code 123456]   or: email a sign-in code and save an API key
  board-saas logout                          revoke this machine's OAuth sign-in
  board-saas whoami                          your account: free meeting, credits
  board-saas connections                     apps connected to your account over OAuth
  board-saas disconnect <client_id>          cut one off (its tokens stop working at once)
  board-saas meet "<brief>"                  run a meeting and print the minutes
      --file brief.txt                       read the brief from a file (or pipe it on stdin)
      --data financials.txt                  company data every advisor reads (P&L, cash, MRR...)
      --out report.html                      save the interactive report
      --no-wait                              start it and print the id
      --json                                 print the meeting JSON
  board-saas get <id> [--json]               a meeting's status or minutes
  board-saas list                            your meetings
  board-saas clarify <id> "<answers>"        answer the chair's one round of questions
  board-saas report <id> [--out file.html]   download the report
  board-saas tui                             the terminal dashboard
  board-saas mcp                             MCP server over stdio (run_meeting, get_meeting)
  board-saas serve                           run the server (operators)

Env: BOARD_SAAS_KEY (API key or OAuth access token), BOARD_SAAS_URL (default https://board.saas.pit.world)`;

function parse(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--') && ['code', 'file', 'out', 'url', 'key', 'data'].includes(k)) flags[k] = argv[++i];
      else flags[k] = true;
    } else if (a === '-o') flags.out = argv[++i];
    else args.push(a);
  }
  return { args, flags };
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function ask(q) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(q)).trim();
  } finally {
    rl.close();
  }
}

const err = (m) => process.stderr.write(`${m}\n`);

export async function main(argv = process.argv.slice(2)) {
  const { args, flags } = parse(argv);
  const cmd = args.shift() ?? (flags.version || flags.v ? 'version' : flags.help || flags.h ? 'help' : undefined);
  const cfg = loadConfig();
  if (flags.url) cfg.url = String(flags.url).replace(/\/+$/, '');
  if (flags.key) cfg.key = String(flags.key);
  const persist = (t) => saveConfig({ url: cfg.url, email: cfg.email, ...t });
  const client = new BoardClient({ ...cfg, onTokens: process.env.BOARD_SAAS_KEY ? null : persist });

  switch (cmd) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return 0;

    case 'version':
    case '--version': {
      const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
      console.log(pkg.version);
      return 0;
    }

    case 'login': {
      if (!args[0] && !flags.code) {
        await client.deviceLogin(({ user_code, verification_uri, expires_in }) => {
          err(`Open ${verification_uri}\nand enter the code:  ${user_code}\n(expires in ${Math.round(expires_in / 60)} minutes; waiting...)`);
        });
        const a = await client.account();
        cfg.email = a.email;
        const p = persist({ key: client.key, refresh_token: client.refreshToken, expires_at: client.expiresAt });
        console.log(`signed in as ${a.email} over OAuth; tokens saved to ${p}`);
        console.log(a.free_meeting_available ? 'your free meeting is ready' : `${a.credits} paid meeting(s) left; next is $${a.price_usd}`);
        return 0;
      }
      const email = args[0] || cfg.email || (await ask('Email: '));
      let code = flags.code;
      if (!code) {
        const r = await client.sendCode(email);
        err(r.message);
        code = await ask('6-digit code: ');
      }
      const v = await client.verify(email, String(code));
      const p = saveConfig({ url: cfg.url, key: v.api_key, email });
      console.log(`signed in as ${v.account.email}; key saved to ${p}`);
      console.log(v.account.free_meeting_available ? 'your free meeting is ready' : `${v.account.credits} paid meeting(s) left; next is $${v.account.price_usd}`);
      return 0;
    }

    case 'logout': {
      await client.logout();
      saveConfig({ url: cfg.url, email: cfg.email });
      console.log("signed out; this machine's tokens are revoked and forgotten");
      return 0;
    }

    case 'connections': {
      const list = await client.connections();
      if (!list.length) console.log('no apps connected over OAuth');
      for (const c of list) console.log(`${c.client_id}  ${c.name}  connected ${c.connected_at.slice(0, 16)}  last used ${c.last_refreshed_at.slice(0, 16)}`);
      return 0;
    }

    case 'disconnect': {
      if (!args[0]) return err('usage: board-saas disconnect <client_id>   (see board-saas connections)'), 2;
      const r = await client.disconnect(args[0]);
      console.log(r.revoked ? `disconnected ${args[0]}` : `${args[0]} had no live connection`);
      return 0;
    }

    case 'whoami':
      console.log(JSON.stringify(await client.account(), null, 2));
      return 0;

    case 'meet': {
      let brief = args.join(' ').trim();
      if (flags.file) brief = readFileSync(String(flags.file), 'utf8');
      if (!brief) brief = (await readStdin()).trim();
      if (!brief) {
        err('give a brief: board-saas meet "Decision: ... Options: ... Constraints: ..."');
        return 2;
      }
      if (!client.key) {
        err('not signed in: run board-saas login first (or set BOARD_SAAS_KEY)');
        return 2;
      }
      const data = flags.data ? readFileSync(String(flags.data), 'utf8') : null;
      let v = await client.runMeeting(brief, data);
      if (v.status === 'awaiting_payment') {
        console.log(`Your free meeting is used. Pay $${v.price_usd} in crypto to start this one:\n${v.checkout_url}\nThen: board-saas get ${v.id}`);
        return 0;
      }
      err(`meeting ${v.id} started: ${v.url}`);
      if (flags['no-wait']) {
        console.log(v.id);
        return 0;
      }
      let last = '';
      v = await client.waitFor(v.id, {
        onUpdate: (u) => {
          const s = `${u.status}${u.progress?.stage && u.progress.stage !== u.status ? ` ${u.progress.stage}` : ''}${u.progress?.of ? ` ${u.progress.done}/${u.progress.of}` : ''}`;
          if (s !== last) err(`  ${s}`);
          last = s;
        },
      });
      if (v.status === 'needs_clarification') {
        console.log(summarize(v));
        if (process.stdin.isTTY) {
          const answers = await ask('Your answers (one line, Enter to skip): ');
          await client.clarify(v.id, answers);
          v = await client.waitFor(v.id, { onUpdate: (u) => err(`  ${u.status} ${u.progress?.stage ?? ''}`) });
        } else {
          console.log(`answer with: board-saas clarify ${v.id} "<answers>"`);
          return 0;
        }
      }
      if (flags.out && v.status === 'done') {
        writeFileSync(String(flags.out), await client.reportHtml(v.id));
        err(`report saved to ${flags.out}`);
      }
      console.log(flags.json ? JSON.stringify(v.meeting ?? v, null, 2) : summarize(v));
      return v.status === 'done' ? 0 : 1;
    }

    case 'get': {
      if (!args[0]) return err('usage: board-saas get <id>'), 2;
      const v = await client.getMeeting(args[0]);
      console.log(flags.json ? JSON.stringify(v, null, 2) : summarize(v));
      return 0;
    }

    case 'list': {
      const list = await client.listMeetings();
      if (!list.length) console.log('no meetings yet');
      for (const m of list) console.log(`${m.id}  ${m.status.padEnd(20)} ${m.created_at.slice(0, 16)}  ${m.brief.replace(/\s+/g, ' ').slice(0, 70)}`);
      return 0;
    }

    case 'clarify': {
      if (!args[0]) return err('usage: board-saas clarify <id> "<answers>"'), 2;
      console.log(summarize(await client.clarify(args[0], args.slice(1).join(' '))));
      return 0;
    }

    case 'report': {
      if (!args[0]) return err('usage: board-saas report <id> [--out file.html]'), 2;
      const html = await client.reportHtml(args[0]);
      const out = flags.out ? String(flags.out) : `board-${args[0]}.html`;
      writeFileSync(out, html);
      console.log(out);
      return 0;
    }

    case 'tui': {
      const { runTui } = await import('./tui.js');
      await runTui(client);
      return 0;
    }

    case 'mcp': {
      const { serveStdio } = await import('./mcp-stdio.js');
      await serveStdio(client);
      return 0;
    }

    case 'serve': {
      const { startServer } = await import('./server.js');
      startServer(process.env);
      return new Promise(() => {});
    }

    default:
      err(`unknown command: ${cmd}\n\n${HELP}`);
      return 2;
  }
}
