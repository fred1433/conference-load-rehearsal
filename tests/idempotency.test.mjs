// Needs the local stack and `npm start` running (see README quick start).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadEnv, sleep } from '../rehearse/common.mjs';
import { db, ensureUsers, createSession } from '../rehearse/setup.mjs';
import { createAdapter } from '../rehearse/adapters/reference-app.mjs';
import { VenueLink } from '../rehearse/netcut.mjs';
import { Clock } from '../rehearse/scheduler.mjs';
import { Device } from '../rehearse/device.mjs';

loadEnv();
const sql = db();
const users = await ensureUsers(4, sql);
const sessionId = randomUUID();
await createSession(sql, { id: sessionId, label: 'test', transport: 'postgres_changes', publish: 'aggregate' });
const link = new VenueLink([{ listen: 3101, host: '127.0.0.1', port: 3000 }, { listen: 54401, host: '127.0.0.1', port: 54321 }]);
await link.start();
const env = { appUrl: 'http://127.0.0.1:3000', supabaseUrl: process.env.SUPABASE_URL, anonKey: process.env.SUPABASE_ANON_KEY,
  venueAppUrl: 'http://127.0.0.1:3101', venueSupabaseUrl: 'http://127.0.0.1:54401', heartbeatMs: 2000,
  transport: 'postgres_changes', sessionId, channelsPerConn: 1 };
const a = createAdapter(env);
const dev = (user, role, team, path = 'direct') => ({ user, role, team, path, token: user.access_token });
const fac = dev(users[0], 'facilitator', 0);
const p1 = dev(users[1], 'participant', 0);
const p2 = dev(users[2], 'participant', 0);
for (const d of [fac, p1, p2]) assert.equal((await a.join(d)).data.status, 'joined');
const rows = async (id) => (await sql`select count(*)::int as n from public.decisions where submission_id = ${id}`)[0].n;

test.after(async () => { await link.stop(); await sql.end(); });

test('a retried submission after a lost response is stored once and scored once', async () => {
  assert.equal((await a.openRound(fac, 1, 60)).data.status, 'open');
  const id = randomUUID();
  const payload = { speed: 70, risk: 20 };
  const first = await a.submitDecision(p1, { submission_id: id, round: 1, payload });
  assert.equal(first.data.status, 'stored');
  // The phone never saw `first`; it retries with the same submission_id.
  const retry = await a.submitDecision(p1, { submission_id: id, round: 1, payload });
  assert.equal(retry.data.status, 'duplicate');
  assert.equal(await rows(id), 1);

  const other = await a.submitDecision(p2, { submission_id: randomUUID(), round: 1, payload: { speed: 10, risk: 0 } });
  assert.equal(other.data.status, 'rejected');
  assert.equal(other.data.reason, 'team_already_submitted');

  const close = await a.closeRound(fac, 1);
  assert.equal(close.data.status, 'closed');
  const again = await a.closeRound(fac, 1);
  assert.equal(again.data.status, 'already_closed');
  const [score] = await sql`select total, rounds_scored from public.team_scores where session_id = ${sessionId} and team = 0`;
  const [expected] = await sql`select public.score_of(0, 1, ${sql.json(payload)}) as s`;
  assert.equal(score.rounds_scored, 1);
  assert.equal(score.total, expected.s);

  const late = await a.submitDecision(p1, { submission_id: randomUUID(), round: 1, payload });
  assert.equal(late.data.reason, 'round_not_open');
});

test('after a network cut, a reconnected client proves it holds the current result_version', async () => {
  const clock = new Clock();
  const cfg = { sessionMode: 'reuse' };
  const d = new Device({ id: 't', role: 'participant', team: 1, writer: false, subscriber: true, path: 'venue', user: users[3], adapter: a, clock, cfg });
  await d.arrive(0);
  assert.ok(d.ready);
  await a.openRound(fac, 2, 60);
  link.blackhole();
  const close = await a.closeRound(fac, 2); // published while the device is cut off
  await sleep(1500);
  assert.ok(d.finalVersion < close.data.final_version, 'the device must not have received the result during the cut');
  link.restore();
  const deadline = Date.now() + 20000;
  while (d.finalVersion < close.data.final_version && Date.now() < deadline) await sleep(100);
  d.close();
  assert.equal(d.finalVersion, close.data.final_version);
  assert.ok(d.recoveries.some((r) => r.reason === 'rejoin' && r.version === close.data.final_version));
});
