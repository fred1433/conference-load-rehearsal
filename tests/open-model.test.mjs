// The arrival and deadline schedule must not slow down when the server does.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Clock } from '../rehearse/scheduler.mjs';

async function server(latencyMs) {
  const hits = [];
  const t0 = performance.now();
  const s = http.createServer((req, res) => { hits.push(performance.now() - t0); setTimeout(() => res.end('ok'), latencyMs); });
  s.keepAliveTimeout = 1;
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${s.address().port}/`, hits, close: () => new Promise((r) => { s.closeAllConnections(); s.close(r); }) };
}

async function openModel(latencyMs) {
  const srv = await server(latencyMs);
  const clock = new Clock();
  const pending = [];
  for (let i = 0; i < 50; i++) clock.at(i * 20, () => pending.push(fetch(srv.url).then((r) => r.text())));
  await new Promise((r) => setTimeout(r, 1100));
  const offered = srv.hits.filter((t) => t < 1100).length;
  await Promise.all(pending);
  await srv.close();
  return offered;
}

async function closedLoop(latencyMs) {
  const srv = await server(latencyMs);
  const until = performance.now() + 1000;
  const vu = async () => { while (performance.now() < until) await fetch(srv.url).then((r) => r.text()); };
  await Promise.all(Array.from({ length: 5 }, vu));
  const offered = srv.hits.filter((t) => t < 1100).length;
  await srv.close();
  return offered;
}

test('open model: offered load is identical with and without injected latency', async () => {
  const fast = await openModel(0);
  const slow = await openModel(800);
  assert.equal(fast, 50);
  assert.equal(slow, 50);
});

test('closed loop for contrast: injected latency lowers the offered load', async () => {
  const fast = await closedLoop(0);
  const slow = await closedLoop(800);
  assert.ok(slow < fast / 5, `closed loop offered ${slow} requests with latency vs ${fast} without`);
});
