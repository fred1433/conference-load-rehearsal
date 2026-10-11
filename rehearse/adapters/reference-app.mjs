// Adapter for the reference app in this repository. To rehearse another
// platform, write a sibling file exposing the same operations:
//   authenticate, join, submitDecision, openRound, closeRound,
//   observeLeaderboard, recoverState, refresh
// The scenario logic (rehearse/run.mjs, rehearse/device.mjs) only calls these.
import { RealtimeClient } from '@supabase/realtime-js';
import { httpJson } from '../common.mjs';

export function createAdapter(env) {
  const urls = (device) => (device.path === 'venue'
    ? { app: env.venueAppUrl, sb: env.venueSupabaseUrl }
    : { app: env.appUrl, sb: env.supabaseUrl });
  const bearer = (device) => ({ Authorization: `Bearer ${device.token}` });
  const authHeaders = { apikey: env.anonKey };

  return {
    // mode: reuse | login | refresh | fresh
    async authenticate(device, mode) {
      const { sb } = urls(device);
      if (mode === 'reuse') {
        device.token = device.user.access_token;
        device.refreshToken = device.user.refresh_token;
        return { ok: true, status: 0, ms: 0, call: 'none' };
      }
      let r;
      if (mode === 'login') {
        r = await httpJson(`${sb}/auth/v1/token?grant_type=password`, { method: 'POST', headers: authHeaders,
          body: { email: device.user.email, password: device.user.password } });
      } else if (mode === 'refresh') {
        r = await httpJson(`${sb}/auth/v1/token?grant_type=refresh_token`, { method: 'POST', headers: authHeaders,
          body: { refresh_token: device.refreshToken ?? device.user.refresh_token } });
      } else if (mode === 'fresh') {
        r = await httpJson(`${sb}/auth/v1/signup`, { method: 'POST', headers: authHeaders, body: { data: {} } });
      } else throw new Error(`unknown SESSION_MODE ${mode}`);
      if (r.ok && r.data?.access_token) { device.token = r.data.access_token; device.refreshToken = r.data.refresh_token; }
      return { ok: r.ok && !!r.data?.access_token, status: r.status, ms: r.ms, error: r.error ?? r.data?.error_code ?? r.data?.msg, call: mode };
    },

    async refresh(device) { return this.authenticate(device, 'refresh'); },

    join(device) {
      return httpJson(`${urls(device).app}/api/join`, { method: 'POST', headers: bearer(device),
        body: { session_id: env.sessionId, team: device.team, role: device.role } });
    },

    submitDecision(device, decision) {
      return httpJson(`${urls(device).app}/api/decision`, { method: 'POST', headers: bearer(device), body: decision });
    },

    openRound(device, round, seconds) {
      return httpJson(`${urls(device).app}/api/round/open`, { method: 'POST', headers: bearer(device), body: { round, seconds } });
    },

    closeRound(device, round) {
      return httpJson(`${urls(device).app}/api/round/close`, { method: 'POST', headers: bearer(device), body: { round }, timeoutMs: 15000 });
    },

    recoverState(device) {
      return httpJson(`${urls(device).app}/api/state?session=${env.sessionId}`, { headers: bearer(device) });
    },

    // Leaderboard channel plus (CHANNELS_PER_CONN - 1) extra private channels on one socket.
    observeLeaderboard(device, { onResult, onStatus }) {
      const opts = { params: { apikey: env.anonKey } };
      if (env.heartbeatMs) opts.heartbeatIntervalMs = env.heartbeatMs;
      const rt = new RealtimeClient(`${urls(device).sb}/realtime/v1`, opts);
      rt.setAuth(device.token);
      const channels = [];
      const main = env.transport === 'broadcast'
        ? rt.channel(`session:${env.sessionId}`, { config: { private: true } })
            .on('broadcast', { event: 'leaderboard' }, ({ payload }) => onResult(payload))
        : rt.channel(`pc:${env.sessionId}`)
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'results', filter: `session_id=eq.${env.sessionId}` },
              ({ new: row }) => onResult(row));
      channels.push(main);
      for (let k = 1; k < env.channelsPerConn; k++) {
        channels.push(rt.channel(`session:${env.sessionId}:aux${k}`, { config: { private: true } }));
      }
      channels.forEach((ch, i) => ch.subscribe((status, err) => onStatus(i, status, err)));
      return {
        channelCount: channels.length,
        async setAuth(token) { await rt.setAuth(token); },
        close() { try { rt.removeAllChannels(); rt.disconnect(); } catch { /* already gone */ } },
      };
    },
  };
}
