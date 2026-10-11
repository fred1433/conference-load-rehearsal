// Arrival through Auth, reported apart from the session runs.
//  1. What this local stack does by default: 40 anonymous sign-ins from one machine.
//  2. A second Auth container on the same database, identical configuration plus
//     GOTRUE_RATE_LIMIT_HEADER, so the per-IP limiter is active. This script plays
//     the trusted proxy and sets that header: one value for the whole room
//     (venue NAT), or one value per device (forwarded-IP grouping experiment).
//  3. 200 arrivals spread over 120 s, once per auth path.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, FIXTURES, loadEnv, httpJson, rng, sleep, writeJson, pct, ms } from './common.mjs';
import { db, ensureUsers, PASSWORD } from './setup.mjs';

loadEnv();
const ARRIVALS = Number(process.env.ARRIVALS || 200);
const WINDOW_S = Number(process.env.ARRIVAL_SECONDS || 120);
const HEADER = 'X-Venue-Ip';
const NAME = 'rehearsal_auth_limited';
const PORT = 54998;
const outDir = path.join(ROOT, 'results', 'auth');
fs.mkdirSync(outDir, { recursive: true });
const sql = db();
const anon = { apikey: process.env.SUPABASE_ANON_KEY };

// 1. Default local stack, through the API gateway.
const defaultCheck = { requests: 40, statuses: {} };
for (let i = 0; i < 40; i++) {
  const r = await httpJson(`${process.env.SUPABASE_URL}/auth/v1/signup`, { method: 'POST', headers: anon, body: { data: {} } });
  defaultCheck.statuses[r.status] = (defaultCheck.statuses[r.status] || 0) + 1;
}
console.log('default local stack, 40 anonymous sign-ins from one machine:', defaultCheck.statuses);

// 2. Limited clone.
const inspect = JSON.parse(execFileSync('docker', ['inspect', 'supabase_auth_rehearsal'], { encoding: 'utf8' }))[0];
const envFile = path.join(FIXTURES, 'auth-limited.env');
const baseEnv = inspect.Config.Env.filter((l) => !l.startsWith('PATH='));
fs.writeFileSync(envFile, [...baseEnv, `GOTRUE_RATE_LIMIT_HEADER=${HEADER}`].join('\n') + '\n');
const network = Object.keys(inspect.NetworkSettings.Networks)[0];
const effective = baseEnv.filter((l) => /RATE_LIMIT|ANONYMOUS_USERS_ENABLED|JWT_EXP/.test(l)).concat(`GOTRUE_RATE_LIMIT_HEADER=${HEADER}`);

async function startLimited() {
  try { execFileSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' }); } catch { /* absent */ }
  execFileSync('docker', ['run', '-d', '--name', NAME, '--network', network, '-p', `127.0.0.1:${PORT}:9999`, '--env-file', envFile, inspect.Config.Image, ...inspect.Config.Cmd], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    const r = await httpJson(`http://127.0.0.1:${PORT}/health`, { timeoutMs: 1000 });
    if (r.ok) return;
    await sleep(500);
  }
  throw new Error('limited auth container did not become healthy');
}

const base = `http://127.0.0.1:${PORT}`;
const calls = {
  'fresh-anonymous': () => ({ url: `${base}/signup`, method: 'POST', body: { data: {} } }),
  'fresh-email': (i, run) => ({ url: `${base}/signup`, method: 'POST', body: { email: `arrival-${run}-${i}@example.test`, password: PASSWORD } }),
  login: (i, _run, users) => ({ url: `${base}/token?grant_type=password`, method: 'POST', body: { email: users[i].email, password: PASSWORD } }),
  refresh: (i, _run, users) => ({ url: `${base}/token?grant_type=refresh_token`, method: 'POST', body: { refresh_token: users[i].refresh_token } }),
  reuse: (i, _run, users) => ({ url: `${base}/user`, method: 'GET', bearer: users[i].access_token }),
};

async function arrival(pathName, grouping) {
  const users = await ensureUsers(ARRIVALS, sql); // fresh refresh tokens, issued outside the measured window
  await startLimited();
  const runTag = `${Date.now()}`;
  const r = rng(7);
  const t0 = performance.now();
  const out = [];
  await Promise.all(Array.from({ length: ARRIVALS }, (_, i) => new Promise((resolve) => {
    const at = r() * WINDOW_S * 1000;
    setTimeout(async () => {
      const c = calls[pathName](i, runTag, users);
      const headers = { ...anon, [HEADER]: grouping === 'one-venue-ip' ? '203.0.113.10' : `198.51.100.${i % 250}${i >= 250 ? '.x' : ''}` };
      if (c.bearer) headers.Authorization = `Bearer ${c.bearer}`;
      const res = await httpJson(c.url, { method: c.method, headers, body: c.body, timeoutMs: 15000 });
      out.push({ i, at: Math.round(at), done: Math.round(performance.now() - t0), status: res.status, code: res.data?.error_code ?? null, ms: Math.round(res.ms) });
      resolve();
    }, at);
  })));
  out.sort((a, b) => a.at - b.at);
  const ok = out.filter((x) => x.status >= 200 && x.status < 300);
  const limited = out.filter((x) => x.status === 429);
  const statuses = {};
  for (const x of out) statuses[`${x.status}${x.code ? ' ' + x.code : ''}`] = (statuses[`${x.status}${x.code ? ' ' + x.code : ''}`] || 0) + 1;
  const res = {
    path: pathName, grouping, arrivals: ARRIVALS, window_s: WINDOW_S,
    ok: ok.length, rate_limited: limited.length, statuses,
    first_429_at_ms: limited.length ? limited[0].at : null,
    ok_latency: { p50_ms: ms(pct(ok.map((x) => x.ms), 0.5)), p95_ms: ms(pct(ok.map((x) => x.ms), 0.95)) },
    ok_per_30s: Array.from({ length: Math.ceil(WINDOW_S / 30) }, (_, k) => ok.filter((x) => x.at >= k * 30000 && x.at < (k + 1) * 30000).length),
    requests: out,
  };
  writeJson(path.join(outDir, `arrival-${pathName}-${grouping}.json`), res);
  console.log(`${pathName.padEnd(16)} ${grouping.padEnd(15)} ok ${ok.length}/${ARRIVALS}  429 ${limited.length}  first 429 at ${res.first_429_at_ms ?? '-'} ms`);
  return res;
}

const plan = (process.env.AUTH_PLAN || 'fresh-anonymous:one-venue-ip,fresh-email:one-venue-ip,login:one-venue-ip,refresh:one-venue-ip,reuse:one-venue-ip,fresh-anonymous:per-device-ip,login:per-device-ip').split(',');
const results = [];
for (const item of plan) {
  const [p, g] = item.split(':');
  const res = await arrival(p, g);
  const { requests, ...rest } = res;
  results.push(rest);
}
try { execFileSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' }); } catch { /* gone */ }
const image = inspect.Config.Image;
writeJson(path.join(outDir, 'summary.json'), {
  measured_at: new Date().toISOString(), auth_image: image, default_local_check: defaultCheck,
  limited_container_env: effective, header: HEADER,
  note: 'Requests go straight to the Auth container (no gateway). The script stands in for the trusted proxy that sets the rate-limit header.',
  results,
});
await sql.end();
