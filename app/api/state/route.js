import { rpc } from '../../../lib/rpc.js';
export const dynamic = 'force-dynamic';
export async function GET(req) {
  const session = new URL(req.url).searchParams.get('session');
  return rpc(req, 'get_state', { p_session: session });
}
