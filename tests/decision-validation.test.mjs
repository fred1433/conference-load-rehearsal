// Needs the local stack and `npm start` running (see README quick start).
// A malformed decision is refused where it enters, and even a bad row already
// in the table cannot stop the facilitator from closing the round.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadEnv, httpJson } from '../rehearse/common.mjs';
import { db, ensureUsers, createSession } from '../rehearse/setup.mjs';
import { createAdapter } from '../rehearse/adapters/reference-app.mjs';

loadEnv();
const sql = db();
const users = (await ensureUsers(8, sql)).slice(4);
const sessionId = randomUUID();
await createSession(sql, { id: sessionId, label: 'test-validation', transport: 'postgres_changes', publish: 'aggregate' });
const env = { appUrl: 'http://127.0.0.1:3000', supabaseUrl: process.env.SUPABASE_URL, anonKey: process.env.SUPABASE_ANON_KEY,
  venueAppUrl: 'http://127.0.0.1:3000', venueSupabaseUrl: process.env.SUPABASE_URL, heartbeatMs: 2000,
  transport: 'postgres_changes', sessionId, channelsPerConn: 1 };
const a = createAdapter(env);
const dev = (user, role, team) => ({ user, role, team, path: 'direct', token: user.access_token });
const fac = dev(users[0], 'facilitator', 0);
const p1 = dev(users[1], 'participant', 1);
const p2 = dev(users[2], 'participant', 2);
for (const d of [fac, p1, p2]) assert.equal((await a.join(d)).data.status, 'joined');
const stored = async (round) => (await sql`select count(*)::int as n from public.decisions where session_id = ${sessionId} and round = ${round}`)[0].n;
// Straight to PostgREST, skipping the Next.js route, as any other client could.
const rpcDirect = (d, args) => httpJson(`${process.env.SUPABASE_URL}/rest/v1/rpc/submit_decision`, {
  method: 'POST', headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${d.token}` }, body: args });

test.after(async () => { await sql.end(); });

test('a malformed decision is rejected at the route and in the database, never acknowledged', async () => {
  assert.equal((await a.openRound(fac, 1, 60)).data.status, 'open');
  for (const payload of [{ speed: 'abc', risk: 10 }, { speed: 70 }, { speed: 70.5, risk: 1 }, { speed: 1e30, risk: 1 }, { speed: 70, risk: 10, extra: true }, [70, 10]]) {
    const viaRoute = await a.submitDecision(p1, { submission_id: randomUUID(), round: 1, payload });
    assert.equal(viaRoute.status, 400, JSON.stringify(payload));
    assert.equal(viaRoute.data.reason, 'invalid_payload');
    const direct = await rpcDirect(p1, { p_submission_id: randomUUID(), p_round: 1, p_payload: payload });
    assert.equal(direct.data.status, 'rejected', JSON.stringify(payload));
    assert.equal(direct.data.reason, 'invalid_payload');
  }
  assert.equal(await stored(1), 0);
  const ok = await a.submitDecision(p1, { submission_id: randomUUID(), round: 1, payload: { speed: 70, risk: 20, crew: 'balanced' } });
  assert.equal(ok.data.status, 'stored');
});

test('a bad row already in the table does not block the close; it scores 0 for the bad field', async () => {
  // Written past every check, as a row from before validation existed would be.
  await sql`insert into public.decisions (submission_id, session_id, round, team, user_id, payload)
    values (${randomUUID()}, ${sessionId}, 1, 2, ${users[2].user_id}, ${sql.json({ speed: 'abc', risk: 10 })})`;
  const close = await a.closeRound(fac, 1);
  assert.equal(close.data.status, 'closed', JSON.stringify(close.data ?? close.error));
  assert.equal(close.data.scored, 2);
  const [row] = await sql`select total from public.team_scores where session_id = ${sessionId} and team = 2`;
  const [expected] = await sql`select (0 - 10 / 2 + ((2 * 7 + 1 * 13) % 11))::int as s`;
  assert.equal(row.total, expected.s);
});

test('a submission_id reused for another round is refused, not reported as a duplicate', async () => {
  assert.equal((await a.openRound(fac, 2, 60)).data.status, 'open');
  const id = randomUUID();
  // Round 1 is closed, so store the id in round 2 first, then reuse it for round 3.
  assert.equal((await a.submitDecision(p1, { submission_id: id, round: 2, payload: { speed: 50, risk: 5 } })).data.status, 'stored');
  assert.equal((await a.submitDecision(p1, { submission_id: id, round: 2, payload: { speed: 50, risk: 5 } })).data.status, 'duplicate');
  assert.equal((await a.openRound(fac, 3, 60)).data.status, 'open');
  const reuse = await a.submitDecision(p1, { submission_id: id, round: 3, payload: { speed: 50, risk: 5 } });
  assert.equal(reuse.data.status, 'rejected');
  assert.equal(reuse.data.reason, 'submission_id_reused');
});
