'use client';
import { useEffect, useRef, useState } from 'react';
import { RealtimeClient } from '@supabase/realtime-js';

// Same client library and channel shapes as the protocol-level driver.
export default function Board({ role }) {
  const [state, setState] = useState(null);
  const [status, setStatus] = useState('connecting');
  const versionRef = useRef(0);

  useEffect(() => {
    const cfg = window.__REHEARSAL__;
    if (!cfg) { setStatus('no session injected'); return; }
    const headers = { Authorization: `Bearer ${cfg.accessToken}` };
    const apply = (row) => {
      if (row.kind !== 'final' || row.result_version <= versionRef.current) return;
      versionRef.current = row.result_version;
      document.body.dataset.finalVersion = String(row.result_version);
      setState({ final_version: row.result_version, current_round: row.round, leaderboard: row.leaderboard });
    };
    const recover = async () => {
      try {
        const r = await fetch(`/api/state?session=${cfg.session}`, { headers, cache: 'no-store' });
        const s = await r.json();
        if (s.final_version > versionRef.current) {
          versionRef.current = s.final_version;
          document.body.dataset.finalVersion = String(s.final_version);
          setState(s);
        }
      } catch { /* retried on next rejoin */ }
    };
    const rt = new RealtimeClient(`${cfg.supabaseUrl}/realtime/v1`, { params: { apikey: cfg.anonKey } });
    rt.setAuth(cfg.accessToken);
    const ch = cfg.transport === 'broadcast'
      ? rt.channel(`session:${cfg.session}`, { config: { private: true } })
          .on('broadcast', { event: 'leaderboard' }, ({ payload }) => apply(payload))
      : rt.channel(`pc:${cfg.session}`)
          .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'results', filter: `session_id=eq.${cfg.session}` },
            ({ new: row }) => apply(row));
    ch.subscribe((s) => {
      setStatus(s);
      document.body.dataset.channel = s;
      if (s === 'SUBSCRIBED') recover();
    });
    return () => { rt.removeAllChannels(); rt.disconnect(); };
  }, []);

  const board = state?.leaderboard ?? [];
  return (
    <main style={{ padding: role === 'display' ? 40 : 20, maxWidth: role === 'display' ? 960 : 480, margin: '0 auto' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', borderBottom: '2px solid #1d2a33', paddingBottom: 8 }}>
        <h1 style={{ fontSize: role === 'display' ? 34 : 20, margin: 0 }}>{role === 'display' ? 'Standings' : 'Your table'}</h1>
        <span data-testid="version" style={{ fontVariantNumeric: 'tabular-nums' }}>
          round {state?.current_round ?? '-'} . result v{state?.final_version ?? 0} . {status.toLowerCase()}
        </span>
      </header>
      <ol style={{ paddingLeft: 24, fontSize: role === 'display' ? 22 : 16, fontVariantNumeric: 'tabular-nums' }}>
        {board.slice(0, role === 'display' ? 12 : 5).map((t) => (
          <li key={t.team} style={{ padding: '4px 0' }}>Team {t.team + 1} <strong style={{ float: 'right' }}>{t.total}</strong></li>
        ))}
      </ol>
    </main>
  );
}
