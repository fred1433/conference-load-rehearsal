// Fixtures: N confirmed users with fresh sessions ("pre-generated sessions"),
// a session row, and the Realtime tenant limits profile.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import postgres from 'postgres';
import crypto from 'node:crypto';
import { FIXTURES, loadEnv, httpJson, sleep } from './common.mjs';

export const PASSWORD = 'rehearsal-only-password-1';
const emailOf = (i) => `rehearsal-${String(i).padStart(4, '0')}@example.test`;

export function db() {
  loadEnv();
  return postgres(process.env.DB_URL, { max: 3, onnotice: () => {} });
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

export async function ensureUsers(n, sql) {
  loadEnv();
  const url = process.env.SUPABASE_URL;
  const admin = { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` };
  const existing = new Set((await sql`select email from auth.users where email like 'rehearsal-%@example.test'`).map((r) => r.email));
  const missing = [];
  for (let i = 0; i < n; i++) if (!existing.has(emailOf(i))) missing.push(i);
  await pool(missing, 10, async (i) => {
    const r = await httpJson(`${url}/auth/v1/admin/users`, { method: 'POST', headers: admin, body: { email: emailOf(i), password: PASSWORD, email_confirm: true } });
    if (!r.ok) throw new Error(`create user ${i}: ${r.status} ${JSON.stringify(r.data)}`);
  });
  // Direct to the local stack (no venue link, no IP limiter configured): this is setup, not the measured arrival.
  const users = await pool([...Array(n).keys()], 16, async (i) => {
    for (let attempt = 1; ; attempt++) {
      const r = await httpJson(`${url}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: process.env.SUPABASE_ANON_KEY }, body: { email: emailOf(i), password: PASSWORD }, timeoutMs: 20000 });
      if (r.ok) return { i, email: emailOf(i), password: PASSWORD, user_id: r.data.user.id, access_token: r.data.access_token, refresh_token: r.data.refresh_token, expires_at: r.data.expires_at };
      if (attempt >= 6) throw new Error(`sign in ${i}: ${r.status} ${r.error ?? JSON.stringify(r.data)}`);
      await sleep(1000 * attempt);
    }
  });
  fs.mkdirSync(FIXTURES, { recursive: true });
  fs.writeFileSync(path.join(FIXTURES, 'users.json'), JSON.stringify(users));
  return users;
}

export async function createSession(sql, { id, label, transport, publish }) {
  await sql`insert into public.sessions (id, label, transport, publish) values (${id}, ${label}, ${transport}, ${publish})`;
}

// Realtime tenant limits. "local-default" is what the CLI seeded in this stack
// (it equals the published Free values); the others are set explicitly.
export const LIMIT_PROFILES = {
  'local-default': { max_concurrent_users: 200, max_events_per_second: 100, max_joins_per_second: 100 },
  'local-pro-values': { max_concurrent_users: 500, max_events_per_second: 500, max_joins_per_second: 500 },
  'local-raised': { max_concurrent_users: 10000, max_events_per_second: 10000, max_joins_per_second: 10000 },
};

// Admin token for the local Realtime tenant API, signed with the container's API_JWT_SECRET.
function realtimeAdminJwt() {
  const env = execFileSync('docker', ['inspect', 'supabase_realtime_rehearsal', '--format', '{{range .Config.Env}}{{println .}}{{end}}'], { encoding: 'utf8' });
  const secret = env.split('\n').find((l) => l.startsWith('API_JWT_SECRET=')).slice('API_JWT_SECRET='.length);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role: 'service', exp: Math.floor(Date.now() / 1000) + 600 })}`;
  return `${unsigned}.${crypto.createHmac('sha256', secret).update(unsigned).digest('base64url')}`;
}

export async function tenantRow(sql) {
  const [row] = await sql`select external_id, max_concurrent_users, max_events_per_second, max_joins_per_second,
    max_channels_per_client, max_bytes_per_second, max_presence_events_per_second, max_payload_size_in_kb, private_only
    from _realtime.tenants where external_id = 'realtime-dev'`;
  return row;
}

export async function applyLimitsProfile(sql, name) {
  const p = LIMIT_PROFILES[name];
  if (!p) throw new Error(`unknown LIMITS_PROFILE ${name}`);
  const row = await tenantRow(sql);
  const same = Object.entries(p).every(([k, v]) => Number(row[k]) === v);
  if (!same) {
    // Through Realtime's tenant API, which updates the row and invalidates its
    // in-memory tenant cache. A container restart would re-seed the defaults.
    const res = await fetch(`${process.env.SUPABASE_URL}/realtime/v1/api/tenants/realtime-dev`, {
      method: 'PUT', headers: { Authorization: `Bearer ${realtimeAdminJwt()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant: p }),
    });
    if (!res.ok) throw new Error(`tenant update failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    await sleep(2000);
  }
  return tenantRow(sql);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sql = db();
  const n = Number(process.env.USERS || 210);
  const users = await ensureUsers(n, sql);
  console.log(`fixtures: ${users.length} users with fresh sessions in .fixtures/users.json`);
  await sql.end();
}
