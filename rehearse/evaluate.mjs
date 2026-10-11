// Turns a run's raw records into the four session outcomes. The denominator is
// always the number of intended clients or decisions, never only the successes.
import { pct, ms } from './common.mjs';

const stats = (arr) => ({ p50_ms: ms(pct(arr, 0.5)), p95_ms: ms(pct(arr, 0.95)), max_ms: ms(pct(arr, 1)) });

// A round whose close was refused or failed published nothing new: no screen
// can be "current" on it, even if every screen still shows the previous result
// (receipts at or above a stale final_version would otherwise count as delivered).
export function closeFailedCountsAsMissing(r) {
  if (r.close_ok) return r;
  return { ...r, current_within_5s: 0, missing_at_5s: r.intended_recipients, delivery: { p50_ms: 'never', p95_ms: 'never', max_ms: 'never' }, via: {} };
}

export function evaluate({ cfg, devices, opens, closes, cut, refreshAt, clock, db, browsers, samples, endAt }) {
  const participants = devices.filter((d) => d.role === 'participant');
  const subscribers = devices.filter((d) => d.subscriber);

  // Joined
  const readyLat = devices.map((d) => (d.ready ? d.readyAt - d.plannedArrival : Infinity));
  const statusIssues = {};
  for (const d of devices) for (const s of d.statusLog) if (s.status !== 'SUBSCRIBED') {
    const k = `${s.status}${s.err ? ': ' + s.err.slice(0, 80) : ''}`;
    statusIssues[k] = (statusIssues[k] || 0) + 1;
  }
  const joinErrors = {};
  for (const d of devices) for (const e of d.errors) {
    const k = `${e.op} ${e.status || ''} ${e.error || ''}`.trim();
    joinErrors[k] = (joinErrors[k] || 0) + 1;
  }
  const joined = {
    intended: devices.length,
    ready: devices.filter((d) => d.ready).length,
    not_ready: devices.filter((d) => !d.ready).length,
    joined_over_http: devices.filter((d) => d.joined).length,
    participants_ready: participants.filter((d) => d.ready).length,
    time_to_ready: stats(readyLat),
    retries: devices.reduce((n, d) => n + Math.max(0, d.authAttempts - 1) + Math.max(0, d.joinAttempts - 1), 0),
    errors: joinErrors,
    channel_status_events: statusIssues,
  };

  // Submitted
  const subs = devices.flatMap((d) => d.submissions);
  const acked = subs.filter((s) => s.status === 'stored' || s.status === 'duplicate');
  const dbIds = new Set(db.decisions.map((r) => r.id));
  const rejected = {};
  for (const s of subs) if (s.status === 'rejected') rejected[s.reason] = (rejected[s.reason] || 0) + 1;
  const subLat = subs.map((s) => (s.ackAt != null ? s.ackAt - s.plannedAt : Infinity));
  const submitted = {
    intended: subs.length,
    stored: subs.filter((s) => s.status === 'stored').length,
    duplicate_acks: subs.filter((s) => s.status === 'duplicate').length,
    lost_responses_simulated: subs.filter((s) => s.lostResponse).length,
    rejected,
    unacknowledged: subs.filter((s) => s.status == null).length,
    writers_not_joined: subs.filter((s) => s.reason === 'not_joined').length,
    lost_acknowledged: acked.filter((s) => !dbIds.has(s.submission_id)).length,
    acked_within_1s: subs.filter((s) => s.ackAt != null && s.ackAt - s.plannedAt < 1000 && s.status !== 'rejected').length,
    db_rows: db.decisions.length,
    latency_from_planned: stats(subLat),
  };

  // Round complete
  const cutRound = cut ? cut.round : null;
  const rounds = closes.map((c) => {
    const v = c.final_version;
    const lat = subscribers.map((d) => {
      const r = d.receipts.find((x) => x.version >= v);
      return r && v != null ? Math.max(0, r.t - c.start) : Infinity;
    });
    const via = {};
    for (const d of subscribers) { const r = d.receipts.find((x) => x.version >= v); if (r) via[r.via] = (via[r.via] || 0) + 1; }
    return closeFailedCountsAsMissing({
      round: c.round, close_ok: c.ok, close_ms: ms(c.end - c.start), close_status: c.status, final_version: v, scored: c.scored ?? null,
      intended_recipients: subscribers.length,
      current_within_5s: lat.filter((x) => x <= 5000).length,
      missing_at_5s: lat.filter((x) => x > 5000).length,
      delivery: stats(lat), via, cut: c.round === cutRound,
    });
  });
  const score_check_ok = db.expected.every((e) => {
    const s = db.scores.find((x) => x.team === e.team);
    return s && s.total === e.total && s.rounds_scored === e.n;
  }) && db.scores.length === db.expected.length;

  // Recovered
  let recovery = null;
  if (cut) {
    const affected = subscribers.filter((d) => d.path === 'venue');
    const v = closes.find((c) => c.round === cut.round)?.final_version;
    const from = cut.restoreAt ?? cut.at;
    const lat = affected.map((d) => {
      const r = d.receipts.find((x) => x.version >= v);
      return r ? Math.max(0, r.t - from) : Infinity;
    });
    const rejoinLat = affected.map((d) => {
      const s = d.statusLog.find((x) => x.ch === 0 && x.status === 'SUBSCRIBED' && x.t > cut.at);
      return s ? Math.max(0, s.t - from) : Infinity;
    });
    recovery = {
      kind: cut.kind, cut_seconds: cut.kind === 'blackhole' ? cfg.cutSeconds : 0, affected: affected.length,
      current_within_30s: lat.filter((x) => x <= 30000).length,
      missing_at_30s: lat.filter((x) => x > 30000).length,
      never_current: lat.filter((x) => !Number.isFinite(x)).length,
      time_to_current: stats(lat),
      rejoined: rejoinLat.filter(Number.isFinite).length,
      time_to_rejoin: stats(rejoinLat),
      recovered_via: affected.reduce((m, d) => { const r = d.receipts.find((x) => x.version >= v); if (r) m[r.via] = (m[r.via] || 0) + 1; return m; }, {}),
      link: cut.link,
    };
  }

  let refresh = null;
  if (refreshAt != null) {
    const rs = participants.map((d) => d.refreshResult).filter(Boolean);
    const errs = {};
    for (const r of rs) if (!r.ok) { const k = `${r.status} ${r.error ?? ''}`.trim(); errs[k] = (errs[k] || 0) + 1; }
    refresh = { attempted: rs.length, ok: rs.filter((r) => r.ok).length, realtime_token_updated: rs.filter((r) => r.realtimeOk).length,
      latency: stats(rs.map((r) => (r.ok ? r.ms : Infinity))), errors: errs };
  }

  // Generator and host evidence
  const gen = samples.filter((s) => s.kind === 'generator');
  const late = clock.lateness.map((x) => x.late);
  const containers = {};
  for (const s of samples.filter((x) => x.kind === 'container')) {
    const c = (containers[s.name] ||= { cpu_max_pct: 0, mem_max_mb: 0 });
    c.cpu_max_pct = Math.max(c.cpu_max_pct, s.cpu_pct || 0);
    c.mem_max_mb = Math.max(c.mem_max_mb, s.mem_mb || 0);
  }
  const next = samples.filter((x) => x.kind === 'next');
  const generator = {
    cpu_avg_pct: gen.length ? Math.round(gen.reduce((a, s) => a + s.cpu_pct, 0) / gen.length) : null,
    cpu_max_pct: Math.max(0, ...gen.map((s) => s.cpu_pct)),
    rss_max_mb: Math.max(0, ...gen.map((s) => s.rss_mb)),
    event_loop_p99_max_ms: Math.max(0, ...gen.map((s) => s.loop_p99_ms)),
    schedule_lateness_p99_ms: ms(pct(late, 0.99)),
    schedule_lateness_max_ms: ms(pct(late, 1)),
    host_load1_max: Math.max(0, ...gen.map((s) => s.load1)),
  };
  const dbs = samples.filter((x) => x.kind === 'db');
  const dbApps = {};
  for (const s of dbs) for (const [k, v] of Object.entries(s.by_app)) dbApps[k] = Math.max(dbApps[k] || 0, v);
  const host = { containers, next_cpu_max_pct: next.length ? Math.max(...next.map((s) => s.cpu_pct)) : null,
    db_sessions: dbs.length ? { max_connections: dbs[0].max_connections, total_max: Math.max(...dbs.map((s) => s.total)),
      active_max: Math.max(...dbs.map((s) => s.active)), waiting_on_lock_max: Math.max(...dbs.map((s) => s.waiting_lock)), by_client_max: dbApps } : null,
    next_rss_max_mb: next.length ? Math.max(...next.map((s) => s.rss_mb)) : null };

  // Browsers
  let browserOut = null;
  if (browsers) {
    browserOut = browsers.map((b) => ({ role: b.role, path: b.path,
      rounds: closes.map((c) => { const r = b.receipts.find((x) => x.version >= c.final_version); return { round: c.round, ms: r ? ms(r.t - c.start) : 'never' }; }),
      status_changes: b.status.length }));
  }

  const normalRounds = rounds.filter((r) => !r.cut);
  const targets = {
    zero_lost_acknowledged_decisions: submitted.lost_acknowledged === 0 && score_check_ok,
    submit_p95_under_1s: typeof submitted.latency_from_planned.p95_ms === 'number' && submitted.latency_from_planned.p95_ms < 1000,
    all_screens_final_within_5s: normalRounds.length > 0 && normalRounds.every((r) => r.close_ok && r.missing_at_5s === 0),
    all_clients_recovered_within_30s: recovery ? recovery.missing_at_30s === 0 : null,
  };

  // Timeline, one point per second: ready clients, clients holding the latest published result.
  const step = endAt > 600000 ? 5000 : 1000;
  const timeline = { step_ms: step, t: [], ready: [], current: [], markers: [] };
  for (let t = 0; t <= endAt; t += step) {
    const latest = Math.max(0, ...closes.filter((c) => c.end != null && c.end <= t && c.final_version != null).map((c) => c.final_version));
    timeline.t.push(t);
    timeline.ready.push(devices.filter((d) => d.ready && d.readyAt <= t).length);
    timeline.current.push(subscribers.filter((d) => {
      let v = 0;
      for (const r of d.receipts) { if (r.t <= t) v = r.version; else break; }
      return d.ready && d.readyAt <= t && v >= latest;
    }).length);
  }
  for (const o of opens) timeline.markers.push({ t: o.at, kind: 'open', round: o.round });
  for (const c of closes) timeline.markers.push({ t: c.start, kind: 'close', round: c.round });
  if (cut) {
    timeline.markers.push({ t: cut.at, kind: cut.kind === 'blackhole' ? 'cut' : 'reset' });
    if (cut.restoreAt) timeline.markers.push({ t: cut.restoreAt, kind: 'restore' });
  }
  if (refreshAt != null) timeline.markers.push({ t: refreshAt, kind: 'refresh' });

  const opened = opens.map((o) => ({ round: o.round, ok: o.ok, attempts: o.attempts, error: o.error }));
  return { joined, submitted, opens: opened, rounds, score_check_ok, recovery, refresh, browsers: browserOut, targets, generator, host, timeline };
}
