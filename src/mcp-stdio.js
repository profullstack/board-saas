// MCP over stdio (newline-delimited JSON-RPC), proxying to the HTTP API with your key.
import { createInterface } from 'node:readline';
import { createMcpHandler } from './mcp.js';

export function serveStdio(client, { input = process.stdin, output = process.stdout } = {}) {
  const handle = createMcpHandler({
    runMeeting: (brief, companyData) => client.runMeeting(brief, companyData),
    getMeeting: (id) => client.getMeeting(id),
    listMeetings: () => client.listMeetings(),
    clarify: (id, answers) => client.clarify(id, answers),
    account: () => client.account(),
  });
  const rl = createInterface({ input, crlfDelay: Infinity });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`);
      return;
    }
    const out = await handle(msg);
    if (out) output.write(`${JSON.stringify(out)}\n`);
  });
  return new Promise((resolve) => rl.on('close', resolve));
}
