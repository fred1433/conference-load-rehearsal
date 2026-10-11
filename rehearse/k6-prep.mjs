// Prepares one session for the k6 HTTP script: N participant tokens plus a facilitator.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { FIXTURES, loadEnv, httpJson, writeJson } from './common.mjs';
import { db, ensureUsers, createSession } from './setup.mjs';

loadEnv();
const n = Number(process.env.DEVICES || 200);
const sql = db();
const users = await ensureUsers(n + 1, sql);
const session = randomUUID();
await createSession(sql, { id: session, label: `k6-${n}`, transport: 'postgres_changes', publish: 'aggregate' });
const app = process.env.APP_URL || 'http://127.0.0.1:3000';
let fac;
for (let a = 1; a <= 3; a++) {
  fac = await httpJson(`${app}/api/join`, { method: 'POST', headers: { Authorization: `Bearer ${users[0].access_token}` }, body: { session_id: session, team: 0, role: 'facilitator' } });
  if (fac.data?.status === 'joined') break;
  await new Promise((r) => setTimeout(r, 1000));
}
if (fac.data?.status !== 'joined') throw new Error(`facilitator join failed: ${fac.status} ${fac.error ?? JSON.stringify(fac.data)}`);
writeJson(path.join(FIXTURES, 'k6.json'), { app, session, facilitator_token: users[0].access_token, tokens: users.slice(1).map((u) => u.access_token) });
console.log(`k6 fixtures: session ${session}, ${n} participant tokens`);
await sql.end();
