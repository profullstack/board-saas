// A thin client over the Board as a Service HTTP API. The CLI, TUI and stdio MCP bridge
// all go through this; none of them talk to a model directly.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_URL = 'https://board.saas.pit.world';

export function configPath(env = process.env) {
  const base = env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'board-saas', 'config.json');
}

export function loadConfig(env = process.env) {
  let file = {};
  try {
    file = JSON.parse(readFileSync(configPath(env), 'utf8'));
  } catch {
    /* no config yet */
  }
  return {
    url: (env.BOARD_SAAS_URL || file.url || DEFAULT_URL).replace(/\/+$/, ''),
    key: env.BOARD_SAAS_KEY || file.key || null,
    email: file.email || null,
  };
}

export function saveConfig(cfg, env = process.env) {
  const p = configPath(env);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  return p;
}

export class BoardClient {
  constructor({ url = DEFAULT_URL, key = null, fetchImpl = fetch } = {}) {
    this.url = url.replace(/\/+$/, '');
    this.key = key;
    this.fetch = fetchImpl;
  }

  async request(method, path, body) {
    const headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.key) headers.authorization = `Bearer ${this.key}`;
    const res = await this.fetch(this.url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    if (!res.ok && res.status !== 402) {
      const err = new Error(data?.error || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  sendCode(email) {
    return this.request('POST', '/api/v1/auth/code', { email });
  }
  verify(email, code) {
    return this.request('POST', '/api/v1/auth/verify', { email, code });
  }
  account() {
    return this.request('GET', '/api/v1/account');
  }
  runMeeting(brief) {
    return this.request('POST', '/api/v1/meetings', { brief });
  }
  getMeeting(id) {
    return this.request('GET', `/api/v1/meetings/${encodeURIComponent(id)}`);
  }
  listMeetings() {
    return this.request('GET', '/api/v1/meetings').then((r) => r.meetings);
  }
  clarify(id, answers) {
    return this.request('POST', `/api/v1/meetings/${encodeURIComponent(id)}/clarify`, { answers });
  }
  async reportHtml(id) {
    const res = await this.fetch(`${this.url}/api/v1/meetings/${encodeURIComponent(id)}/report.html`);
    if (!res.ok) throw new Error(`report: HTTP ${res.status}`);
    return res.text();
  }

  /** Poll until the meeting leaves the running states. onUpdate(view) each poll. */
  async waitFor(id, { onUpdate = () => {}, intervalMs = 4000, timeoutMs = 20 * 60_000 } = {}) {
    const until = Date.now() + timeoutMs;
    let misses = 0;
    for (;;) {
      let v;
      try {
        v = await this.getMeeting(id);
        misses = 0;
      } catch (e) {
        // A relay restart or a dropped connection must not lose a meeting that is still running.
        const transient = !e.status || e.status >= 500;
        if (!transient || ++misses > 15 || Date.now() > until) throw e;
        await new Promise((r) => setTimeout(r, intervalMs * 2));
        continue;
      }
      onUpdate(v);
      if (!['queued', 'checking', 'running'].includes(v.status)) return v;
      if (Date.now() > until) return v;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}
