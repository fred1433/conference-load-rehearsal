// Server side: every route forwards the participant's own JWT to PostgREST,
// so Row Level Security and auth.uid() apply exactly as for a browser call.
const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const ANON_KEY = process.env.SUPABASE_ANON_KEY;

export async function rpc(req, fn, args) {
  const auth = req.headers.get('authorization');
  if (!auth) return Response.json({ status: 'rejected', reason: 'no_token' }, { status: 401 });
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: ANON_KEY, Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
  } catch (err) {
    return Response.json({ status: 'error', reason: 'upstream_unreachable', message: String(err) }, { status: 502 });
  }
  const text = await res.text();
  if (!res.ok) {
    return Response.json({ status: 'error', reason: 'upstream_' + res.status, message: text.slice(0, 300) }, { status: res.status === 401 ? 401 : 502 });
  }
  const data = text ? JSON.parse(text) : null;
  return Response.json(data ?? { status: 'rejected', reason: 'not_member' }, { status: data ? 200 : 403 });
}

export async function body(req) {
  try { return await req.json(); } catch { return {}; }
}
