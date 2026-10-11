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
