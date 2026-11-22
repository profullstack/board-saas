// A thin client over the Board as a Service HTTP API. The CLI, TUI and stdio MCP bridge
// all go through this; none of them talk to a model directly.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_URL = 'https://board.saas.pit.world';
export const CLI_CLIENT_ID = 'board-saas-cli';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

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
  const fromEnv = !!env.BOARD_SAAS_KEY;
  return {
    url: (env.BOARD_SAAS_URL || file.url || DEFAULT_URL).replace(/\/+$/, ''),
    key: env.BOARD_SAAS_KEY || file.key || null,
    email: file.email || null,
    // OAuth (device flow) sign-in: the access token is `key`, refreshed with this.
    refresh_token: fromEnv ? null : file.refresh_token || null,
    expires_at: fromEnv ? null : file.expires_at || null,
  };
}

export function saveConfig(cfg, env = process.env) {
  const p = configPath(env);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  return p;
}

export class BoardClient {
  /** onTokens(tokens) is called after a refresh so the caller can save them. */
  constructor({ url = DEFAULT_URL, key = null, refresh_token = null, expires_at = null, fetchImpl = fetch, onTokens = null } = {}) {
    this.url = url.replace(/\/+$/, '');
    this.key = key;
    this.refreshToken = refresh_token;
    this.expiresAt = expires_at;
    this.fetch = fetchImpl;
    this.onTokens = onTokens;
  }

  async form(path, params) {
    const res = await this.fetch(this.url + path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(params).toString(), signal: AbortSignal.timeout(30_000) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error_description || data.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.code = data.error;
      throw err;
    }
    return data;
  }

  setTokens(t) {
    this.key = t.access_token;
    this.refreshToken = t.refresh_token ?? this.refreshToken;
    this.expiresAt = Date.now() + (t.expires_in ?? 3600) * 1000;
    if (this.onTokens) this.onTokens({ key: this.key, refresh_token: this.refreshToken, expires_at: this.expiresAt });
  }

  async refresh() {
    if (!this.refreshToken) return false;
    try {
      this.setTokens(await this.form('/oauth/token', { grant_type: 'refresh_token', refresh_token: this.refreshToken, client_id: CLI_CLIENT_ID }));
      return true;
    } catch (e) {
      if (e.code === 'invalid_grant') {
        this.refreshToken = null;
        return false;
      }
      throw e;
    }
  }

  /**
   * OAuth device flow (RFC 8628). show({user_code, verification_uri, expires_in}) tells the
   * person where to go; resolves with the tokens once they approve.
   */
  async deviceLogin(show, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    const d = await this.form('/oauth/device_authorization', { client_id: CLI_CLIENT_ID, scope: 'board' });
    await show(d);
    let interval = (d.interval || 5) * 1000;
    const until = Date.now() + d.expires_in * 1000;
    while (Date.now() < until) {
      await sleep(interval);
      try {
        const t = await this.form('/oauth/token', { grant_type: DEVICE_GRANT, device_code: d.device_code, client_id: CLI_CLIENT_ID });
        this.setTokens(t);
        return t;
      } catch (e) {
        if (e.code === 'authorization_pending') continue;
        if (e.code === 'slow_down') {
          interval += 5000;
          continue;
        }
        throw e;
      }
    }
    throw new Error('the code expired before it was approved; run login again');
  }

  async request(method, path, body, retried = false) {
    if (!retried && this.refreshToken && this.expiresAt && this.expiresAt - Date.now() < 60_000) await this.refresh();
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
    if (res.status === 401 && !retried && this.refreshToken && (await this.refresh())) return this.request(method, path, body, true);
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
  runMeeting(brief, companyData = null, { voice = false, record = true } = {}) {
    const body = { brief };
    if (companyData) body.company_data = companyData;
    if (voice) Object.assign(body, { voice: true, record: record !== false });
    return this.request('POST', '/api/v1/meetings', body);
  }
  startNow(id) {
    return this.request('POST', `/api/v1/meetings/${encodeURIComponent(id)}/start`, {});
  }
  voiceCheckout() {
    return this.request('POST', '/api/v1/voice/checkout', {});
  }
  share(id, opts = {}) {
    return this.request('POST', `/api/v1/meetings/${encodeURIComponent(id)}/shares`, opts);
  }
  shares(id = null) {
    return this.request('GET', id ? `/api/v1/meetings/${encodeURIComponent(id)}/shares` : '/api/v1/shares').then((r) => r.shares);
  }
  /** Make a meeting public or private again. opts: { visibility: 'public' | 'private', include_recording? } */
  publish(id, opts = {}) {
    return this.request('PATCH', `/api/v1/meetings/${encodeURIComponent(id)}`, opts);
  }
  /** Everything shareable, per meeting: public URL, active shares, live playback URL, private c0mpute link. */
  shareables() {
    return this.request('GET', '/api/v1/shareables').then((r) => r.shareables);
  }
  revokeShare(shareId) {
    return this.request('DELETE', `/api/v1/shares/${encodeURIComponent(shareId)}`);
  }
  transcript(id) {
    return this.request('GET', `/api/v1/meetings/${encodeURIComponent(id)}/transcript`).then((r) => r.transcript);
  }
  deleteRecording(id) {
    return this.request('DELETE', `/api/v1/meetings/${encodeURIComponent(id)}/recording`);
  }
  async recording(id) {
    const res = await this.fetch(`${this.url}/api/v1/meetings/${encodeURIComponent(id)}/recording?download=1`, { headers: this.key ? { authorization: `Bearer ${this.key}` } : {} });
    if (!res.ok) throw new Error(`recording: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
    return Buffer.from(await res.arrayBuffer());
  }
  connections() {
    return this.request('GET', '/api/v1/connections').then((r) => r.connections);
  }
  disconnect(clientId) {
    return this.request('DELETE', `/api/v1/connections/${encodeURIComponent(clientId)}`);
  }
  async logout() {
    if (this.refreshToken) await this.form('/oauth/revoke', { token: this.refreshToken, client_id: CLI_CLIENT_ID }).catch(() => {});
    this.key = this.refreshToken = this.expiresAt = null;
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
    const res = await this.fetch(`${this.url}/api/v1/meetings/${encodeURIComponent(id)}/report.html`, { headers: this.key ? { authorization: `Bearer ${this.key}` } : {} });
    if (!res.ok) throw new Error(`report: HTTP ${res.status}`);
    return res.text();
  }

  /** Poll until the meeting leaves the running states. onUpdate(view) each poll. */
  async waitFor(id, { onUpdate = () => {}, intervalMs = 4000, timeoutMs = 50 * 60_000 } = {}) {
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
