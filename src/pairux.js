// PairUX partner client: board.saas opens an ordinary PairUX session (the founder joins
// it from the desktop app or the web/PWA with a normal join link), seats its six board
// members as PairUX agents, and gets microphone tokens for them. Partner key = PAIRUX_PARTNER_KEY
// (pux_pk_...), registered in pairux.com's PAIRUX_PARTNERS with an ownerUserId, so seats follow
// that service account's plan and a board call is never blocked by a Free cap.
export function createPairux({ url = 'https://pairux.com', key, fetchImpl = fetch } = {}) {
  const base = String(url).replace(/\/+$/, '');

  async function call(method, path, body, { partner = true, raw = null, contentType = 'application/json', timeoutMs = 30_000 } = {}) {
    const headers = { accept: 'application/json' };
    if (partner) headers.authorization = `Bearer ${key}`;
    if (raw || body !== undefined) headers['content-type'] = contentType;
    const res = await fetchImpl(base + path, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), signal: AbortSignal.timeout(timeoutMs) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(`PairUX ${method} ${path.replace(/[0-9a-f-]{36}/g, ':id')}: ${res.status} ${j.error ?? ''}`.trim());
      e.status = res.status;
      throw e;
    }
    return j.data ?? j;
  }

  return {
    configured: !!key,
    /** -> { sessionId, joinCode, joinUrl, roomName, agents: [{ participantId, name }] } */
    openSession: ({ subject, agents, recorded }) => call('POST', '/api/v1/partner/sessions', { subject, agents, recorded, guestsCanSpeak: true }),
    sessionStatus: (sessionId) => call('GET', `/api/v1/partner/sessions/${sessionId}`),
    endSession: (sessionId) => call('DELETE', `/api/v1/partner/sessions/${sessionId}`),
    /** -> { token, url, roomName } (microphone only) */
    voiceToken: (participantId) => call('POST', `/api/v1/agents/${participantId}/voice-token`, {}, { partner: false }),
    /** The agent's poll: heartbeat + roster + public chat newer than `after`. */
    poll: (participantId, after) => call('GET', `/api/v1/agents/${participantId}${after ? `?after=${encodeURIComponent(after)}` : ''}`, undefined, { partner: false }),
    say: (participantId, content) => call('POST', `/api/v1/agents/${participantId}/messages`, { content: String(content).slice(0, 500) }, { partner: false }),
    leave: (participantId) => call('DELETE', `/api/v1/agents/${participantId}`, undefined, { partner: false }).catch(() => null),
    /** Self-hosted Whisper on PairUX. wav = Buffer. -> { text } */
    transcribe: (wav) => call('POST', '/api/v1/partner/transcribe', undefined, { raw: wav, contentType: 'audio/wav', timeoutMs: 60_000 }),
  };
}
