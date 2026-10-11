// Same rule as public.decision_payload_ok: speed and risk integers 0 to 100,
// crew an optional short string. Checked here so a malformed request never
// reaches the database, and again in submit_decision for any other caller.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const score = (v) => Number.isInteger(v) && v >= 0 && v <= 100;
export function validDecision(b) {
  const p = b?.payload;
  if (typeof b?.submission_id !== 'string' || !UUID.test(b.submission_id)) return false;
  if (!Number.isInteger(b.round) || b.round < 1) return false;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
  if (Object.keys(p).some((k) => !['speed', 'risk', 'crew'].includes(k))) return false;
  if (!score(p.speed) || !score(p.risk)) return false;
  if (p.crew !== undefined && (typeof p.crew !== 'string' || p.crew.length > 32)) return false;
  return true;
}

