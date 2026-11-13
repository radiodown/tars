import { z } from 'zod';

const text = z.string().trim().min(1).max(200);
const optionalText = z.string().max(20000).default('');
const reference = z.string().uuid();
export const departmentSchema = z.object({ name: text, description: optionalText });
export const memberSchema = z.object({
  name: text, departmentId: reference, role: z.enum(['leader', 'member']),
  provider: z.enum(['codex', 'claude']), model: z.string().trim().max(100).default(''),
  reasoning: z.enum(['default', 'low', 'medium', 'high']).default('default'),
  specialty: z.string().max(500).default(''), instructions: optionalText,
});
export const projectSchema = z.object({ name: text, path: z.string().trim().min(1).max(2000), description: optionalText });
export const documentSchema = z.object({
  title: text, kind: z.enum(['agreement', 'specification', 'report', 'instruction', 'skill', 'note']),
  content: z.string().max(100000), projectId: reference.nullable().default(null),
  departmentId: reference.nullable().default(null),
});
export const taskSchema = z.object({
  title: text, description: optionalText, acceptance: optionalText,
  departmentId: reference, projectId: reference.nullable().default(null),
  assigneeId: reference.nullable().default(null),
  priority: z.enum(['low', 'normal', 'high']).default('normal'),
  dependsOn: z.array(reference).max(30).default([]),
  documentIds: z.array(reference).max(10).default([]),
  isolation: z.enum(['worktree', 'copy', 'personal']).default('worktree'),
});
export const settingsSchema = z.object({ maxConcurrent: z.number().int().min(1).max(8), maxSessionMinutes: z.number().int().min(1).max(180) });
export const consultationSchema = z.object({ leaderId: reference, projectId: reference.nullable().default(null), prompt: z.string().trim().min(1).max(16000) });
export const planSchema = z.object({
  summary: z.string().min(1).max(8000), agreement: z.string().min(1).max(24000), specification: z.string().min(1).max(24000),
  tasks: z.array(z.object({
    title: text, description: z.string().max(6000), acceptance: z.string().max(3000),
    assigneeId: reference.nullable(), dependsOn: z.array(z.number().int().min(0)).max(20),
  })).max(20),
});
export const planJsonSchema = {
  type: 'object', additionalProperties: false,
  required: ['summary', 'agreement', 'specification', 'tasks'],
  properties: {
    summary: { type: 'string' }, agreement: { type: 'string' }, specification: { type: 'string' },
    tasks: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['title', 'description', 'acceptance', 'assigneeId', 'dependsOn'],
      properties: {
        title: { type: 'string' }, description: { type: 'string' }, acceptance: { type: 'string' },
        assigneeId: { type: ['string', 'null'] }, dependsOn: { type: 'array', items: { type: 'integer' } },
      },
    } },
  },
};

export const fail = (message, statusCode = 409) => { throw Object.assign(new Error(message), { statusCode }); };
