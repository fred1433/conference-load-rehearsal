// Writes .env.local from the running local stack (`supabase status`).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './common.mjs';

const s = JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
const lines = [
  `SUPABASE_URL=${s.API_URL}`,
  `SUPABASE_ANON_KEY=${s.ANON_KEY}`,
  `SUPABASE_SERVICE_ROLE_KEY=${s.SERVICE_ROLE_KEY}`,
  `DB_URL=${s.DB_URL}`,
];
fs.writeFileSync(path.join(ROOT, '.env.local'), lines.join('\n') + '\n');
console.log('wrote .env.local for', s.API_URL);

// The published figures were measured with this CLI, which fixes the image versions.
const MEASURED_CLI = '2.120.0';
const cli = execFileSync('supabase', ['--version'], { encoding: 'utf8' }).trim().split('\n')[0];
if (cli !== MEASURED_CLI) console.warn(`note: Supabase CLI ${cli}; the README figures were measured with ${MEASURED_CLI} (see Quick start for the image versions)`);
