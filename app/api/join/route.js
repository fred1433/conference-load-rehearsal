import { rpc, body } from '../../../lib/rpc.js';
export const dynamic = 'force-dynamic';
export async function POST(req) {
  const b = await body(req);
  return rpc(req, 'join_session', { p_session: b.session_id, p_team: b.team ?? 0, p_role: b.role ?? 'participant' });
}
