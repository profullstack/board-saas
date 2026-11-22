// Child process for one board member's call connection (see agent-link.js childLink).
import { inProcessLink } from './agent-link.js';
import { loadRtc } from './rtc.js';

let link = null;
const send = (m) => process.connected && process.send(m);

process.on('message', async (m) => {
  if (m.t === 'init') {
    try {
      link = await inProcessLink(loadRtc(), {
        url: m.url,
        token: m.token,
        role: m.role,
        subscribe: m.subscribe,
        agentIds: new Set(m.agentIds),
        connectTimeoutMs: m.connectTimeoutMs,
        log: (message) => send({ t: 'log', message }),
        onHuman: (identity, name) => send({ t: 'human', identity, name }),
        onAudio: (identity, name, pcm) => send({ t: 'audio', identity, name, pcm: Int16Array.from(pcm) }),
      });
      send({ t: 'ready' });
    } catch (e) {
      send({ t: 'error', message: e.message });
      setTimeout(() => process.exit(1), 100);
    }
  } else if (m.t === 'play') {
    try {
      await link.play(m.pcm);
    } catch (e) {
      send({ t: 'log', message: `voice: playback failed: ${e.message}` });
    }
    send({ t: 'played', id: m.id });
  } else if (m.t === 'close') {
    await link?.close().catch(() => {});
    process.exit(0);
  }
});
process.on('disconnect', () => process.exit(0));
