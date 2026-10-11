import { rpc, body } from '../../../lib/rpc.js';
import { validDecision } from '../../../lib/decision.js';
export const dynamic = 'force-dynamic';

export async function POST(req) {
  const b = await body(req);
  if (!validDecision(b)) return Response.json({ status: 'rejected', reason: 'invalid_payload' }, { status: 400 });
  return rpc(req, 'submit_decision', { p_submission_id: b.submission_id, p_round: b.round, p_payload: b.payload });
}
