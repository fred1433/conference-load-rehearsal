// One rehearsal run. Every parameter is an environment variable; the effective
// values are printed at the start and stored with the results.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ROOT, loadEnv, rng, sleep, writeJson } from './common.mjs';
import { db, ensureUsers, createSession, applyLimitsProfile } from './setup.mjs';
import { VenueLink } from './netcut.mjs';
import { Clock } from './scheduler.mjs';
import { Device } from './device.mjs';
import { createAdapter } from './adapters/reference-app.mjs';
import { startSampler, machine } from './resources.mjs';
import { evaluate } from './evaluate.mjs';
import { startBrowsers } from './browsers.mjs';
import { collectServerLogs } from './server-logs.mjs';

loadEnv();
const e = process.env;
const num = (k, d) => (e[k] !== undefined && e[k] !== '' ? Number(e[k]) : d);
const DEVICES = num('DEVICES', 200);
const cfg = {
  label: e.RUN_LABEL || 'adhoc',
  devices: DEVICES,
  teams: num('TEAMS', 40),
  writersPerTeam: num('WRITERS_PER_TEAM', 1),
  subscribers: num('SUBSCRIBERS', DEVICES),
  channelsPerConn: num('CHANNELS_PER_CONN', 1),
  facilitators: num('FACILITATORS', 1),
  displays: num('DISPLAYS', 1),
  sessionMode: e.SESSION_MODE || 'reuse',
  rounds: num('ROUNDS', 3),
  roundSeconds: num('ROUND_SECONDS', 40),
  breakSeconds: num('BREAK_SECONDS', 5),
  arrivalSeconds: num('ARRIVAL_SECONDS', 120),
  deadlineWindowSeconds: num('DEADLINE_WINDOW_SECONDS', 5),
  soakMinutes: num('SOAK_MINUTES', 0),
  transport: e.TRANSPORT || 'postgres_changes',
  publish: e.PUBLISH || 'aggregate',
  limitsProfile: e.LIMITS_PROFILE || 'local-default',
  cut: e.CUT || 'none',
  cutAtRound: num('CUT_AT_ROUND', 1),
  cutSeconds: num('CUT_SECONDS', 20),
  heartbeatMs: num('HEARTBEAT_MS', 0),
  refreshPhase: e.REFRESH_PHASE === '1',
  lostResponseRate: num('LOST_RESPONSE_RATE', 0.1),
  browsers: num('BROWSERS', 0),
  seed: num('SEED', 1),
};
if (cfg.facilitators !== 1) throw new Error('the reference scenario drives exactly one facilitator');
if (cfg.teams * cfg.writersPerTeam > cfg.devices) throw new Error('TEAMS * WRITERS_PER_TEAM exceeds DEVICES');
if (cfg.subscribers > cfg.devices) throw new Error('SUBSCRIBERS exceeds DEVICES');
if (cfg.soakMinutes > 0) cfg.rounds = Math.max(1, Math.floor((cfg.soakMinutes * 60) / (cfg.roundSeconds + cfg.breakSeconds)));
if (cfg.cut !== 'none' && cfg.cutAtRound >= cfg.rounds) throw new Error('CUT_AT_ROUND must leave a later round');

const actors = {
  participant_devices: cfg.devices, teams: cfg.teams, writers: cfg.teams * cfg.writersPerTeam,
  leaderboard_subscribers: cfg.subscribers + cfg.displays + cfg.facilitators,
  facilitators: cfg.facilitators, displays: cfg.displays, real_browsers: cfg.browsers,
  total_clients: cfg.devices + cfg.displays + cfg.facilitators + cfg.browsers,
  realtime_connections: cfg.subscribers + cfg.displays + cfg.facilitators + cfg.browsers,
  channels_per_connection: cfg.channelsPerConn,
};
console.log(`[run ${cfg.label}]`, JSON.stringify({ ...actors, session_mode: cfg.sessionMode, transport: cfg.transport, publish: cfg.publish, limits: cfg.limitsProfile, cut: cfg.cut, rounds: cfg.rounds }));

const sql = db();
const tenant = await applyLimitsProfile(sql, cfg.limitsProfile);
const nUsers = cfg.browsers + cfg.facilitators + cfg.displays + cfg.devices;
const users = await ensureUsers(nUsers, sql);
const sessionId = randomUUID();
await createSession(sql, { id: sessionId, label: cfg.label, transport: cfg.transport, publish: cfg.publish });

const link = new VenueLink([
  { listen: 3100, host: '127.0.0.1', port: 3000 },
  { listen: 54400, host: '127.0.0.1', port: 54321 },
]);
await link.start();
const env = {
  appUrl: e.APP_URL || 'http://127.0.0.1:3000', supabaseUrl: e.SUPABASE_URL, anonKey: e.SUPABASE_ANON_KEY,
  venueAppUrl: 'http://127.0.0.1:3100', venueSupabaseUrl: 'http://127.0.0.1:54400',
  heartbeatMs: cfg.heartbeatMs, transport: cfg.transport, sessionId, channelsPerConn: cfg.channelsPerConn,
};
const adapter = createAdapter(env);
let nextPid = null;
try { nextPid = Number(execFileSync('lsof', ['-ti', 'tcp:3000', '-sTCP:LISTEN'], { encoding: 'utf8' }).trim().split('\n')[0]) || null; } catch { /* not found */ }

const startedIso = new Date().toISOString();
const clock = new Clock();
const sampler = startSampler(clock, { nextPid, sql });
const r = rng(cfg.seed);

let u = cfg.browsers;
const facilitator = new Device({ id: 'facilitator', role: 'facilitator', team: 0, writer: false, subscriber: true, path: 'direct', user: users[u++], adapter, clock, cfg });
const displays = Array.from({ length: cfg.displays }, (_, k) => new Device({ id: `display-${k}`, role: 'display', team: 0, writer: false, subscriber: true, path: 'direct', user: users[u++], adapter, clock, cfg }));
const participants = Array.from({ length: cfg.devices }, (_, i) => new Device({
  id: `p-${i}`, role: 'participant', team: i % cfg.teams, writer: i < cfg.teams * cfg.writersPerTeam,
  subscriber: i < cfg.subscribers, path: 'venue', user: users[u++], adapter, clock, cfg }));
const devices = [facilitator, ...displays, ...participants];

const LEAD = 2000;
const roundsStart = LEAD + (cfg.arrivalSeconds + 5) * 1000;
const roundMs = cfg.roundSeconds * 1000;
const plan = [];
for (let k = 1; k <= cfg.rounds; k++) {
  const openAt = roundsStart + (k - 1) * (roundMs + cfg.breakSeconds * 1000);
  plan.push({ round: k, openAt, deadline: openAt + roundMs, closeAt: openAt + roundMs + 300 });
}
const opens = [];
const closes = [];
let cut = null;
let refreshAt = null;
const pending = [];

// Room set-up: facilitator and displays first, then the arrival wave.
clock.at(LEAD, () => pending.push(facilitator.arrive(LEAD)), 'arrive');
for (const d of displays) clock.at(LEAD, () => pending.push(d.arrive(LEAD)), 'arrive');
for (const d of participants) {
  const at = LEAD + 1000 + r() * cfg.arrivalSeconds * 1000;
  clock.at(at, () => pending.push(d.arrive(at)), 'arrive');
}
for (const p of plan) {
  clock.at(p.openAt, async () => {
    let res;
    let attempts = 0;
    for (; attempts < 3; attempts++) {
      res = await adapter.openRound(facilitator, p.round, cfg.roundSeconds);
      if (res.ok && res.data?.status === 'open') break;
      await sleep(1000);
    }
    opens.push({ round: p.round, at: p.openAt, done: clock.now(), attempts: attempts + (attempts < 3 ? 1 : 0), ok: res.ok && res.data?.status === 'open', error: res.error ?? res.data?.reason ?? null });
  }, 'open');
  for (const d of participants.filter((x) => x.writer)) {
    const at = p.deadline - (200 + r() * (cfg.deadlineWindowSeconds * 1000 - 200));
    const lose = r() < cfg.lostResponseRate;
    clock.at(at, () => {
      // A device that joined over HTTP can submit even if its Realtime subscription was refused.
      if (!d.joined) { d.submissions.push({ submission_id: null, round: p.round, team: d.team, plannedAt: at, attempts: 0, status: null, reason: 'not_joined', ackAt: null, errors: [] }); return; }
      pending.push(d.submit(p.round, at, lose));
    }, 'submit');
  }
  clock.at(p.closeAt, async () => {
    const start = clock.now();
    let res;
    for (let a = 1; a <= 3; a++) {
      res = await adapter.closeRound(facilitator, p.round);
      if (res.ok) break;
      await sleep(300);
    }
    closes.push({ round: p.round, start, end: clock.now(), ok: res.ok && ['closed', 'already_closed'].includes(res.data?.status) && res.data?.final_version != null,
      status: res.data?.status ?? res.error, final_version: res.data?.final_version ?? null, scored: res.data?.scored });
  }, 'close');
}
if (cfg.cut !== 'none') {
  const p = plan[cfg.cutAtRound - 1];
  const at = p.closeAt - 100;
  clock.at(at, () => {
    if (cfg.cut === 'blackhole') link.blackhole(); else link.resetAll();
    cut = { kind: cfg.cut, round: p.round, at };
    if (cfg.cut === 'blackhole') {
      clock.at(at + cfg.cutSeconds * 1000, () => { link.restore(); cut.restoreAt = at + cfg.cutSeconds * 1000; }, 'restore');
    }
  }, 'cut');
}
if (cfg.refreshPhase) {
  refreshAt = plan[plan.length - 1].openAt + 2000;
  clock.at(refreshAt, () => { for (const d of participants) if (d.ready) pending.push(d.refreshSession()); }, 'refresh');
}

// Real browsers join once the wave has started.
let browsers = null;
if (cfg.browsers) {
  clock.at(LEAD, async () => {
    try { browsers = await startBrowsers({ count: cfg.browsers, env, adapter, users: users.slice(0, cfg.browsers), clock }); }
    catch (err) { console.error('browsers failed:', err.message); }
  }, 'browsers');
}

let endAt = plan[plan.length - 1].closeAt + 15000;
if (cfg.cut === 'blackhole') endAt = Math.max(endAt, plan[cfg.cutAtRound - 1].closeAt + cfg.cutSeconds * 1000 + 40000);
const progress = setInterval(() => {
  const ready = devices.filter((d) => d.ready).length;
  process.stdout.write(`  t=${Math.round(clock.now() / 1000)}s ready=${ready}/${devices.length} closes=${closes.length}/${cfg.rounds}\n`);
}, 30000);
while (clock.now() < endAt) await sleep(250);
clearInterval(progress);
await Promise.race([Promise.allSettled(pending), sleep(10000)]);

let shot = null;
const outDir = path.join(ROOT, 'results', 'runs', `${startedIso.slice(0, 19).replace(/[-:T]/g, '').replace(/^(\d{8})/, '$1-')}-${cfg.label}`);
fs.mkdirSync(outDir, { recursive: true });
if (browsers) { try { shot = path.join(outDir, 'display.png'); await browsers.screenshot(shot); } catch { shot = null; } }

const dbFacts = {
  decisions: (await sql`select submission_id::text as id, round, team from public.decisions where session_id = ${sessionId}`),
  scores: (await sql`select team, total, rounds_scored from public.team_scores where session_id = ${sessionId}`),
  expected: (await sql`select d.team, sum(public.score_of(d.team, d.round, d.payload))::int as total, count(*)::int as n
    from public.decisions d join public.rounds r on r.session_id = d.session_id and r.number = d.round and r.status = 'closed'
    where d.session_id = ${sessionId} group by d.team`),
  results: (await sql`select kind, count(*)::int as n from public.results where session_id = ${sessionId} group by kind`),
};
sampler.stop();
const browserSnap = browsers ? browsers.snapshot() : null;
const outcome = evaluate({ cfg, devices, opens, closes, cut: cut && { ...cut, link: { ...link.stats } }, refreshAt, clock, db: dbFacts, browsers: browserSnap, samples: sampler.samples, endAt });

// Server-side evidence for the run window.
const { counts: logCounts, text: logLines } = collectServerLogs(startedIso);

const versions = {
  supabase_cli: execFileSync('supabase', ['--version'], { encoding: 'utf8' }).trim().split('\n')[0],
  images: execFileSync('docker', ['ps', '--format', '{{.Names}} {{.Image}}'], { encoding: 'utf8' }).trim().split('\n').filter((l) => l.startsWith('supabase_')),
  node: process.version,
  packages: Object.fromEntries(['next', '@supabase/realtime-js', 'playwright', 'postgres'].map((p) => [p, JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', p, 'package.json'), 'utf8')).version])),
};
const authEnv = execFileSync('docker', ['inspect', 'supabase_auth_rehearsal', '--format', '{{range .Config.Env}}{{println .}}{{end}}'], { encoding: 'utf8' })
  .split('\n').filter((l) => /RATE_LIMIT|JWT_EXP|ANONYMOUS_USERS_ENABLED|SECURITY_SB_FORWARDED/.test(l));

const summary = {
  run: { id: path.basename(outDir), label: cfg.label, started_at: startedIso, duration_s: Math.round(endAt / 1000), session_id: sessionId, machine: machine(),
    note: 'Load generator, Next.js (next start) and the Supabase stack share this one machine.' },
  config: cfg, actors,
  environment: { realtime_tenant: tenant, auth_env: authEnv, versions, venue_link: 'participants through a local TCP relay; facilitator and displays direct', server_path: 'Next.js server to Supabase direct (no venue link, no IP forwarding)' },
  outcomes: outcome, db: { decisions: dbFacts.decisions.length, results: dbFacts.results }, server_log_counts: logCounts,
  screenshot: shot ? 'display.png' : null,
};
writeJson(path.join(outDir, 'summary.json'), summary);
fs.writeFileSync(path.join(outDir, 'devices.json.gz'), zlib.gzipSync(JSON.stringify({ devices: devices.map((d) => d.snapshot()), opens, closes, browsers: browserSnap, lateness: clock.lateness })));
writeJson(path.join(outDir, 'resources.json'), sampler.samples);
fs.writeFileSync(path.join(outDir, 'server-log.txt'), logLines);

for (const d of devices) d.close();
if (browsers) await browsers.close();
await link.stop();
await sql.end();
const t = outcome.targets;
console.log(`[done ${cfg.label}] ready ${outcome.joined.ready}/${outcome.joined.intended} | submit p95 ${outcome.submitted.latency_from_planned.p95_ms} ms, lost acked ${outcome.submitted.lost_acknowledged} | rounds ${outcome.rounds.map((x) => `${x.current_within_5s}/${x.intended_recipients}`).join(' ')}${outcome.recovery ? ` | recovered ${outcome.recovery.current_within_30s}/${outcome.recovery.affected}` : ''} | targets ${JSON.stringify(t)}`);
console.log(`  -> ${path.relative(ROOT, outDir)}`);
setTimeout(() => process.exit(0), 500).unref();
