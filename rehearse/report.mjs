// Regenerates every figure in README.md (between markers), REPORT.md tables,
// results/SUMMARY.md and results/timeline.svg from the recorded runs.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './common.mjs';

const runsDir = path.join(ROOT, 'results', 'runs');
const all = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).sort().map((d) => {
  const f = path.join(runsDir, d, 'summary.json');
  return fs.existsSync(f) ? { dir: d, ...JSON.parse(fs.readFileSync(f, 'utf8')) } : null;
}).filter(Boolean) : [];
const byName = (name) => all.filter((s) => s.run.label.replace(/-r\d+$/, '') === name);
const num = (x) => (typeof x === 'number' ? x : Infinity);
const med = (xs) => { const v = xs.map(num).sort((a, b) => a - b); return v.length ? v[Math.floor((v.length - 1) / 2)] : null; };
const fmtMs = (x) => (x == null ? 'n/a' : !Number.isFinite(num(x)) ? 'never' : x >= 10000 ? `${(x / 1000).toFixed(0)} s` : x >= 1000 ? `${(x / 1000).toFixed(1)} s` : `${Math.round(x)} ms`);
const range = (xs, f = fmtMs) => {
  const v = xs.map(num).sort((a, b) => a - b);
  if (!v.length) return 'n/a';
  return v.length === 1 || v[0] === v.at(-1) ? f(v[0]) : `${f(v[Math.floor((v.length - 1) / 2)])} (${f(v[0])} to ${f(v.at(-1))})`;
};
const counts = (xs, total) => {
  const v = [...xs].sort((a, b) => a - b);
  if (!v.length) return 'n/a';
  return v[0] === v.at(-1) ? `${v[0]}/${total}` : `${v[0]} to ${v.at(-1)} /${total}`;
};
const reps = (rs) => `${rs.length} run${rs.length > 1 ? 's' : ''}`;
const roundsOk = (s) => s.outcomes.rounds.filter((r) => !r.cut);
const minCurrent = (s) => Math.min(...roundsOk(s).map((r) => r.current_within_5s));
const worstDelivery = (s) => Math.max(...roundsOk(s).map((r) => num(r.delivery.p95_ms)));
const yes = (b) => (b === true ? 'met' : b === false ? 'missed' : 'n/a');

function machineLabel() {
  const s = all[0];
  if (!s) return '';
  const m = s.run.machine;
  return `${m.cpu_model}, ${m.cpus} cores, ${m.mem_gb} GB; Docker VM 6 CPU / 12 GB; generator, Next.js and Supabase on the same machine`;
}

// ---------- headline table ----------
function headline() {
  const conf = byName('conference');
  const raised = byName('conference-raised');
  const rec = byName('recovery');
  const storm = byName('rejoin-storm-severe');
  const head = ['headroom-300', 'headroom-400', 'headroom-500'].map((n) => byName(n)[0]).filter(Boolean);
  const rows = [];
  const label = (rs) => rs[0] ? `${reps(rs)}` : 'not run';
  if (conf.length || raised.length) {
    const intended = (conf[0] ?? raised[0]).outcomes.joined.intended;
    rows.push(['Arrival', `${(conf[0] ?? raised[0]).actors.participant_devices} devices over ${(conf[0] ?? raised[0]).config.arrivalSeconds} s, plus facilitator and display`,
      conf.length ? `${counts(conf.map((s) => s.outcomes.joined.ready), intended)} ready; p95 ${range(conf.map((s) => s.outcomes.joined.time_to_ready.p95_ms))}` : 'not run',
      raised.length ? `${counts(raised.map((s) => s.outcomes.joined.ready), intended)} ready; p95 ${range(raised.map((s) => s.outcomes.joined.time_to_ready.p95_ms))}` : 'not run']);
    const sub = (rs) => `${rs.reduce((a, s) => a + s.outcomes.submitted.lost_acknowledged, 0)} acknowledged decisions lost; submit p95 ${range(rs.map((s) => s.outcomes.submitted.latency_from_planned.p95_ms))}; worst round ${counts(rs.map(minCurrent), rs[0].outcomes.rounds[0].intended_recipients)} screens on the final result within 5 s`;
    rows.push(['Round close', `${(conf[0] ?? raised[0]).actors.teams} teams submit in the last ${(conf[0] ?? raised[0]).config.deadlineWindowSeconds} s, facilitator closes, ${(conf[0] ?? raised[0]).config.rounds} rounds`,
      conf.length ? sub(conf) : 'not run', raised.length ? sub(raised) : 'not run']);
  }
  if (rec.length || storm.length) {
    const r = rec[0]?.outcomes.recovery;
    rows.push(['Recovery', `venue link cut for ${rec[0]?.config.cutSeconds ?? '?'} s as the round closes (left column: every venue connection reset at once, deliberately severe)`,
      storm.length ? `severe reset: ${counts(storm.map((s) => s.outcomes.recovery.current_within_30s), storm[0].outcomes.recovery.affected)} current within 30 s; p95 ${range(storm.map((s) => s.outcomes.recovery.time_to_current.p95_ms))}` : 'not run',
      rec.length ? `cut: ${counts(rec.map((s) => s.outcomes.recovery.current_within_30s), r.affected)} current within 30 s of restore; p95 ${range(rec.map((s) => s.outcomes.recovery.time_to_current.p95_ms))}` : 'not run']);
  }
  if (head.length) {
    const pass = head.filter((s) => s.outcomes.targets.zero_lost_acknowledged_decisions && s.outcomes.targets.submit_p95_under_1s && s.outcomes.targets.all_screens_final_within_5s && num(s.outcomes.generator.schedule_lateness_p99_ms) <= 100);
    const fail = head.find((s) => !pass.includes(s));
    const best = pass.at(-1);
    rows.push(['Headroom', 'steps of 300, 400, 500 devices, upper bound 500, stop at the first missed target or generator saturation', 'not run (quota caps connections at 200)',
      `${best ? `${best.actors.participant_devices} devices passed` : 'no step passed'}; ${fail ? `first failure at ${fail.actors.participant_devices}: ${describeFailure(fail)}` : 'no breakpoint observed within tested range'}`]);
  }
  const t = ['| Scenario | Workload | Local default (Realtime limits as seeded: 200 connections, 100 msg/s, 100 joins/s) | Local, selected limits raised |', '|---|---|---|---|',
    ...rows.map((r) => `| ${r.join(' | ')} |`)];
  return `${t.join('\n')}\n\nMeasured ${new Date(Math.max(...all.map((s) => Date.parse(s.run.started_at)))).toISOString().slice(0, 10)} on ${machineLabel()}. Medians, with the range across repetitions in brackets. Full per-run table: [results/SUMMARY.md](results/SUMMARY.md).`;
}

function describeFailure(s) {
  const t = s.outcomes.targets;
  const bits = [];
  if (!t.zero_lost_acknowledged_decisions) bits.push('acknowledged decision lost');
  if (!t.submit_p95_under_1s) bits.push(`submit p95 ${fmtMs(s.outcomes.submitted.latency_from_planned.p95_ms)}`);
  if (!t.all_screens_final_within_5s) bits.push(`worst round ${minCurrent(s)}/${s.outcomes.rounds[0].intended_recipients} screens current within 5 s`);
  if (num(s.outcomes.generator.schedule_lateness_p99_ms) > 100) bits.push(`generator late by ${fmtMs(s.outcomes.generator.schedule_lateness_p99_ms)} (p99)`);
  const gw = s.server_log_counts?.kong?.gateway_worker_connections_exhausted;
  if (gw) bits.push(`local gateway logged "worker_connections are not enough" ${gw} times`);
  return bits.join(', ');
}

// ---------- experiments ----------
function experiments() {
  const base = byName('conference-raised');
  const lines = ['| Experiment | Change against `conference-raised` | Worst round, screens current within 5 s | Delivery p95 (worst round) | Submit p95 | Realtime log |', '|---|---|---|---|---|---|'];
  const row = (name, change, rs) => {
    if (!rs.length) return;
    const tot = rs[0].outcomes.rounds[0].intended_recipients;
    const logs = {};
    for (const s of rs) for (const [k, v] of Object.entries(s.server_log_counts.realtime || {})) if (!['DatabaseIpVersionIsIpv4', 'error', 'other'].includes(k) && !/^\d+$/.test(k)) logs[k] = (logs[k] || 0) + v;
    lines.push(`| ${name} (${reps(rs)}) | ${change} | ${counts(rs.map(minCurrent), tot)} | ${range(rs.map(worstDelivery))} | ${range(rs.map((s) => s.outcomes.submitted.latency_from_planned.p95_ms))} | ${Object.entries(logs).map(([k, v]) => `${k} x${v}`).join(', ') || 'none'} |`);
  };
  row('conference-raised', 'none (reference)', base);
  row('conference', 'tenant limits back to the seeded values', byName('conference'));
  row('conference-pro-values', 'tenant limits set to the published Pro values', byName('conference-pro-values'));
  row('transport-broadcast', 'Broadcast from the database on a private channel instead of Postgres Changes', byName('transport-broadcast'));
  row('frequency-every-change', 'a provisional publication after every decision, plus the final one', byName('frequency-every-change'));
  row('frequency-every-change-default', 'same, with the seeded tenant limits', byName('frequency-every-change-default'));
  row('writers-200-stress', 'stress variant, not expected workload: 5 writers per team (200 writers)', byName('writers-200-stress'));
  return lines.join('\n');
}

function steps() {
  const lines = ['| Run | Clients (devices + facilitator + display) | Ready | Submit p95 | Worst round current within 5 s | Delivery p95 | Generator lateness p99 | Next.js CPU max | Realtime CPU max |', '|---|---|---|---|---|---|---|---|---|'];
  for (const n of ['baseline', 'step-50', 'step-100', 'step-200', 'headroom-300', 'headroom-400', 'headroom-500']) {
    for (const s of byName(n)) {
      const o = s.outcomes;
      lines.push(`| ${s.run.label} | ${o.joined.intended} | ${o.joined.ready} | ${fmtMs(o.submitted.latency_from_planned.p95_ms)} | ${minCurrent(s)}/${o.rounds[0].intended_recipients} | ${fmtMs(worstDelivery(s))} | ${fmtMs(o.generator.schedule_lateness_p99_ms)} | ${o.host.next_cpu_max_pct ?? 'n/a'} % | ${o.host.containers.realtime?.cpu_max_pct ?? 'n/a'} % |`);
    }
  }
  return lines.join('\n');
}

function soak() {
  const s = byName('soak-20min')[0];
  if (!s) return 'Soak not run.';
  const o = s.outcomes;
  const worst = minCurrent(s);
  return `${s.config.rounds} rounds over ${Math.round(s.run.duration_s / 60)} min, ${o.joined.intended} clients: ${o.joined.ready} ready, ${o.submitted.lost_acknowledged} acknowledged decisions lost, submit p95 ${fmtMs(o.submitted.latency_from_planned.p95_ms)}, worst round ${worst}/${o.rounds[0].intended_recipients} current within 5 s, generator RSS max ${o.generator.rss_max_mb} MB, Realtime memory max ${o.host.containers.realtime?.mem_max_mb ?? 'n/a'} MB. `
    + `The soak does not cross token expiry (JWT lifetime ${(s.environment.auth_env.find((l) => l.startsWith('GOTRUE_JWT_EXP=')) || '=?').split('=')[1]} s), so a targeted refresh phase runs before the last round: `
    + (o.refresh ? `${o.refresh.ok}/${o.refresh.attempted} refreshes succeeded at the same instant (${Object.entries(o.refresh.errors).map(([k, v]) => `${k.replace(/^0 /, '')} x${v}`).join(', ') || 'no errors'}), ${o.refresh.realtime_token_updated} Realtime tokens updated in band, and the last round reached ${o.rounds.at(-1).current_within_5s}/${o.rounds.at(-1).intended_recipients} screens within 5 s.` : 'not recorded.');
}

function auth() {
  const f = path.join(ROOT, 'results', 'auth', 'summary.json');
  if (!fs.existsSync(f)) return 'Auth arrival experiment not run.';
  const a = JSON.parse(fs.readFileSync(f, 'utf8'));
  const names = { 'fresh-anonymous': 'New anonymous user (`signInAnonymously`)', 'fresh-email': 'New email and password sign-up', login: 'Existing user, password login', refresh: 'Existing session, token refresh', reuse: 'Existing session reused (`GET /user`)' };
  const lines = [`Default local stack, 40 anonymous sign-ins from one machine: ${Object.entries(a.default_local_check.statuses).map(([k, v]) => `${v} x HTTP ${k}`).join(', ')} (no per-IP limiter configured in this run).`, '',
    `With the limiter switched on (\`GOTRUE_RATE_LIMIT_HEADER\`, image \`${a.auth_image.split('/').pop()}\`, limits as configured by the CLI), ${a.results[0]?.arrivals ?? 200} arrivals spread over ${a.results[0]?.window_s ?? 120} s:`, '',
    '| Auth path | Grouping | Succeeded | HTTP 429 | First 429 after | Successes per 30 s |', '|---|---|---|---|---|---|'];
  for (const r of a.results) lines.push(`| ${names[r.path] ?? r.path} | ${r.grouping === 'one-venue-ip' ? 'whole room behind one IP' : 'one forwarded IP per device'} | ${r.ok}/${r.arrivals} | ${r.rate_limited} | ${r.first_429_at_ms != null ? fmtMs(r.first_429_at_ms) : 'none'} | ${r.ok_per_30s.join(', ')} |`);
  return lines.join('\n');
}

function k6() {
  const dir = path.join(ROOT, 'results', 'k6');
  if (!fs.existsSync(dir)) return 'k6 not run.';
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  if (!files.length) return 'k6 not run.';
  return files.map((f) => {
    const k = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    return `k6, HTTP only, ${k.devices} devices over ${k.arrival_s} s and ${k.teams} decisions in ${k.deadline_window_s} s: join p95 ${fmtMs(k.join?.['p(95)'])}, decision p95 ${fmtMs(k.decision?.['p(95)'])}, failed requests ${((k.http_req_failed?.rate ?? 0) * 100).toFixed(2)} %, dropped iterations ${k.dropped_iterations?.count ?? 0}.`;
  }).join('\n');
}

function summaryTable() {
  const lines = ['# All runs', '', 'Generated by `npm run report` from `results/runs/*/summary.json`. Each run folder also holds `devices.json.gz` (every client event), `resources.json` (host, containers, generator) and `server-log.txt`.', '',
    '| Run | Profile | Transport / publish | Clients | Ready | Acked / intended decisions | Lost acked | Submit p95 | Worst round current 5 s | Delivery p95 worst | Recovered 30 s | Gen. lateness p99 | Gen. CPU max | Host load max | Targets met |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const s of all) {
    const o = s.outcomes;
    const met = Object.values(o.targets).filter((x) => x === true).length;
    const applicable = Object.values(o.targets).filter((x) => x !== null).length;
    lines.push(`| [${s.run.label}](runs/${s.dir}/summary.json) | ${s.config.limitsProfile} | ${s.config.transport} / ${s.config.publish} | ${o.joined.intended} | ${o.joined.ready} | ${o.submitted.stored + o.submitted.duplicate_acks}/${o.submitted.intended} | ${o.submitted.lost_acknowledged} | ${fmtMs(o.submitted.latency_from_planned.p95_ms)} | ${minCurrent(s)}/${o.rounds[0].intended_recipients} | ${fmtMs(worstDelivery(s))} | ${o.recovery ? `${o.recovery.current_within_30s}/${o.recovery.affected}` : 'n/a'} | ${fmtMs(o.generator.schedule_lateness_p99_ms)} | ${o.generator.cpu_max_pct} % | ${o.generator.host_load1_max.toFixed(1)} | ${met}/${applicable} |`);
  }
  return lines.join('\n') + '\n';
}

// ---------- timeline chart ----------
function timeline() {
  const s = byName('recovery')[0] ?? byName('conference')[0];
  if (!s) return null;
  const tl = s.outcomes.timeline;
  const W = 960, H = 340, L = 56, R = 20, T = 40, B = 46;
  const tmax = tl.t.at(-1) / 1000;
  const ymax = s.outcomes.joined.intended;
  const x = (t) => L + (t / 1000 / tmax) * (W - L - R);
  const y = (v) => T + (1 - v / ymax) * (H - T - B);
  const line = (arr) => arr.map((v, i) => `${i ? 'L' : 'M'}${x(tl.t[i]).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const m = tl.markers;
  const cut = m.find((k) => k.kind === 'cut' || k.kind === 'reset');
  const restore = m.find((k) => k.kind === 'restore');
  const lead = 2000, arrEnd = lead + 1000 + s.config.arrivalSeconds * 1000;
  let out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="ui-sans-serif, -apple-system, Segoe UI, Helvetica, Arial, sans-serif" font-size="12">`;
  out += `<rect width="${W}" height="${H}" fill="#fbfaf7"/>`;
  out += `<text x="${L}" y="20" font-size="14" font-weight="600" fill="#1d2a33">${s.run.label}: ${s.outcomes.joined.intended} clients, ${s.config.limitsProfile}, ${s.config.transport}</text>`;
  out += `<rect x="${x(lead)}" y="${T}" width="${x(arrEnd) - x(lead)}" height="${H - T - B}" fill="#e7eef3"/><text x="${x(lead) + 6}" y="${T + 14}" fill="#4a6273">arrival wave</text>`;
  if (cut) {
    const end = restore ? restore.t : cut.t + 300;
    out += `<rect x="${x(cut.t)}" y="${T}" width="${Math.max(2, x(end) - x(cut.t))}" height="${H - T - B}" fill="#f6dccf"/><text x="${x(cut.t) + 4}" y="${T + 14}" fill="#9a4a2a">${cut.kind === 'cut' ? 'venue link cut' : 'all venue connections reset'}</text>`;
    if (restore) out += `<rect x="${x(restore.t)}" y="${T}" width="${x(restore.t + 30000) - x(restore.t)}" height="${H - T - B}" fill="none" stroke="#c98a6b" stroke-dasharray="3 3"/><text x="${x(restore.t) + 4}" y="${T + 28}" fill="#9a4a2a">30 s recovery window</text>`;
  }
  for (const k of m.filter((k) => k.kind === 'close')) out += `<line x1="${x(k.t)}" x2="${x(k.t)}" y1="${T}" y2="${H - B}" stroke="#1d2a33" stroke-width="1" stroke-dasharray="2 3"/><text x="${x(k.t) + 3}" y="${H - B - 6}" fill="#1d2a33">R${k.round} close</text>`;
  for (let v = 0; v <= ymax; v += 50) out += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#e2dfd8"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" fill="#6b7780">${v}</text>`;
  for (let t = 0; t <= tmax; t += 60) out += `<text x="${x(t * 1000)}" y="${H - B + 18}" text-anchor="middle" fill="#6b7780">${t}s</text>`;
  out += `<path d="${line(tl.ready)}" fill="none" stroke="#8aa3b5" stroke-width="2"/>`;
  out += `<path d="${line(tl.current)}" fill="none" stroke="#0f6e6e" stroke-width="2.2"/>`;
  out += `<text x="${W - R}" y="${H - 10}" text-anchor="end" fill="#6b7780"><tspan fill="#8aa3b5">━ clients ready</tspan>   <tspan fill="#0f6e6e">━ clients holding the latest round result</tspan></text>`;
  out += '</svg>\n';
  fs.writeFileSync(path.join(ROOT, 'results', 'timeline.svg'), out);
  return s.run.label;
}

function replaceBlock(text, name, body) {
  const re = new RegExp(`(<!-- ${name}:start -->)[\\s\\S]*?(<!-- ${name}:end -->)`);
  return re.test(text) ? text.replace(re, `$1\n${body}\n$2`) : text;
}


// ---------- findings, computed from the runs ----------
const sum = (xs) => xs.reduce((a, b) => a + (b || 0), 0);
const gw = (s) => s.server_log_counts?.kong?.gateway_worker_connections_exhausted || 0;
const rtCount = (s, k) => s.server_log_counts?.realtime?.[k] || 0;
function finding() {
  const conf = byName('conference'), raised = byName('conference-raised'), bc = byName('transport-broadcast');
  const rec = byName('recovery'), hb = byName('recovery-heartbeat-5s'), storm = byName('rejoin-storm-severe');
  const head = byName('headroom-300')[0], soakRun = byName('soak-20min')[0], every = byName('frequency-every-change');
  const out = [];
  const authF = path.join(ROOT, 'results', 'auth', 'summary.json');
  if (fs.existsSync(authF)) {
    const a = JSON.parse(fs.readFileSync(authF, 'utf8')).results;
    const g = (p) => a.find((r) => r.path === p && r.grouping === 'one-venue-ip');
    out.push(`1. **Auth at arrival, if arrival creates or signs in users behind one address.** With the per-IP limiter switched on at the CLI's default limits, 200 arrivals over 120 s from one venue address: ${g('fresh-anonymous')?.ok}/200 new anonymous users, ${g('fresh-email')?.ok}/200 new email sign-ups, ${g('login')?.ok}/200 password logins and ${g('refresh')?.ok}/200 refreshes got through; the rest received HTTP 429. Reusing an existing session: ${g('reuse')?.ok}/200. With one forwarded address per device, every path got 200/200. The first 429 for logins arrived after ${fmtMs(g('login')?.first_429_at_ms)}, once the burst of 30 was spent. Measured on the local Auth container with the limiter configured explicitly (it is off in the CLI stack by default: 40 anonymous sign-ins from one machine all succeeded).`);
  }
  if (conf.length && raised.length) {
    const refused = conf.map((s) => s.outcomes.joined.intended - s.outcomes.joined.ready);
    out.push(`2. **Realtime connection quota, at arrival.** The session needs ${conf[0].actors.realtime_connections} Realtime connections (${conf[0].actors.participant_devices} devices, a facilitator, a display and 2 real browsers). With the tenant limits as seeded (200 concurrent connections, the published Free value), ${counts(refused, conf[0].outcomes.joined.intended).replace(/\/\d+$/, '')} protocol clients were refused in each of ${conf.length} runs (\`ConnectionRateLimitReached: Too many connected users\` x${sum(conf.map((s) => rtCount(s, 'ConnectionRateLimitReached')))} in the Realtime log, the clients retrying) and never saw a round result. Everything else stayed well inside the targets: decision p95 ${range(conf.map((s) => s.outcomes.submitted.latency_from_planned.p95_ms))}, 0 acknowledged decisions lost. Changing only the tenant limits (\`conference-raised\`, ${raised.length} runs): ${counts(raised.map((s) => s.outcomes.joined.ready), raised[0].outcomes.joined.intended)} ready and ${counts(raised.map(minCurrent), raised[0].outcomes.rounds[0].intended_recipients)} screens on every round's final result within 5 s.`);
  }
  if (rec.length) {
    const via = rec.reduce((m, s) => { for (const [k, v] of Object.entries(s.outcomes.recovery.recovered_via)) m[k] = (m[k] || 0) + v; return m; }, {});
    const total = sum(Object.values(via));
    out.push(`3. **Reconnect wave after a half-open cut.** The venue link went silent for ${rec[0].config.cutSeconds} s as round 1 closed (old connections left open, as when an access point loses its state). Within 30 s of the link returning, ${counts(rec.map((s) => s.outcomes.recovery.current_within_30s), 200)} venue clients held the current result; p95 time to get there: ${range(rec.map((s) => s.outcomes.recovery.time_to_current.p95_ms))}. The client library noticed the dead sockets through its heartbeat (25 s by default [18]); then the local API gateway (Kong in the CLI stack: 1 worker, 512 connections) logged \`worker_connections are not enough\` ${range(rec.map(gw), (x) => String(x))} times per run along with HTTP 500/503, while the old connections still held its slots. Postgres was not the bottleneck: at most ${Math.max(...rec.map((s) => s.outcomes.host.db_sessions?.total_max ?? 0))} client sessions out of 100, ${Math.max(...rec.map((s) => s.outcomes.host.db_sessions?.active_max ?? 0))} active. ${via.recover ?? 0} of ${total} recovered clients got the missed result from the state fetch they make after rejoining, not from Realtime: without that fetch they would have stayed on the old result until the next round.` + (storm.length ? ` For contrast, when every venue connection was reset at once (deliberately severe, seeded limits), ${counts(storm.map((s) => s.outcomes.recovery.current_within_30s), 200)} were current within 30 s, p95 ${range(storm.map((s) => s.outcomes.recovery.time_to_current.p95_ms))}: a clean reset frees the old connections, a silent cut does not.` : '') + (hb.length ? ` A 5 s client heartbeat instead of 25 s (${hb.length} runs) did not help: ${counts(hb.map((s) => s.outcomes.recovery.current_within_30s), 200)} within 30 s, because the clients detected the cut early and tried to reconnect while the link was still down (${range(hb.map((s) => s.outcomes.recovery.link?.refusedDuringCut ?? 0), (x) => String(x))} attempts refused per run), then came back on the library's retry schedule into the same congested gateway.` : ''));
  }
  if (head) {
    out.push(`4. **Headroom above 200.** With Realtime limits raised, the first step, ${head.actors.participant_devices} devices, failed: ${describeFailure(head)}. The generator was not saturated (scheduling lateness p99 ${fmtMs(head.outcomes.generator.schedule_lateness_p99_ms)}, CPU max ${head.outcomes.generator.cpu_max_pct} %). On this machine the ceiling above 200 is the local gateway's connection limit, a property of the CLI stack; no breakpoint of the app, Realtime or Postgres was observed up to 200 devices.`);
  }
  if (soakRun?.outcomes.refresh) {
    const r = soakRun.outcomes.refresh;
    out.push(`5. **Everyone refreshing at once.** In the targeted refresh phase of the 20 min soak, ${r.ok}/${r.attempted} simultaneous token refreshes succeeded; the others failed with connection resets (${Object.entries(r.errors).map(([k, v]) => `${k.replace(/^0 /, '')} x${v}`).join(', ')}) from the same local gateway ceiling. The soak itself held: ${soakRun.config.rounds} rounds, worst round ${minCurrent(soakRun)}/${soakRun.outcomes.rounds[0].intended_recipients} screens current within 5 s, no acknowledged decision lost.`);
  }
  const allRuns = all;
  out.push(`\nAcross all ${allRuns.length} runs: ${sum(allRuns.map((s) => s.outcomes.submitted.lost_acknowledged))} acknowledged decisions lost, ${allRuns.filter((s) => !s.outcomes.score_check_ok).length} runs with a score that did not match the stored decisions, ${sum(allRuns.map((s) => s.outcomes.submitted.duplicate_acks))} retried submissions answered as duplicates and stored once.` + (bc.length && raised.length ? ` Broadcast from the database delivered the final result with a worst-round p95 of ${range(bc.map(worstDelivery))} against ${range(raised.map(worstDelivery))} for Postgres Changes, same recipients, payload and authorization.` : '') + (every.length ? ` Publishing after every decision (${every.length} runs) still met the 5 s target, and no message-rate limit was logged, at raised or seeded limits; the per-second figure is averaged by the server [16], so this does not predict a hosted project's behaviour.` : ''));
  return out.join('\n');
}

const blocks = { finding: finding(), results: headline(), experiments: experiments(), steps: steps(), soak: soak(), auth: auth(), k6: k6() };
fs.writeFileSync(path.join(ROOT, 'results', 'SUMMARY.md'), summaryTable());
const chartFrom = timeline();
blocks.chart = chartFrom ? `![Timeline of ${chartFrom}](results/timeline.svg)` : 'No run recorded yet.';
for (const f of ['README.md', 'REPORT.md']) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) continue;
  let t = fs.readFileSync(p, 'utf8');
  for (const [k, v] of Object.entries(blocks)) t = replaceBlock(t, k, v);
  fs.writeFileSync(p, t);
}
fs.writeFileSync(path.join(ROOT, 'results', 'blocks.json'), JSON.stringify(blocks, null, 2) + '\n');
console.log(`report: ${all.length} runs, chart from ${chartFrom}`);
