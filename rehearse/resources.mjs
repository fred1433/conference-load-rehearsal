// Host and generator evidence, sampled during every run. The load generator and
// the stack share one machine, so no slowdown is attributed to Supabase without these.
import os from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { execFile } from 'node:child_process';

const run = (cmd, args) => new Promise((res) => execFile(cmd, args, { timeout: 8000 }, (e, out) => res(e ? '' : out)));
const mib = (s) => {
  const m = String(s).match(/([\d.]+)\s*([KMG]i?B)/);
  if (!m) return null;
  const f = { KiB: 1 / 1024, KB: 1 / 1024, MiB: 1, MB: 1, GiB: 1024, GB: 1024 }[m[2]] ?? 1;
  return Math.round(Number(m[1]) * f);
};

export function startSampler(clock, { nextPid, sql } = {}) {
  const samples = [];
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  let lastCpu = process.cpuUsage();
  let lastT = performance.now();
  const gen = setInterval(() => {
    const cpu = process.cpuUsage(lastCpu);
    const now = performance.now();
    const pctCpu = ((cpu.user + cpu.system) / 1000 / (now - lastT)) * 100;
    lastCpu = process.cpuUsage(); lastT = now;
    samples.push({ t: clock.now(), kind: 'generator', cpu_pct: Math.round(pctCpu), rss_mb: Math.round(process.memoryUsage().rss / 1048576),
      loop_p99_ms: Math.round(loop.percentile(99) / 1e6), loop_max_ms: Math.round(loop.max / 1e6),
      load1: os.loadavg()[0], free_mb: Math.round(os.freemem() / 1048576) });
    loop.reset();
  }, 2000);
  let busy = false;
  const ext = setInterval(async () => {
    if (busy) return;
    busy = true;
    const t = clock.now();
    const out = await run('docker', ['stats', '--no-stream', '--format', '{{.Name}};{{.CPUPerc}};{{.MemUsage}}']);
    for (const line of out.trim().split('\n')) {
      const [name, cpu, mem] = line.split(';');
      if (!name?.startsWith('supabase_')) continue;
      samples.push({ t, kind: 'container', name: name.replace('_rehearsal', '').replace('supabase_', ''), cpu_pct: parseFloat(cpu), mem_mb: mib(mem) });
    }
    if (nextPid) {
      const ps = (await run('ps', ['-o', '%cpu=,rss=', '-p', String(nextPid)])).trim().split(/\s+/);
      if (ps.length === 2) samples.push({ t, kind: 'next', cpu_pct: parseFloat(ps[0]), rss_mb: Math.round(Number(ps[1]) / 1024) });
    }
    busy = false;
  }, 5000);
  // Database sessions by client and state (one extra connection, this sampler's own).
  let dbBusy = false;
  const dbTimer = sql ? setInterval(async () => {
    if (dbBusy) return;
    dbBusy = true;
    try {
      const t = clock.now();
      const rows = await sql`select coalesce(nullif(application_name, ''), usename, 'other') as app, state, wait_event_type as wait, count(*)::int as n
        from pg_stat_activity where backend_type = 'client backend' and pid <> pg_backend_pid() group by 1, 2, 3`;
      const [{ max }] = await sql`select setting::int as max from pg_settings where name = 'max_connections'`;
      samples.push({ t, kind: 'db', max_connections: max, total: rows.reduce((a, r) => a + r.n, 0),
        active: rows.filter((r) => r.state === 'active').reduce((a, r) => a + r.n, 0),
        waiting_lock: rows.filter((r) => r.wait === 'Lock').reduce((a, r) => a + r.n, 0),
        by_app: Object.fromEntries(Object.entries(rows.reduce((m, r) => { m[r.app] = (m[r.app] || 0) + r.n; return m; }, {}))) });
    } catch { /* sampler must never break the run */ }
    dbBusy = false;
  }, 2000) : null;
  return { samples, stop() { clearInterval(gen); clearInterval(ext); if (dbTimer) clearInterval(dbTimer); loop.disable(); } };
}

export function machine() {
  return { platform: `${os.type()} ${os.release()} ${os.arch()}`, cpus: os.cpus().length, cpu_model: os.cpus()[0]?.model, mem_gb: Math.round(os.totalmem() / 2 ** 30), node: process.version };
}
