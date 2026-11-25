// MCP (Model Context Protocol) over JSON-RPC 2.0, shared by the HTTP endpoint (/mcp,
// streamable HTTP, JSON responses, OAuth 2.1 bearer) and the CLI's stdio bridge. `impl`
// supplies the tools: the server calls its service, the CLI calls the API.
export const PROTOCOL_VERSION = '2025-06-18';

export const TOOLS = [
  {
    name: 'run_meeting',
    title: 'Run a board meeting',
    annotations: { title: 'Run a board meeting', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description:
      'Starts a board meeting on a decision brief: five AI advisors (CFO, Growth Marketer, Operator, Founder-Time Strategist, Contrarian Investor) give verdicts and debate, and a chair writes the minutes. Returns the meeting id, its status (queued, needs_clarification, running, done, failed) and its shareable URL. A meeting takes about 2 to 6 minutes. The first meeting per account is free (open models on c0mpute); a Profullstack Pass covers meetings while active. Otherwise meetings are pay as you go on Claude Opus 5.5, charged to the user\'s c0mpute balance at Board\'s Anthropic cost plus 20%: an error with code connect_c0mpute means call connect_c0mpute and have the user open the link; insufficient_balance carries top_up_url. A failed meeting is not charged. With needs_clarification it carries the chair\'s questions. The advisors are AI models, not real directors.',
    inputSchema: {
      type: 'object',
      properties: {
        brief: { type: 'string', description: 'The decision, the options (at least two; "do nothing" counts) and the constraints (budget, time, team).' },
        company_data: {
          description:
            'Optional company figures every advisor reads with the brief: P&L and balance sheet totals, cash, burn, runway, MRR, churn, pipeline, headcount. Text or a JSON object, at most 12000 characters. Not shown on the shareable report.',
          anyOf: [{ type: 'string' }, { type: 'object' }],
        },
        wait_seconds: { type: 'number', description: 'Seconds (at most 50) the call holds before returning, in case the meeting finishes sooner. Default 0.' },
        voice: { type: 'boolean', description: 'Hold the meeting as a live voice call on PairUX that the user can join from the PairUX desktop app or a browser (call.join_url in the result once the brief is checked). The board starts when they join, or after a few minutes. Default false. Voice meetings have a free trial per account (up to 90 days, fixed at the first voice meeting; get_account shows the days left), then are paid; a refused voice meeting returns voice_trial_ended with a checkout_url.' },
        record: { type: 'boolean', description: 'For a voice meeting: record the call (encrypted, private to the account) with a transcript. Default true.' },
        qa_mode: { type: 'string', enum: ['realtime', 'queued'], description: 'How questions asked during the meeting (spoken, typed in the call chat, the PairUX Q&A panel, or submit_question) are taken. realtime (default): the agenda yields at the next sentence and one member answers within seconds. queued: the chair notes each question at once and takes them at set points (after the verdicts, after the debate, a Q&A before the minutes, and while the board is still thinking), each answered by a short round of the relevant members and a one-line summary from the chair.' },
      },
      required: ['brief'],
    },
  },
  {
    name: 'submit_question',
    title: 'Ask the board a question',
    annotations: { title: 'Ask the board a question', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: 'Asks the board a question while a meeting runs (status queued, checking or running). On a voice meeting the chair takes it per the meeting\'s qa_mode: realtime answers it within seconds at the next sentence, queued notes it and takes it at the next Q&A point. On a text meeting it is answered when the minutes are written. Answers appear in the report under "Questions to the board", with who asked; get_meeting shows questions and their status while it runs.',
    inputSchema: {
      type: 'object',
      properties: {
        meeting_id: { type: 'string', description: 'The meeting id.' },
        text: { type: 'string', description: 'The question, in plain words (at most 600 characters).' },
        name: { type: 'string', description: 'Optional: who is asking, as the chair should say it. Default: the account name.' },
      },
      required: ['meeting_id', 'text'],
    },
  },
  {
    name: 'get_meeting',
    title: 'Get a board meeting',
    annotations: { title: 'Get a board meeting', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description:
      'Reads a board meeting by id: status (queued, checking, needs_clarification, awaiting_payment, running, done, failed), progress, and when done the full meeting (five verdicts, the debate, the chair\'s minutes with vote, clashes, strongest dissent, recommendation and the one open question) plus report_url and download_url.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The meeting id returned by run_meeting.' },
        brief: { type: 'boolean', description: 'Return a short summary instead of the full meeting JSON. Default false.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'list_meetings',
    title: 'List board meetings',
    annotations: { title: 'List board meetings', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Lists the signed-in account\'s board meetings, newest first: id, status, created_at and the start of each brief.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'clarify_meeting',
    title: 'Answer the chair',
    annotations: { title: 'Answer the chair', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: 'Records answers to the chair\'s one round of questions on a meeting whose status is needs_clarification, and starts the meeting. Anything left unanswered becomes a written assumption. Returns the meeting\'s new status.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The meeting id.' },
        answers: { type: 'string', description: 'The answers, in plain words.' },
      },
      required: ['id', 'answers'],
    },
  },
  {
    name: 'share_meeting',
    title: 'Share a board meeting',
    annotations: { title: 'Share a board meeting', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: 'Creates a share link for a meeting the account owns (meetings are private by default). The link has a role: view (the report), listen (the report, live audio while the meeting runs, the recording afterwards) or join (listen, plus the PairUX link to take part while the call is open). A view link needs a finished meeting; listen and join links can be made for a voice meeting before and while it runs. Options: a label, allowing downloads, and an expiry (never, 24h, 7d, 30d). Returns the full share URL, the role and the share id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The meeting id.' },
        role: { type: 'string', enum: ['view', 'listen', 'join'], description: 'view: the report. listen: the report, the live audio while the meeting runs, and the recording afterwards. join: listen, plus the PairUX link to take part while the call is open (hidden once the meeting ends). Default view, or listen when include_recording is true.' },
        label: { type: 'string', description: 'Optional note of who the link is for (at most 80 characters).' },
        allow_download: { type: 'boolean', description: 'Let the viewer download the recording and see its private c0mpute link, if there is one. Default false.' },
        expires: { type: 'string', enum: ['never', '24h', '7d', '30d'], description: 'When the link stops working. Default never.' },
        include_recording: { type: 'boolean', description: 'Older way to ask for the listen role. Default false.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'invite_to_meeting',
    title: 'Invite someone to a board meeting',
    annotations: { title: 'Invite someone to a board meeting', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: 'Creates an invite link to a meeting the account owns, for one person or group: listen (hear the live audio while it runs, then the report and recording) or join (also take part in the live call on PairUX). Works before the meeting starts and while it runs. Returns the full invite URL, the role and the share id; the link can expire and can be revoked.',
    inputSchema: {
      type: 'object',
      properties: {
        meeting_id: { type: 'string', description: 'The meeting id.' },
        role: { type: 'string', enum: ['view', 'listen', 'join'], description: 'view: the report. listen: the report, the live audio while the meeting runs, and the recording afterwards. join: listen, plus the PairUX link to take part while the call is open (hidden once the meeting ends). Default listen.' },
        label: { type: 'string', description: 'Optional note of who the link is for (at most 80 characters).' },
        allow_download: { type: 'boolean', description: 'Let the viewer download the recording and see its private c0mpute link, if there is one. Default false.' },
        expires: { type: 'string', enum: ['never', '24h', '7d', '30d'], description: 'When the link stops working. Default never.' },
      },
      required: ['meeting_id'],
    },
  },
  {
    name: 'publish_meeting',
    title: 'Publish a board meeting',
    annotations: { title: 'Publish a board meeting', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Sets a meeting the account owns to public or private (private is the default). A public meeting has its own page at a public URL, is listed on the public meetings page and can be indexed by search engines; while it runs the page plays the live audio, afterwards it shows the report. Setting it to private takes the public page down. Returns the meeting with its visibility and public_url.',
    inputSchema: {
      type: 'object',
      properties: {
        meeting_id: { type: 'string', description: 'The meeting id.' },
        visibility: { type: 'string', enum: ['public', 'private'], description: 'public or private.' },
        include_recording: { type: 'boolean', description: 'Also put the call recording and transcript on the public page. Default false.' },
      },
      required: ['meeting_id', 'visibility'],
    },
  },
  {
    name: 'list_shareables',
    title: 'List everything shareable',
    annotations: { title: 'List everything shareable', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Lists, for each of the account\'s meetings, everything that can be handed to someone else: title, status, visibility, the public URL if it is public, every active share link (role, label, URL, expiry), the live playback URL while it is running, and the private c0mpute link of the recording if there is one.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_shares',
    title: 'List share links',
    annotations: { title: 'List share links', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Lists share links: for one meeting when id is given, otherwise all of the account\'s links, each with its full URL, role (view, listen, join), label, and whether it is live, revoked or expired.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Optional meeting id.' } } },
  },
  {
    name: 'revoke_share',
    title: 'Revoke a share link',
    annotations: { title: 'Revoke a share link', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: 'Revokes a share link by its id; the link stops working at once.',
    inputSchema: { type: 'object', properties: { share_id: { type: 'string', description: 'The share id from share_meeting or list_shares.' } }, required: ['share_id'] },
  },
  {
    name: 'start_meeting_now',
    title: 'Start a voice meeting now',
    annotations: { title: 'Start a voice meeting now', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'For a voice meeting waiting for the user to join the call: start it now. The user can still join later.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The meeting id.' } }, required: ['id'] },
  },
  {
    name: 'connect_c0mpute',
    title: 'Connect c0mpute (pay as you go)',
    annotations: { title: 'Connect c0mpute', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description:
      'After the free meeting, meetings are pay as you go: each runs on Claude Opus 5.5 and is charged to the user\'s c0mpute balance (their CoinPay account, topped up with CoinPay) at Board\'s Anthropic cost plus 20%. Returns authorize_url: a c0mpute sign-in link the user must open in a browser to connect their account. Call it when run_meeting answers connect_c0mpute.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'make_branded_video',
    title: 'Make the branded LinkedIn video',
    annotations: { title: 'Make the branded LinkedIn video', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Premium: makes the branded 1080x1080 LinkedIn video of a finished, recorded voice meeting (title banner, waveform, subtitles coloured per speaker, every pause cut to 0.35 s) plus a trimmed MP3. Takes 1 to 2 minutes; get_meeting then shows branded_video.status done and branded_video.video_url. Premium accounts get it made by itself after each recorded voice meeting. Without Premium it returns premium_required with a CoinPay checkout_url ($29 per 30 days by default; included with an active Profullstack Pass). The captioned meeting video is free and made for every recording.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The meeting id.' }, force: { type: 'boolean', description: 'Make it again even if it exists. Default false.' } }, required: ['id'] },
  },
  {
    name: 'get_account',
    title: 'Get account',
    annotations: { title: 'Get account', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Returns the signed-in account: email, whether the free meeting is still available, paid credits left, the price of the next meeting, voice standing (voice trial days left, paid voice until, voice price) and Premium standing (the branded LinkedIn video).',
    inputSchema: { type: 'object', properties: {} },
  },
];

export function summarize(v) {
  if (!v) return 'not found';
  const lines = [`Meeting ${v.id}: ${v.status}`, `URL: ${v.url}`];
  if (v.public_url) lines.push(`Public: ${v.public_url}`);
  if (v.live?.playback_url) lines.push(`Live audio (unlisted c0mpute stream; invite people with invite_to_meeting): ${v.live.playback_url}`);
  if (v.progress?.stage && v.status !== 'done') lines.push(`Progress: ${v.progress.stage}${v.progress.of ? ` ${v.progress.done}/${v.progress.of}` : ''}`);
  if (v.checkout_url) lines.push(`Pay $${v.price_usd} to start it: ${v.checkout_url}`);
  if (v.call) {
    if (v.call.join_url && ['waiting', 'live'].includes(v.call.status)) lines.push(`Live call (${v.call.status}${v.call.recorded ? ', recorded' : ''}): join on PairUX at ${v.call.join_url} (code ${v.call.join_code})`);
    else if (v.call.how) lines.push(`Call: ${v.call.how}`);
    if (v.call.status === 'failed') lines.push(`The live call failed (${v.call.error}); the meeting continues as text.`);
  }
  if (v.clarify) lines.push('The chair needs (asked once):', ...v.clarify.questions.map((q) => `- ${q.question}`));
  if (v.error) lines.push(`Error: ${v.error}`);
  if (v.meeting) {
    const m = v.meeting.minutes;
    if (v.meeting.qa?.length) lines.push('', `Founder Q&A: ${v.meeting.qa.length} question(s) answered on the call.`);
    if (v.recording && !v.recording.deleted) lines.push(`Recording: ${v.recording.seconds}s (private; share it with share_meeting)`);
    if (v.branded_video?.status === 'done') lines.push(`LinkedIn video (Premium, branded 1080x1080 MP4): ${v.branded_video.video_url}${v.branded_video.trimmed_mp3_url ? ` · trimmed MP3: ${v.branded_video.trimmed_mp3_url}` : ''} (needs your key; POST .../branded-video/link for a 6-hour link)`);
    else if (v.branded_video?.status === 'queued' || v.branded_video?.status === 'rendering') lines.push(`LinkedIn video: ${v.branded_video.status} (1 to 2 minutes)`);
    if (v.recording?.c0mpute?.private_link) lines.push(`Private c0mpute link: ${v.recording.c0mpute.private_link} (${v.recording.c0mpute.warning})`);
    lines.push('', `Majority: ${m.majority}`, '', 'Vote:', ...m.vote.map((x) => `- ${x.expert}: ${x.final}${x.changed ? ' (changed mind)' : ''}`), '', `Strongest dissent (${m.dissent.expert}): ${m.dissent.quote ? `"${m.dissent.quote}" ` : ''}${m.dissent.argument}`, '', `Recommendation: ${m.recommendation}`, '', `The one question: ${m.question}`, '', `Report: ${v.report_url}`, `Download: ${v.download_url}`);
  }
  return lines.join('\n');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROLE_TEXT = { view: 'view: report only', listen: 'listen: report, live audio, recording', join: 'join: listen plus the live call' };

/**
 * impl = { runMeeting(brief, companyData) -> view, getMeeting(id) -> view,
 *          listMeetings() -> [..], clarify(id, answers) -> view, account() -> {..} }
 * Returns a function(message) -> response | null (null for notifications).
 */
export function createMcpHandler(impl, { name = 'board-saas', version = '0.1.0' } = {}) {
  async function callTool(tool, args = {}) {
    if (tool === 'run_meeting') {
      let v = await impl.runMeeting(args.brief, args.company_data ?? null, { voice: args.voice === true, record: args.record !== false, ...(args.qa_mode ? { qa_mode: args.qa_mode } : {}) });
      const until = Date.now() + Math.min(Number(args.wait_seconds) || 0, 50) * 1000;
      while (until > Date.now() && ['queued', 'checking', 'running'].includes(v.status)) {
        await sleep(3000);
        v = await impl.getMeeting(v.id);
      }
      return { content: [{ type: 'text', text: summarize(v) }], structuredContent: strip(v) };
    }
    if (tool === 'get_meeting') {
      const v = await impl.getMeeting(args.id);
      return { content: [{ type: 'text', text: args.brief ? summarize(v) : `${summarize(v)}\n\n${JSON.stringify(v.meeting ?? {}, null, 1)}` }], structuredContent: strip(v) };
    }
    if (tool === 'list_meetings') {
      const list = await impl.listMeetings();
      const text = list.length ? list.map((m) => `${m.id}  ${m.status}  ${m.created_at.slice(0, 16)}  ${m.brief.replace(/\s+/g, ' ').slice(0, 90)}`).join('\n') : 'no meetings yet';
      return { content: [{ type: 'text', text }], structuredContent: { meetings: list } };
    }
    if (tool === 'clarify_meeting') {
      const v = await impl.clarify(args.id, args.answers);
      return { content: [{ type: 'text', text: summarize(v) }], structuredContent: strip(v) };
    }
    if (tool === 'share_meeting' || tool === 'invite_to_meeting') {
      const role = args.role ?? (tool === 'invite_to_meeting' ? 'listen' : undefined);
      const s = await impl.shareMeeting(args.id ?? args.meeting_id, { role, label: args.label, include_recording: args.include_recording === true, allow_download: args.allow_download === true, expires: args.expires || 'never' });
      return { content: [{ type: 'text', text: `${tool === 'invite_to_meeting' ? 'Invite' : 'Share'} link (${ROLE_TEXT[s.role] ?? s.role}${s.label ? `, for ${s.label}` : ''}, ${s.expires_at ? `expires ${s.expires_at.slice(0, 10)}` : 'no expiry'}): ${s.url}\nShare id: ${s.id} (revoke_share stops it)` }], structuredContent: s };
    }
    if (tool === 'list_shares') {
      const list = await impl.listShares(args.id || null);
      const text = list.length ? list.map((s) => `${s.id}  ${s.revoked ? 'revoked' : s.expired ? 'expired' : 'live'}  ${s.meeting_id}  ${s.role}${s.label ? ` (for ${s.label})` : ''}  ${s.url}`).join('\n') : 'no share links';
      return { content: [{ type: 'text', text }], structuredContent: { shares: list } };
    }
    if (tool === 'publish_meeting') {
      const v = await impl.publishMeeting(args.meeting_id ?? args.id, { visibility: args.visibility, include_recording: args.include_recording });
      const text = v.visibility === 'public' ? `Meeting ${v.id} is public: ${v.public_url}${v.public_recording ? ' (with the recording)' : ''}\nIt is listed on the public meetings page and can be indexed. Set visibility to private to take it down.` : `Meeting ${v.id} is private. Its public page no longer opens; share links you made still work.`;
      return { content: [{ type: 'text', text }], structuredContent: strip(v) };
    }
    if (tool === 'list_shareables') {
      const list = await impl.listShareables();
      const text = list.length
        ? list
            .map((m) =>
              [
                `${m.meeting_id}  ${m.status}  ${m.visibility}  ${m.title}`,
                m.public_url ? `  public: ${m.public_url}` : null,
                m.live_playback_url ? `  live audio (unlisted, not encrypted): ${m.live_playback_url}` : null,
                m.c0mpute_private_link ? `  private c0mpute link: ${m.c0mpute_private_link}\n  ${m.c0mpute_private_link_warning}` : null,
                ...m.shares.map((s) => `  ${s.role}${s.label ? ` (for ${s.label})` : ''}: ${s.url}${s.expires_at ? ` until ${s.expires_at.slice(0, 10)}` : ''}`),
              ]
                .filter(Boolean)
                .join('\n'),
            )
            .join('\n')
        : 'no meetings yet';
      return { content: [{ type: 'text', text }], structuredContent: { shareables: list } };
    }
    if (tool === 'revoke_share') {
      const s = await impl.revokeShare(args.share_id);
      return { content: [{ type: 'text', text: `Revoked share ${s.id}; ${s.url} no longer works.` }], structuredContent: s };
    }
    if (tool === 'submit_question') {
      const q = await impl.submitQuestion(args.meeting_id ?? args.id, args.text ?? args.question, args.name);
      return { content: [{ type: 'text', text: `Question ${q.id} sent to the board (${q.qa_mode}). ${q.how}` }], structuredContent: q };
    }
    if (tool === 'start_meeting_now') {
      const v = await impl.startNow(args.id);
      return { content: [{ type: 'text', text: summarize(v) }], structuredContent: strip(v) };
    }
    if (tool === 'connect_c0mpute') {
      const r = await impl.connectC0mpute();
      return { content: [{ type: 'text', text: `Open this link to connect c0mpute (pay as you go, charged to the c0mpute balance at Anthropic cost + 20%): ${r.authorize_url}` }], structuredContent: r };
    }
    if (tool === 'make_branded_video') {
      const v = await impl.makeBrandedVideo(args.id, { force: args.force === true });
      const text = v.status === 'done' ? `The LinkedIn video is ready: ${v.video_url}${v.trimmed_mp3_url ? `\nTrimmed MP3: ${v.trimmed_mp3_url}` : ''}\n(Both need the account key; POST /api/v1/meetings/${args.id}/branded-video/link gives a 6-hour link.)` : `The LinkedIn video is ${v.status}. It takes 1 to 2 minutes; get_meeting shows branded_video.video_url when it is done.`;
      return { content: [{ type: 'text', text }], structuredContent: v };
    }
    if (tool === 'get_account') {
      const a = await impl.account();
      const head = a.voice?.summary ? `${a.voice.summary}\n` : '';
      return { content: [{ type: 'text', text: head + JSON.stringify(a, null, 1) }], structuredContent: a };
    }
    const e = new Error(`unknown tool: ${tool}`);
    e.rpc = -32602;
    throw e;
  }

  return async function handle(msg) {
    const id = msg?.id;
    const isNotification = id === undefined || id === null;
    const ok = (result) => (isNotification ? null : { jsonrpc: '2.0', id, result });
    const err = (code, message) => (isNotification ? null : { jsonrpc: '2.0', id, error: { code, message } });
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return err(-32600, 'invalid request');
    switch (msg.method) {
      case 'initialize':
        return ok({
          protocolVersion: msg.params?.protocolVersion || PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name, version },
          instructions: 'Board as a Service: run_meeting convenes five AI advisors (CFO, Growth Marketer, Operator, Founder-Time Strategist, Contrarian Investor) and a chair on a decision brief. company_data takes the company\'s figures (summary P&L, cash, runway, MRR, churn) so the CFO works from real numbers. A meeting takes 2 to 6 minutes: get_meeting reads it until status is done. After the free meeting, meetings are pay as you go on Claude Opus 5.5 from the user\'s c0mpute balance (Anthropic cost plus 20%): connect_c0mpute returns the sign-in link when run_meeting asks for it, and an insufficient_balance error carries a CoinPay top_up_url; needs_clarification means the chair has questions for the user, answered with clarify_meeting. list_meetings lists past meetings. With voice: true the meeting runs as a live call on PairUX the user can join (call.join_url); anyone on it can ask questions by voice, chat, the PairUX Q&A panel or submit_question, taken per qa_mode (realtime answers in seconds, queued at set Q&A points); voice meetings have a free trial (up to 90 days), then are paid (voice_trial_ended carries a checkout_url). Meetings are private to the account by default. share_meeting and invite_to_meeting make links with a role (view, listen, join); list_shares and revoke_share manage them; publish_meeting makes a meeting public or private again; list_shareables lists every public URL, share link, live playback URL and private c0mpute link the account has. Premium (make_branded_video): a branded 1080x1080 LinkedIn video of a voice meeting; get_meeting shows branded_video.video_url. The advisors are AI models on the c0mpute network, not real directors.',
        });
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: TOOLS });
      case 'tools/call':
        try {
          return ok(await callTool(msg.params?.name, msg.params?.arguments));
        } catch (e) {
          if (e.rpc) return err(e.rpc, e.message);
          const extra = e.extra && typeof e.extra === 'object' ? e.extra : {};
          const pay = extra.checkout_url
            ? `\nPay with CoinPay: ${extra.checkout_url}`
            : extra.code === 'connect_c0mpute'
              ? '\nCall connect_c0mpute for a sign-in link, have the user open it, then run the meeting again.'
              : extra.top_up_url
                ? `\nTop up the c0mpute balance with CoinPay: ${extra.top_up_url}`
                : '';
          return ok({ content: [{ type: 'text', text: `Error: ${e.message}${pay}` }], ...(extra.code ? { structuredContent: { error: e.message, ...extra } } : {}), isError: true });
        }
      default:
        return err(-32601, `method not found: ${msg.method}`);
    }
  };
}

function strip(v) {
  if (!v) return {};
  const { meeting, ...rest } = v;
  return meeting ? { ...rest, minutes: meeting.minutes, title: meeting.title } : rest;
}
