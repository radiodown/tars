import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { homedir } from 'node:os';

export async function executable(provider) {
  const name = process.env[`TARS_${provider.toUpperCase()}_BIN`] || provider;
  const directories = [...(process.env.PATH || '').split(delimiter).filter(Boolean), join(homedir(), '.local', 'bin'), join(homedir(), 'bin')];
  // Preserve wrapper names: codex2 selects its account from argv[0], so do not realpath it.
  const candidates = name.includes('/') ? [name] : [...new Set(directories)].map(dir => join(dir, name));
  for (const path of candidates) {
    try { await access(path, constants.X_OK); return path; } catch { /* Try next PATH entry. */ }
  }
  return null;
}
