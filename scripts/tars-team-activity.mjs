#!/usr/bin/env node
import { callAgentTool } from '../backend/src/agent-tools.js';

// Fresh process fallback when an existing MCP connection has cached tools/list.
try {
  const result = await callAgentTool('tars_get_team_activity', JSON.parse(process.argv[2] || '{}'));
  process.stdout.write(result.content.map(item => item.text || '').join('\n') + '\n');
  if (result.isError) process.exitCode = 1;
} catch (error) {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
}
