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
      'Starts a board meeting on a decision brief: five AI advisors (CFO, Growth Marketer, Operator, Founder-Time Strategist, Contrarian Investor) give verdicts and debate, and a chair writes the minutes. Returns the meeting id, its status (queued, needs_clarification, awaiting_payment, running, done, failed) and its shareable URL. A meeting takes about 2 to 6 minutes. With status awaiting_payment the result carries a checkout_url for the $9 meeting fee (the first meeting per account is free); with needs_clarification it carries the chair\'s questions. The advisors are AI models, not real directors.',
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
      },
      required: ['brief'],
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
    name: 'get_account',
    title: 'Get account',
    annotations: { title: 'Get account', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Returns the signed-in account: email, whether the free meeting is still available, paid credits left and the price of the next meeting.',
    inputSchema: { type: 'object', properties: {} },
  },
];

export function summarize(v) {
  if (!v) return 'not found';
  const lines = [`Meeting ${v.id}: ${v.status}`, `URL: ${v.url}`];
  if (v.progress?.stage && v.status !== 'done') lines.push(`Progress: ${v.progress.stage}${v.progress.of ? ` ${v.progress.done}/${v.progress.of}` : ''}`);
  if (v.checkout_url) lines.push(`Pay $${v.price_usd} to start it: ${v.checkout_url}`);
  if (v.clarify) lines.push('The chair needs (asked once):', ...v.clarify.questions.map((q) => `- ${q.question}`));
  if (v.error) lines.push(`Error: ${v.error}`);
  if (v.meeting) {
    const m = v.meeting.minutes;
    lines.push('', `Majority: ${m.majority}`, '', 'Vote:', ...m.vote.map((x) => `- ${x.expert}: ${x.final}${x.changed ? ' (changed mind)' : ''}`), '', `Strongest dissent (${m.dissent.expert}): ${m.dissent.argument}`, '', `Recommendation: ${m.recommendation}`, '', `The one question: ${m.question}`, '', `Report: ${v.report_url}`, `Download: ${v.download_url}`);
  }
  return lines.join('\n');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * impl = { runMeeting(brief, companyData) -> view, getMeeting(id) -> view,
 *          listMeetings() -> [..], clarify(id, answers) -> view, account() -> {..} }
 * Returns a function(message) -> response | null (null for notifications).
 */
export function createMcpHandler(impl, { name = 'board-saas', version = '0.1.0' } = {}) {
  async function callTool(tool, args = {}) {
    if (tool === 'run_meeting') {
      let v = await impl.runMeeting(args.brief, args.company_data ?? null);
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
    if (tool === 'get_account') {
      const a = await impl.account();
      return { content: [{ type: 'text', text: JSON.stringify(a, null, 1) }], structuredContent: a };
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
          instructions: 'Board as a Service: run_meeting convenes five AI advisors (CFO, Growth Marketer, Operator, Founder-Time Strategist, Contrarian Investor) and a chair on a decision brief. company_data takes the company\'s figures (summary P&L, cash, runway, MRR, churn) so the CFO works from real numbers. A meeting takes 2 to 6 minutes: get_meeting reads it until status is done. awaiting_payment means the user needs to open checkout_url; needs_clarification means the chair has questions for the user, answered with clarify_meeting. list_meetings lists past meetings. The advisors are AI models on the c0mpute network, not real directors.',
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
          return ok({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
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
