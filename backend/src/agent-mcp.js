import { createInterface } from 'node:readline';
import { agentTools, callAgentTool } from './agent-tools.js';

// A shared stdio MCP bridge for Codex and Claude. All writes use the web API,
// including its validation, document revisions, history and generated files.
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
for await (const line of lines) {
  let request;
  try { request = JSON.parse(line); }
  catch { send({ id: null, error: { code: -32700, message: 'Invalid JSON' } }); continue; }
  if (request?.id == null) continue;
  try {
    let result;
    switch (request.method) {
      case 'initialize':
        result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'tars', version: '1.0.0' } };
        break;
      case 'ping': result = {}; break;
      case 'tools/list': result = { tools: agentTools }; break;
      case 'tools/call':
        try { result = await callAgentTool(request.params?.name, request.params?.arguments); }
        catch (error) { result = { isError: true, content: [{ type: 'text', text: error.message }] }; }
        break;
      default:
        send({ id: request.id, error: { code: -32601, message: `Unsupported method: ${request.method}` } });
        continue;
    }
    send({ id: request.id, result });
  } catch (error) { send({ id: request.id, error: { code: -32603, message: error.message } }); }
}
