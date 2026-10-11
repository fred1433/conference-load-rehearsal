import { rpc, body } from '../../../../lib/rpc.js';
export const dynamic = 'force-dynamic';
export async function POST(req) {
  const b = await body(req);
  return rpc(req, 'open_round', { p_round: b.round, p_seconds: b.seconds });
}
