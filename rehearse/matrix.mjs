// The full set of runs behind the README and REPORT figures, then the report.
//   npm run matrix                      everything (about two and a half hours)
//   npm run matrix -- --only conference,recovery
//   npm run matrix -- --reps 1          one repetition of each run
//   npm run matrix -- --skip-done       keep runs already in results/runs
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { ROOT, sleep } from './common.mjs';

const SESSION = { ARRIVAL_SECONDS: 120, ROUNDS: 3, ROUND_SECONDS: 40 };
const SHORT = { ARRIVAL_SECONDS: 30, ROUNDS: 2, ROUND_SECONDS: 30 };
export const RUNS = [
  { name: 'baseline', reps: 1, env: { DEVICES: 10, TEAMS: 2, ARRIVAL_SECONDS: 10, ROUNDS: 2, ROUND_SECONDS: 20 } },
  { name: 'step-50', reps: 1, env: { ...SHORT, DEVICES: 50, TEAMS: 10 } },
  { name: 'step-100', reps: 1, env: { ...SHORT, DEVICES: 100, TEAMS: 20 } },
  { name: 'step-200', reps: 1, env: { ...SHORT, DEVICES: 200, TEAMS: 40 } },
  // Headline: the conference shape on the stack as the CLI starts it.
  { name: 'conference', reps: 3, env: { ...SESSION, BROWSERS: 2 } },
  // Controlled change: only the Realtime tenant limits differ.
  { name: 'conference-raised', reps: 3, env: { ...SESSION, BROWSERS: 2, LIMITS_PROFILE: 'local-raised' } },
  { name: 'conference-pro-values', reps: 1, env: { ...SESSION, LIMITS_PROFILE: 'local-pro-values' } },
  // Transport experiment against conference-raised: Broadcast instead of Postgres Changes.
  { name: 'transport-broadcast', reps: 3, env: { ...SESSION, LIMITS_PROFILE: 'local-raised', TRANSPORT: 'broadcast' } },
  // Frequency experiment against conference-raised: publish on every decision.
  { name: 'frequency-every-change', reps: 3, env: { ...SESSION, LIMITS_PROFILE: 'local-raised', PUBLISH: 'every_change' } },
  { name: 'frequency-every-change-default', reps: 1, env: { ...SESSION, PUBLISH: 'every_change' } },
  // Recovery: abrupt venue cut while the round result is published.
  { name: 'recovery', reps: 3, env: { ...SESSION, LIMITS_PROFILE: 'local-raised', CUT: 'blackhole', CUT_AT_ROUND: 1, CUT_SECONDS: 20, BROWSERS: 2 } },
  // Controlled change on recovery: a 5 s client heartbeat instead of the library default.
  { name: 'recovery-heartbeat-5s', reps: 3, env: { ...SESSION, LIMITS_PROFILE: 'local-raised', CUT: 'blackhole', CUT_AT_ROUND: 1, CUT_SECONDS: 20, HEARTBEAT_MS: 5000 } },
  // Deliberately severe: every venue connection reset at the same instant.
  { name: 'rejoin-storm-severe', reps: 3, env: { ...SESSION, CUT: 'reset', CUT_AT_ROUND: 1 } },
  { name: 'writers-200-stress', reps: 1, env: { ...SESSION, LIMITS_PROFILE: 'local-raised', WRITERS_PER_TEAM: 5 } },
  { name: 'soak-20min', reps: 1, env: { ARRIVAL_SECONDS: 120, SOAK_MINUTES: 20, ROUND_SECONDS: 40, LIMITS_PROFILE: 'local-raised', REFRESH_PHASE: '1' } },
  // Headroom above 200, raised limits, declared upper bound 500.
  { name: 'headroom-300', reps: 1, env: { ...SHORT, ARRIVAL_SECONDS: 60, DEVICES: 300, TEAMS: 60, LIMITS_PROFILE: 'local-raised' }, headroom: true },
  { name: 'headroom-400', reps: 1, env: { ...SHORT, ARRIVAL_SECONDS: 60, DEVICES: 400, TEAMS: 80, LIMITS_PROFILE: 'local-raised' }, headroom: true },
  { name: 'headroom-500', reps: 1, env: { ...SHORT, ARRIVAL_SECONDS: 60, DEVICES: 500, TEAMS: 100, LIMITS_PROFILE: 'local-raised' }, headroom: true },
];

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const only = opt('--only')?.split(',');
const repsOverride = opt('--reps') ? Number(opt('--reps')) : null;
const skipDone = args.includes('--skip-done');
const runsDir = path.join(ROOT, 'results', 'runs');
const done = new Set(fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter((d) => fs.existsSync(path.join(runsDir, d, 'summary.json'))).map((d) => d.replace(/^\d{8}-\d{6}-/, '')) : []);

const portOpen = (port) => new Promise((res) => { const s = net.connect(port, '127.0.0.1'); s.on('connect', () => { s.destroy(); res(true); }); s.on('error', () => res(false)); });
if (!(await portOpen(3000))) {
  console.log('starting next start on :3000');
  const log = fs.openSync(path.join(ROOT, '.fixtures', 'next.log'), 'a');
  spawn('npm', ['start'], { cwd: ROOT, detached: true, stdio: ['ignore', log, log] }).unref();
  for (let i = 0; i < 60 && !(await portOpen(3000)); i++) await sleep(500);
}

const lastSummary = (label) => {
  const dirs = fs.readdirSync(runsDir).filter((d) => d.endsWith(`-${label}`)).sort();
  return dirs.length ? JSON.parse(fs.readFileSync(path.join(runsDir, dirs.at(-1), 'summary.json'), 'utf8')) : null;
};

let headroomStopped = false;
for (const run of RUNS) {
  if (only && !only.includes(run.name)) continue;
  if (run.headroom && headroomStopped) { console.log(`skip ${run.name}: stopping condition met at a lower step`); continue; }
  const reps = repsOverride ?? run.reps;
  for (let rep = 1; rep <= reps; rep++) {
    const label = `${run.name}-r${rep}`;
    if (skipDone && done.has(label)) { console.log(`skip ${label} (done)`); continue; }
    const env = { ...process.env, ...Object.fromEntries(Object.entries(run.env).map(([k, v]) => [k, String(v)])), RUN_LABEL: label, SEED: String(rep) };
    const r = spawnSync('node', [path.join(ROOT, 'rehearse', 'run.mjs')], { cwd: ROOT, env, stdio: 'inherit' });
    if (r.status !== 0) console.error(`run ${label} exited with ${r.status}`);
    if (run.headroom) {
      // Stopping conditions: any session target missed, or the generator itself saturated.
      const s = lastSummary(label);
      const t = s?.outcomes.targets ?? {};
      const g = s?.outcomes.generator ?? {};
      if (!s || !t.zero_lost_acknowledged_decisions || !t.submit_p95_under_1s || !t.all_screens_final_within_5s || g.schedule_lateness_p99_ms > 100) {
        headroomStopped = true;
        console.log(`headroom stop after ${label}`);
      }
    }
  }
}

if (!only || only.includes('auth')) spawnSync('node', [path.join(ROOT, 'rehearse', 'auth-arrival.mjs')], { cwd: ROOT, stdio: 'inherit' });
if (!only || only.includes('k6')) {
  for (const n of [200]) {
    spawnSync('node', [path.join(ROOT, 'rehearse', 'k6-prep.mjs')], { cwd: ROOT, env: { ...process.env, DEVICES: String(n) }, stdio: 'inherit' });
    spawnSync('k6', ['run', '--quiet', '-e', `DEVICES=${n}`, 'conference-http.js'], { cwd: path.join(ROOT, 'k6'), stdio: 'inherit' });
  }
}
spawnSync('node', [path.join(ROOT, 'rehearse', 'report.mjs')], { cwd: ROOT, stdio: 'inherit' });
