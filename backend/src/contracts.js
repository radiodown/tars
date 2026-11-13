import { z } from 'zod';

const text = z.string().trim().min(1).max(200);
const optionalText = z.string().max(20000).default('');
const reference = z.string().uuid();
// Codex advertises effort names per model; retain those values independently of model IDs.
const reasoning = z.string().trim().min(1).max(32).regex(/^[a-z][a-z0-9_-]*$/);
export const codexAccountSchema = z.enum(['codex', 'codex2']);
export const departmentSchema = z.object({ name: text, description: optionalText, projectId: reference.nullable().default(null) });
export const memberSchema = z.object({
  name: text, departmentId: reference, role: z.enum(['leader', 'member']),
  provider: z.enum(['codex', 'claude']), model: z.string().trim().max(100).default(''),
  codexAccount: codexAccountSchema.default('codex'),
  reasoning: reasoning.default('default'),
  specialty: z.string().max(500).default(''), instructions: optionalText,
});
export const projectSchema = z.object({ name: text, path: z.string().trim().min(1).max(2000), description: optionalText });
export const documentSchema = z.object({
  title: text, kind: z.enum(['agreement', 'specification', 'report', 'instruction', 'skill', 'note']),
  content: z.string().max(100000), projectId: reference.nullable().default(null),
  departmentId: reference.nullable().default(null),
  instructionMode: z.enum(['always', 'on_demand']).default('on_demand'),
  readWhen: z.string().trim().max(500).default(''),
}).refine(doc => doc.kind !== 'instruction' || doc.instructionMode !== 'on_demand' || doc.readWhen.length > 0,
  { message: '필요할 때 읽는 지침에는 적용 조건을 입력하세요.', path: ['readWhen'] });
export const taskSchema = z.object({
  title: text, description: optionalText, acceptance: optionalText,
  departmentId: reference, projectId: reference.nullable().default(null),
  assigneeId: reference.nullable().default(null),
  priority: z.enum(['low', 'normal', 'high']).default('normal'),
  dependsOn: z.array(reference).max(30).default([]),
  documentIds: z.array(reference).max(10).default([]),
  isolation: z.enum(['worktree', 'copy', 'personal']).default('worktree'),
  requestId: reference.nullable().optional(),
});
export const settingsSchema = z.object({
  maxConcurrent: z.number().int().min(1).max(8),
  maxSessionMinutes: z.number().int().min(1).max(180),
  maxReworkAttempts: z.number().int().min(0).max(5),
  menuOrder: z.array(z.enum(['/', '/inbox', '/ceo', '/requests', '/projects', '/organization', '/consult', '/tasks', '/sessions', '/library', '/usage']))
    .max(11).refine(order => new Set(order).size === order.length, '메뉴 순서에 중복 항목이 있습니다.'),
}).partial().strict().refine(value => Object.keys(value).length > 0, '변경할 설정이 필요합니다.');
export const workRequestSchema = z.object({
  title: text, instruction: z.string().trim().min(1).max(16000),
  projectId: reference.nullable().default(null), requestId: reference.nullable().default(null),
}).strict();
export const approvalResponseSchema = z.object({
  decision: z.enum(['approve', 'feedback']), comment: z.string().trim().max(16000).default(''),
}).strict().refine(value => value.decision !== 'feedback' || value.comment.length > 0,
  { message: '추가 의견을 입력하세요.', path: ['comment'] });
export const consultationSchema = z.object({ leaderId: reference, projectId: reference.nullable().optional(), prompt: z.string().trim().min(1).max(16000), requestId: reference.nullable().optional() });
export const ceoSettingsSchema = z.object({
  provider: z.enum(['codex', 'claude']), model: z.string().trim().max(100),
  codexAccount: codexAccountSchema,
  reasoning, instructions: z.string().max(20000),
}).partial().strict();
export const ceoReportSchema = z.object({
  projectId: reference.nullable().default(null),
  prompt: z.string().trim().min(1).max(16000).default('현재 프로젝트들의 진행 상황, 차단 사항과 다음 우선순위를 정리해주세요.'),
}).strict();
export const ceoChatSchema = z.object({
  projectId: reference.nullable().default(null),
  prompt: z.string().trim().min(1).max(16000),
}).strict();
export const planSchema = z.object({
  summary: z.string().min(1).max(8000), agreement: z.string().max(24000), specification: z.string().max(24000),
  work: workRequestSchema.omit({ projectId: true }).nullable().default(null),
  tasks: z.array(z.object({
    title: text, description: z.string().max(6000), acceptance: z.string().max(3000),
    assigneeId: reference.nullable(), dependsOn: z.array(z.number().int().min(0)).max(20),
  })).max(20),
});
export const planJsonSchema = {
  type: 'object', additionalProperties: false,
  required: ['summary', 'agreement', 'specification', 'tasks', 'work'],
  properties: {
    summary: { type: 'string' }, agreement: { type: 'string' }, specification: { type: 'string' },
    work: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false,
      required: ['title', 'instruction', 'requestId'], properties: {
        title: { type: 'string' }, instruction: { type: 'string' }, requestId: { type: ['string', 'null'] },
      } }] },
    tasks: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['title', 'description', 'acceptance', 'assigneeId', 'dependsOn'],
      properties: {
        title: { type: 'string' }, description: { type: 'string' }, acceptance: { type: 'string' },
        assigneeId: { type: ['string', 'null'] }, dependsOn: { type: 'array', items: { type: 'integer' } },
      },
    } },
  },
};

// Reports are immutable versions; final prose is rendered from these fields.
export const workResultSchema = z.object({
  summary: z.string().trim().min(1).max(4000),
  workPerformed: z.array(z.string().min(1).max(2000)).max(40),
  artifacts: z.array(z.object({ path: z.string().min(1).max(2000), description: z.string().max(1000) }).strict()).max(40),
  verification: z.array(z.object({ criterion: z.string().min(1).max(1000),
    status: z.enum(['passed', 'failed', 'not_run']), evidence: z.string().max(3000) }).strict()).max(40),
  remaining: z.array(z.string().min(1).max(2000)).max(20),
  followUp: z.array(z.string().min(1).max(2000)).max(20),
}).strict();
export const taskReviewSchema = z.object({
  decision: z.enum(['accepted', 'rework', 'blocked']),
  rationale: z.string().trim().min(1).max(6000),
  checks: z.array(z.object({ criterion: z.string().min(1).max(1000),
    status: z.enum(['passed', 'failed', 'not_verified']), evidence: z.string().trim().min(1).max(3000) }).strict()).max(40),
  reworkInstructions: z.string().max(6000),
  knowledge: z.array(z.string().min(1).max(2000)).max(10),
}).strict();
export const outputSchemaFor = kind => kind === 'plan' ? planJsonSchema
  : kind === 'work' ? z.toJSONSchema(workResultSchema)
    : kind === 'task_review' ? z.toJSONSchema(taskReviewSchema) : null;

export const fail = (message, statusCode = 409) => { throw Object.assign(new Error(message), { statusCode }); };
