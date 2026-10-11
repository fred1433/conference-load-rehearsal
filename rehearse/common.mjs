import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURES = path.join(ROOT, '.fixtures');

export function loadEnv() {
  const p = path.join(ROOT, '.env.local');
  if (!fs.existsSync(p)) throw new Error('.env.local missing: run `npm run env` with the local Supabase stack started');
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Seeded PRNG (mulberry32) so a run's schedule is reproducible.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Percentile over the full denominator: missing outcomes are Infinity, so a
// p95 cannot look healthy when more than 5 % of intended clients never made it.
export function pct(values, p) {
  if (!values.length) return null;
  const v = [...values].map((x) => (x == null || Number.isNaN(x) ? Infinity : x)).sort((a, b) => a - b);
  const idx = Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1));
  return v[idx];
}

export const round1 = (x) => (x == null ? null : Number.isFinite(x) ? Math.round(x * 10) / 10 : 'inf');
export const ms = (x) => (x == null ? null : Number.isFinite(x) ? Math.round(x) : 'never');

export async function httpJson(url, { method = 'GET', headers = {}, body, timeoutMs = 5000 } = {}) {
  const t = performance.now();
  try {
    const res = await fetch(url, {
      method,
      headers: body !== undefined ? { ...headers, 'Content-Type': 'application/json' } : headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 200) }; }
    return { ok: res.ok, status: res.status, data, ms: performance.now() - t };
  } catch (e) {
    const error = e?.name === 'TimeoutError' ? 'timeout' : e?.cause?.code || e?.message || String(e);
    return { ok: false, status: 0, error, ms: performance.now() - t };
  }
}

export function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}
