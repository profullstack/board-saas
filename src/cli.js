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
      --voice                                hold it live on PairUX and join the call (desktop app or browser)
      --no-record                            voice: do not record the call (recorded by default, private)
      --no-wait                              start it and print the id
      --json                                 print the meeting JSON
  board-saas get <id> [--json]               a meeting's status or minutes
  board-saas list                            your meetings
  board-saas clarify <id> "<answers>"        answer the chair's one round of questions
  board-saas report <id> [--out file.html]   download the report
  board-saas start <id>                      voice meeting: start now without waiting for you to join
  board-saas share <id> [--role view|listen|join] [--for <who>] [--download] [--expires never|24h|7d|30d]   make a share link
  board-saas invite <id> [--join] [--for <who>] [--expires 24h]   invite someone to listen (or join) a voice meeting, before or while it runs
  board-saas publish <id> [--recording]      make a meeting public (its own page, listed on /meetings)
  board-saas unpublish <id>                  make it private again
  board-saas shareables [--json]             every public URL, share link, live URL and private c0mpute link you have
  board-saas shares [<id>]                   your share links
  board-saas unshare <share_id>              revoke a share link
  board-saas recording <id> [--out f.mp3]    download your call recording (private to you)
  board-saas transcript <id>                 print the call transcript
  board-saas delete-recording <id>           delete the recording and transcript for good
  board-saas voice-pass                      CoinPay link for 30 days of voice meetings (after the trial)

Voice meetings: free trial (up to 90 days), then paid. Meetings are private to you until you share or publish them.
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
      else if (argv[i + 1] && !argv[i + 1].startsWith('--') && ['code', 'file', 'out', 'url', 'key', 'data', 'expires', 'role', 'for'].includes(k)) flags[k] = argv[++i];
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
        console.log(`signed in as ${a.email ?? a.name ?? "your account"} over OAuth; tokens saved to ${p}`);
        console.log(a.free_meeting_available ? 'your free meeting is ready' : `${a.credits} paid meeting(s) left; next is $${a.price_usd}`);
        if (a.voice?.summary) console.log(a.voice.summary);
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
      let v = await client.runMeeting(brief, data, { voice: !!flags.voice, record: !flags['no-record'] });
      if (v.code === 'voice_trial_ended') {
        console.log(`${v.error}\n${v.checkout_url}`);
        return 1;
      }
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
      let shownJoin = false;
      v = await client.waitFor(v.id, {
        onUpdate: (u) => {
          if (u.call?.join_url && !shownJoin) {
            shownJoin = true;
            err(`\n  Join your board on PairUX: ${u.call.join_url}  (code ${u.call.join_code})${u.call.recorded ? '\n  This call is recorded (private to you).' : ''}\n  It starts when you join, or run: board-saas start ${u.id}\n`);
          }
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

    case 'start': {
      if (!args[0]) return err('usage: board-saas start <id>'), 2;
      console.log(summarize(await client.startNow(args[0])));
      return 0;
    }

    case 'share': {
      if (!args[0]) return err('usage: board-saas share <id> [--role view|listen|join] [--for <who>] [--download] [--expires never|24h|7d|30d]'), 2;
      const s = await client.share(args[0], { role: typeof flags.role === 'string' ? flags.role : undefined, label: typeof flags.for === 'string' ? flags.for : undefined, include_recording: !!flags.recording, allow_download: !!flags.download, expires: flags.expires || 'never' });
      if (s.error) return err(s.error), 1;
      console.log(`${s.url}\nshare id ${s.id} (${s.role}${s.label ? `, for ${s.label}` : ''}, ${s.expires_at ? `expires ${s.expires_at.slice(0, 10)}` : 'no expiry'}); revoke with: board-saas unshare ${s.id}`);
      return 0;
    }

    case 'invite': {
      if (!args[0]) return err('usage: board-saas invite <id> [--join] [--for <who>] [--download] [--expires never|24h|7d|30d]'), 2;
      const s = await client.share(args[0], { role: flags.join ? 'join' : 'listen', label: typeof flags.for === 'string' ? flags.for : undefined, allow_download: !!flags.download, expires: flags.expires || 'never' });
      console.log(`${s.url}\ninvite ${s.id} (${s.role}${s.label ? `, for ${s.label}` : ''}, ${s.expires_at ? `expires ${s.expires_at.slice(0, 10)}` : 'no expiry'}); revoke with: board-saas unshare ${s.id}`);
      return 0;
    }

    case 'publish':
    case 'unpublish': {
      if (!args[0]) return err(`usage: board-saas ${cmd} <id>${cmd === 'publish' ? ' [--recording]' : ''}`), 2;
      const v = await client.publish(args[0], cmd === 'publish' ? { visibility: 'public', include_recording: !!flags.recording } : { visibility: 'private' });
      console.log(v.visibility === 'public' ? `public: ${v.public_url}${v.public_recording ? ' (with the recording)' : ''}\nlisted on the public meetings page; undo with: board-saas unpublish ${v.id}` : `private: the public page of ${v.id} no longer opens`);
      return 0;
    }

    case 'shareables': {
      const list = await client.shareables();
      if (flags.json) return console.log(JSON.stringify(list, null, 1)), 0;
      if (!list.length) console.log('no meetings yet');
      for (const m of list) {
        console.log(`${m.meeting_id}  ${m.status.padEnd(8)} ${m.visibility.padEnd(7)} ${m.title}`);
        if (m.public_url) console.log(`  public   ${m.public_url}`);
        if (m.live_playback_url) console.log(`  live     ${m.live_playback_url}  (unlisted, not encrypted)`);
        if (m.c0mpute_private_link) console.log(`  c0mpute  ${m.c0mpute_private_link}\n           ${m.c0mpute_private_link_warning}`);
        for (const x of m.shares) console.log(`  ${x.role.padEnd(8)} ${x.url}${x.label ? `  (for ${x.label})` : ''}${x.expires_at ? `  until ${x.expires_at.slice(0, 10)}` : ''}`);
      }
      return 0;
    }

    case 'shares': {
      const list = await client.shares(args[0] || null);
      if (!list.length) console.log('no share links');
      for (const s of list) console.log(`${s.id}  ${(s.revoked ? 'revoked' : s.expired ? 'expired' : 'live').padEnd(8)} ${s.meeting_id}  ${String(s.role).padEnd(6)} ${s.label ? `(for ${s.label})  ` : ''}${s.url}`);
      return 0;
    }

    case 'unshare': {
      if (!args[0]) return err('usage: board-saas unshare <share_id>'), 2;
      const s = await client.revokeShare(args[0]);
      console.log(`revoked ${s.id}`);
      return 0;
    }

    case 'recording': {
      if (!args[0]) return err('usage: board-saas recording <id> [--out file.mp3]'), 2;
      const out = flags.out ? String(flags.out) : `board-${args[0]}.mp3`;
      writeFileSync(out, await client.recording(args[0]));
      console.log(out);
      return 0;
    }

    case 'transcript': {
      if (!args[0]) return err('usage: board-saas transcript <id>'), 2;
      for (const l of await client.transcript(args[0])) console.log(`${String(Math.floor(l.t / 60)).padStart(2, '0')}:${String(Math.round(l.t % 60)).padStart(2, '0')}  ${l.speaker}${l.source === 'chat' ? ' (chat)' : ''}: ${l.text}`);
      return 0;
    }

    case 'delete-recording': {
      if (!args[0]) return err('usage: board-saas delete-recording <id>'), 2;
      await client.deleteRecording(args[0]);
      console.log('deleted: the recording key is destroyed and the transcript removed');
      return 0;
    }

    case 'voice-pass': {
      const r = await client.voiceCheckout();
      console.log(`$${r.price_usd} for ${r.pass_days} days of voice meetings: ${r.checkout_url}`);
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
