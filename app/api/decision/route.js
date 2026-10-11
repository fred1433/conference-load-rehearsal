import { rpc, body } from '../../../lib/rpc.js';
export const dynamic = 'force-dynamic';
export async function POST(req) {
  const b = await body(req);
  return rpc(req, 'submit_decision', { p_submission_id: b.submission_id, p_round: b.round, p_payload: b.payload ?? {} });
}
