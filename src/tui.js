// board-saas tui: your meetings on the left, the selected meeting's minutes on the right.
// Built with @profullstack/hqtui. Keys: up/down select, r refresh, n new meeting, q quit.
import { createInterface } from 'node:readline/promises';

export function detailLines(v) {
  if (!v) return ['Select a meeting.'];
  const out = [`Status: ${v.status}${v.progress?.stage && v.status !== 'done' ? ` (${v.progress.stage}${v.progress.of ? ` ${v.progress.done}/${v.progress.of}` : ''})` : ''}`, `Link: ${v.url}`, ''];
  if (v.checkout_url) out.push(`Pay $${v.price_usd} to start: ${v.checkout_url}`, '');
  if (v.clarify) out.push('The chair asks (once):', ...v.clarify.questions.map((q) => `  - ${q.question}`), `Answer: board-saas clarify ${v.id} "<answers>"`, '');
  if (v.error) out.push(`Error: ${v.error}`, '');
  if (v.meeting) {
    const m = v.meeting;
    out.push(m.title, '', `Decision: ${m.brief.decision}`, '', 'Vote after the debate:');
    for (const x of m.minutes.vote) out.push(`  ${x.expert.padEnd(13)} ${x.final}${x.changed ? '  [changed mind]' : ''}`);
    out.push('', `Majority: ${m.minutes.majority}`, '', 'Where they clashed:');
    for (const c of m.minutes.clashes) out.push(`  - ${c.topic}: ${c.sides}. Crux: ${c.crux}`);
    out.push('', `Strongest dissent (${m.minutes.dissent.expert}): ${m.minutes.dissent.argument}`, '', `Recommendation: ${m.minutes.recommendation}`, '', `The one question: ${m.minutes.question}`, '', `Report: ${v.report_url}`);
  } else {
    out.push('Brief:', v.brief_text ?? '');
  }
  return out;
}

export function view(state) {
  return ({ ui }) => {
    ui.column({}, (col) => {
    col.grid({ columns: ['1fr', '2fr'], rows: ['1fr'], gap: 0, size: '1fr' }, (g) => {
      g.panel({ title: 'Meetings' }, (p) => {
        if (!state.list.length) p.text(state.error || 'No meetings yet. Press n to convene the board.');
        else
          p.list({
            items: state.list.map((m) => ({ label: `${m.created_at.slice(5, 16).replace('T', ' ')} ${m.brief.replace(/\s+/g, ' ').slice(0, 40)}`, badge: m.status })),
            selected: state.selected,
            followSelection: true,
          });
      });
      g.panel({ title: state.detail?.meeting?.title ?? 'Meeting' }, (p) => {
        p.text(detailLines(state.detail).join('\n'), { wrap: true, scroll: state.scroll || 0 });
      });
    });
      col.statusBar({
        items: [
          { key: 'up/down', label: 'select' },
          { key: 'pgup/pgdn', label: 'scroll' },
          { key: 'r', label: 'refresh' },
          { key: 'n', label: 'new meeting' },
          { key: 'q', label: 'quit' },
        ],
        right: [{ label: state.account ? `${state.account.email ?? 'admin'} - ${state.account.free_meeting_available ? 'free meeting ready' : `${state.account.credits} credit(s)`}` : 'Board as a Service' }],
      });
    });
  };
}

export async function runTui(client) {
  if (!client.key) {
    process.stderr.write('not signed in: run board-saas login <email> first\n');
    return;
  }
  const { createApp } = await import('@profullstack/hqtui');
  const state = { list: [], selected: 0, detail: null, account: null, error: '', scroll: 0 };

  async function refresh() {
    try {
      state.account = await client.account();
      state.list = await client.listMeetings();
      state.selected = Math.min(state.selected, Math.max(0, state.list.length - 1));
      state.detail = state.list[state.selected] ? await client.getMeeting(state.list[state.selected].id) : null;
      state.error = '';
    } catch (e) {
      state.error = `Could not reach the API: ${e.message}`;
    }
  }

  for (;;) {
    await refresh();
    const app = await createApp();
    let next = 'quit';
    app.render(view(state));
    const timer = setInterval(() => refresh().then(() => app.invalidate()), 5000);
    app.on('key', (k) => {
      if (k.key === 'q' || k.key === 'ctrl+c' || k.name === 'escape') app.stop();
      else if (k.name === 'up' || k.name === 'down') {
        state.selected = Math.max(0, Math.min(state.list.length - 1, state.selected + (k.name === 'up' ? -1 : 1)));
        state.scroll = 0;
        const m = state.list[state.selected];
        if (m) client.getMeeting(m.id).then((d) => { state.detail = d; app.invalidate(); }, () => {});
        app.invalidate();
      } else if (k.name === 'pagedown' || k.name === 'pageup') {
        state.scroll = Math.max(0, (state.scroll || 0) + (k.name === 'pagedown' ? 10 : -10));
        app.invalidate();
      } else if (k.key === 'r') refresh().then(() => app.invalidate());
      else if (k.key === 'n') {
        next = 'new';
        app.stop();
      }
    });
    await app.start();
    clearInterval(timer);
    if (next !== 'new') return;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const brief = (await rl.question('Brief (decision, options, constraints; Enter to cancel):\n> ')).trim();
    rl.close();
    if (brief) {
      try {
        const v = await client.runMeeting(brief);
        if (v.status === 'awaiting_payment') {
          process.stdout.write(`Pay $${v.price_usd} to start it: ${v.checkout_url}\nPress Enter to go back.`);
          const r2 = createInterface({ input: process.stdin, output: process.stdout });
          await r2.question('');
          r2.close();
        }
        state.selected = 0;
      } catch (e) {
        process.stdout.write(`Could not start: ${e.message}\n`);
      }
    }
  }
}
