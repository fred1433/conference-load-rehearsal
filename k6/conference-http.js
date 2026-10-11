// HTTP side of the conference shape, open model (arrival-rate executors):
// arrival wave over ARRIVAL_SECONDS, one round, every team submitting inside the
// last DEADLINE_WINDOW_SECONDS, facilitator close. Realtime is not exercised here;
// rehearse/run.mjs drives it with the official client library.
// Prepare tokens first: `DEVICES=200 node rehearse/k6-prep.mjs`.
import http from 'k6/http';
import { check, sleep } from 'k6';
import exec from 'k6/execution';

const data = JSON.parse(open(__ENV.K6_DATA || '../.fixtures/k6.json'));
const APP = __ENV.APP_URL || data.app;
const DEVICES = Number(__ENV.DEVICES || data.tokens.length);
const TEAMS = Number(__ENV.TEAMS || 40);
const ARRIVAL = Number(__ENV.ARRIVAL_SECONDS || 120);
const ROUND = Number(__ENV.ROUND_SECONDS || 40);
const WINDOW = Number(__ENV.DEADLINE_WINDOW_SECONDS || 5);
const ROUND_START = ARRIVAL + 5;

export const options = {
  scenarios: {
    arrival: { executor: 'constant-arrival-rate', rate: DEVICES, timeUnit: `${ARRIVAL}s`, duration: `${ARRIVAL}s`, preAllocatedVUs: 50, maxVUs: 400, exec: 'arrive' },
    facilitator: { executor: 'per-vu-iterations', vus: 1, iterations: 1, startTime: `${ROUND_START}s`, maxDuration: `${ROUND + 30}s`, exec: 'facilitate' },
    deadline: { executor: 'constant-arrival-rate', rate: TEAMS, timeUnit: `${WINDOW}s`, duration: `${WINDOW}s`, startTime: `${ROUND_START + ROUND - WINDOW}s`, preAllocatedVUs: TEAMS, maxVUs: TEAMS * 2, exec: 'submit' },
  },
  thresholds: {
    'http_req_duration{op:decision}': ['p(95)<1000'],
    'http_req_duration{op:join}': ['p(95)<1000'],
    http_req_failed: ['rate<0.01'],
  },
};

const auth = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
const uuid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
  const r = (Math.random() * 16) | 0;
  return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
});

export function arrive() {
  const i = exec.scenario.iterationInTest % data.tokens.length;
  const token = data.tokens[i];
  const j = http.post(`${APP}/api/join`, JSON.stringify({ session_id: data.session, team: i % TEAMS, role: 'participant' }), { headers: auth(token), tags: { op: 'join' } });
  check(j, { joined: (r) => r.status === 200 && r.json('status') === 'joined' });
  http.get(`${APP}/api/state?session=${data.session}`, { headers: auth(token), tags: { op: 'state' } });
}

export function facilitate() {
  http.post(`${APP}/api/round/open`, JSON.stringify({ round: 1, seconds: ROUND }), { headers: auth(data.facilitator_token), tags: { op: 'open' } });
  sleep(ROUND + 0.3);
  const c = http.post(`${APP}/api/round/close`, JSON.stringify({ round: 1 }), { headers: auth(data.facilitator_token), tags: { op: 'close' } });
  check(c, { closed: (r) => r.status === 200 && r.json('status') === 'closed' });
}

export function submit() {
  const team = exec.scenario.iterationInTest % TEAMS;
  const token = data.tokens[team];
  const r = http.post(`${APP}/api/decision`, JSON.stringify({ submission_id: uuid(), round: 1, payload: { speed: 50 + team, risk: 10 } }), { headers: auth(token), tags: { op: 'decision' } });
  check(r, { stored: (x) => x.status === 200 && ['stored', 'duplicate'].includes(x.json('status')) });
}

export function handleSummary(d) {
  const pick = (name) => d.metrics[name]?.values ?? null;
  const out = {
    measured_at: new Date().toISOString(), devices: DEVICES, teams: TEAMS, arrival_s: ARRIVAL, deadline_window_s: WINDOW,
    join: pick('http_req_duration{op:join}'), decision: pick('http_req_duration{op:decision}'),
    http_req_failed: pick('http_req_failed'), checks: pick('checks'), iterations: pick('iterations'),
    dropped_iterations: pick('dropped_iterations'),
  };
  const file = __ENV.K6_OUT || `../results/k6/conference-http-${DEVICES}.json`;
  return { [file]: JSON.stringify(out, null, 2) + '\n', stdout: `k6 ${DEVICES} devices: join p95 ${out.join?.['p(95)']?.toFixed(1)} ms, decision p95 ${out.decision?.['p(95)']?.toFixed(1)} ms, failed ${(out.http_req_failed?.rate * 100).toFixed(2)} %\n` };
}
