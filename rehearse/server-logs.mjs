// Server-side evidence for a run window, from the local containers (stdout and stderr).
//   node rehearse/server-logs.mjs     recomputes server-log.txt and server_log_counts for every recorded run
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './common.mjs';

const PATTERN = /error|limit|reached|too_many|refused|timeout|fatal|panic|worker_connections| 5\d\d /i;
const CLASS = /(TooMany\w+|too_many_\w+|\w+RateLimitReached|tenant_events|ChannelRateLimitReached|IncreaseConnectionPool|DatabaseConnectionIssue|UnableToConnect\w*|ErrorOnRpcCall|RealtimeDisabledForTenant|\b5\d\d\b|error)/i;

export function collectServerLogs(sinceIso, untilIso) {
  const counts = {};
  let text = '';
  for (const c of ['realtime', 'auth', 'rest', 'kong', 'db']) {
    const args = ['logs', '--since', sinceIso, ...(untilIso ? ['--until', untilIso] : []), `supabase_${c}_rehearsal`];
    const r = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
    const lines = `${r.stdout || ''}\n${r.stderr || ''}`.split('\n').filter((l) => PATTERN.test(l));
    const k = {};
    for (const l of lines) {
      let key;
      if (/worker_connections are not enough/.test(l)) key = 'gateway_worker_connections_exhausted';
      else if (/DNS resolution failed/.test(l)) key = 'gateway_dns_resolution_failed';
      else key = (l.match(/error_code=(\w+)/) || l.match(CLASS) || [null, 'other'])[1];
      k[key] = (k[key] || 0) + 1;
    }
    counts[c] = k;
    if (lines.length) text += `## ${c} (${lines.length} matching lines, first 150)\n${lines.slice(0, 150).join('\n')}\n\n`;
  }
  return { counts, text: text || 'no matching lines\n' };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const runsDir = path.join(ROOT, 'results', 'runs');
  for (const d of fs.readdirSync(runsDir).sort()) {
    const f = path.join(runsDir, d, 'summary.json');
    if (!fs.existsSync(f)) continue;
    const s = JSON.parse(fs.readFileSync(f, 'utf8'));
    const until = new Date(Date.parse(s.run.started_at) + (s.run.duration_s + 30) * 1000).toISOString();
    const { counts, text } = collectServerLogs(s.run.started_at, until);
    s.server_log_counts = counts;
    fs.writeFileSync(f, JSON.stringify(s, null, 2) + '\n');
    fs.writeFileSync(path.join(runsDir, d, 'server-log.txt'), text);
    console.log(d, JSON.stringify(counts.kong), JSON.stringify(counts.realtime));
  }
}
