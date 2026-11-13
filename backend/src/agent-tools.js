import { z } from 'zod';
import { departmentSchema, memberSchema, workRequestSchema } from './contracts.js';
import { agentApiBase } from './agent-access.js';

const executionToken = z.string().min(1).optional().describe('Current execution identity token provided in the TARS prompt; required for writes.');

const requestSchema = z.object({
  method: z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']),
  path: z.string().min(1).describe('TARS API path, e.g. /api/members/<id> or /api/tasks/<id>/run'),
  body: z.record(z.string(), z.unknown()).optional().describe('JSON request body; omitted for GET'),
  executionToken,
}).strict();
const definitions = [
  { name: 'tars_get_state', description: 'Read current TARS departments, agents, projects, tasks, sessions, documents and settings. Read back after mutations to verify the result.',
    schema: z.object({}).strict(), method: 'GET', path: '/api/state', readOnly: true },
  { name: 'tars_register_work', description: 'A leader or CEO explicitly registers a business work item after discussing its goal and scope with the user. Provide a meaningful title, instruction (goal and scope), and projectId if applicable. Never register greetings, questions, or status lookups as work. For follow-up on an existing work item, provide its requestId to link this conversation without creating a duplicate. Use the returned ID as requestId for documents, delegated tasks and consultations. Registration enters consultation. Submit agreement/design documents and task drafts first; execution is blocked until the user approves that exact scope in the work UI.',
    schema: workRequestSchema.extend({ executionToken }), method: 'POST', path: '/api/requests' },
  { name: 'tars_create_department', description: 'Create a real TARS department and return its saved ID. Set projectId to assign its default source project, or null for no source project. Check current state first to reuse an existing department.',
    schema: departmentSchema.extend({ executionToken }), method: 'POST', path: '/api/departments' },
  { name: 'tars_create_member', description: 'Register a real TARS AI leader or member in a department. Required: name, departmentId, role (leader/member), provider (codex/claude). Set codexAccount, model, reasoning, specialty and instructions to the requested values. This persists the agent; it does not launch a task.',
    schema: memberSchema.extend({ executionToken }), method: 'POST', path: '/api/members' },
  { name: 'tars_api', description: 'Call TARS management APIs with the current executionToken. GET /api/state; POST /api/{requests,departments,members,projects,documents,tasks}; PATCH /api/{departments,members,documents,tasks}/<id>; PATCH /api/ceo or /api/settings; POST /api/tasks/<id>/{run,cancel,integrate}; POST /api/consult or /api/report with leaderId and prompt (omitted projectId uses the department default; an explicit projectId or null overrides it); POST /api/sessions/<id>/{stop,steer}; POST /api/requests/<id>/proposal to submit or resubmit the current agreement for user approval. The server automatically submits manager consultation results for approval at turn end. Only the user may respond to approvals. Document PATCH requires its current version. Task creation requires title and departmentId, and accepts description, acceptance, assigneeId, projectId, requestId, dependsOn, documentIds and isolation. Register work with tars_register_work first; tasks and work documents must reference its requestId. Consultations accept requestId to delegate within existing work. Chat messages are not work items. Workers submit structured final results; the server schedules a separate manager review and final TARS report. Only the manager or CEO assigns and starts tasks. Reviews and reports return their final response without mutating state through this API. Read state before updates and after writes; do not replay failed mutations.',
    schema: requestSchema },
];
export const agentTools = definitions.map(({ name, description, schema, readOnly = false }) => ({
  name, description, inputSchema: z.toJSONSchema(schema, { io: 'input' }),
  annotations: { readOnlyHint: readOnly, destructiveHint: name === 'tars_api', idempotentHint: readOnly, openWorldHint: false },
}));

export async function callAgentTool(name, input) {
  const definition = definitions.find(tool => tool.name === name);
  if (!definition) throw new Error(`Unknown TARS tool: ${name}`);
  const args = definition.schema.parse(input ?? {});
  const { executionToken: suppliedToken, ...payload } = args;
  const token = suppliedToken || process.env.TARS_EXECUTION_TOKEN;
  const { method, path, body } = definition.path
    ? { method: definition.method, path: definition.path, body: definition.method === 'GET' ? undefined : payload }
    : args;
  if (method !== 'GET' && !token) throw new Error('변경 요청에는 현재 실행의 executionToken이 필요합니다.');
  const base = new URL(agentApiBase());
  const url = new URL(path, base);
  if (url.origin !== base.origin || !url.pathname.startsWith('/api/') || url.username || url.password) {
    throw new Error('Use a /api/ path on the configured TARS server.');
  }
  if (url.pathname === '/api/events') throw new Error('Use /api/state for a snapshot; the event stream is not a request/response tool.');
  const response = await fetch(url, {
    method, redirect: 'error', signal: AbortSignal.timeout(60_000),
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { 'X-Tars-Execution-Token': token } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const content = await response.text();
  return { content: [{ type: 'text', text: content || `HTTP ${response.status}` }], isError: !response.ok };
}
