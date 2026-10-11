// One or two real browsers under the protocol-level load (hybrid approach):
// a room display on the wired path and a participant screen on the venue link.
import { chromium } from 'playwright';

export async function startBrowsers({ count, env, adapter, users, clock }) {
  if (!count) return null;
  const browser = await chromium.launch({ headless: true });
  const tabs = [];
  for (let k = 0; k < count; k++) {
    const role = k === 0 ? 'display' : 'participant';
    const path = role === 'display' ? 'direct' : 'venue';
    const dev = { role, path, team: k, user: users[k], token: users[k].access_token };
    const j = await adapter.join(dev);
    if (!j.ok) throw new Error(`browser join failed: ${j.status} ${j.error ?? JSON.stringify(j.data)}`);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const inject = { accessToken: dev.token, session: env.sessionId, transport: env.transport, anonKey: env.anonKey,
      supabaseUrl: path === 'venue' ? env.venueSupabaseUrl : env.supabaseUrl };
    await page.addInitScript((c) => { window.__REHEARSAL__ = c; }, inject);
    const base = path === 'venue' ? env.venueAppUrl : env.appUrl;
    await page.goto(`${base}/${role === 'display' ? 'display' : 'play'}`, { waitUntil: 'load', timeout: 30000 });
    tabs.push({ role, path, page, receipts: [], status: [], lastV: 0, lastS: null });
  }
  let stopped = false;
  const poll = async () => {
    while (!stopped) {
      await Promise.all(tabs.map(async (tab) => {
        try {
          const { v, s } = await tab.page.evaluate(() => ({ v: Number(document.body.dataset.finalVersion || 0), s: document.body.dataset.channel || null }));
          const t = clock.now();
          if (v > tab.lastV) { tab.lastV = v; tab.receipts.push({ t, version: v }); }
          if (s !== tab.lastS) { tab.lastS = s; tab.status.push({ t, status: s }); }
        } catch { /* page busy */ }
      }));
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const loop = poll();
  return {
    async screenshot(file) { await tabs[0].page.screenshot({ path: file }); },
    snapshot() { return tabs.map(({ role, path, receipts, status }) => ({ role, path, receipts, status })); },
    async close() { stopped = true; await loop; await browser.close(); },
  };
}
