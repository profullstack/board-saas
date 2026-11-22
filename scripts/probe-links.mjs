// Operator probe: open a PairUX partner session, connect six board-member links (one process
// each, as production does), report how long each took and the memory used, then end it.
//   PAIRUX_PARTNER_KEY=... node scripts/probe-links.mjs
import { execSync } from 'node:child_process';
import { childLink } from '../src/agent-link.js';
import { createPairux } from '../src/pairux.js';

const pairux = createPairux({ url: process.env.PAIRUX_URL || 'https://pairux.com', key: process.env.PAIRUX_PARTNER_KEY });
const roles = ['cfo', 'growth', 'operator', 'founder-time', 'contrarian', 'chair'];
const s = await pairux.openSession({ subject: 'link probe', agents: roles.map((r) => ({ name: `Probe ${r} (AI)` })), recorded: false });
const links = [];
try {
  for (let i = 0; i < roles.length; i++) {
    const t0 = Date.now();
    const tok = await pairux.voiceToken(s.agents[i].participantId);
    links.push(await childLink({ url: tok.url, token: tok.token, role: roles[i], subscribe: roles[i] === 'chair', log: console.log }));
    console.log(roles[i], 'up in', Date.now() - t0, 'ms');
  }
  await links[0].play(new Int16Array(24000).fill(2000));
  console.log('played 1 s on cfo');
  const rss = execSync(`ps -o rss= --ppid ${process.pid}`).toString().trim().split(/\s+/).map(Number);
  console.log('children rss MB', rss.map((k) => Math.round(k / 1024)), 'parent', Math.round(process.memoryUsage().rss / 1e6));
} finally {
  await Promise.allSettled(links.map((l) => l.close()));
  await pairux.endSession(s.sessionId);
}
process.exit(0);
