// The "venue link": a TCP relay standing in for the room's Wi-Fi and NAT.
// Participant devices reach the app and Supabase through it; the facilitator
// and room displays connect directly (assumed wired).
//   blackhole(): packets stop flowing both ways, sockets stay open (no FIN, no RST),
//                new connection attempts fail at once. Clients must notice on their own
//                that their open connections are dead.
//   restore():   new connections work again; connections opened before the cut stay
//                dead, as when the access point or NAT loses its state.
//   resetAll():  every venue connection is reset at the same instant
//                (the deliberately severe, synchronised rejoin case).
import net from 'node:net';

export class VenueLink {
  constructor(routes) {
    this.routes = routes; // [{ listen, host, port }]
    this.down = false;
    this.pairs = new Set();
    this.servers = [];
    this.stats = { accepted: 0, refusedDuringCut: 0, blackholed: 0, reset: 0 };
  }

  async start() {
    for (const r of this.routes) {
      const server = net.createServer((client) => this.#accept(client, r));
      server.maxConnections = 20000;
      await new Promise((res, rej) => server.once('error', rej).listen(r.listen, '127.0.0.1', res));
      this.servers.push(server);
    }
  }

  #accept(client, r) {
    this.stats.accepted++;
    const pair = { client, upstream: null, dead: false };
    this.pairs.add(pair);
    client.setNoDelay(true);
    client.on('error', () => {});
    client.on('close', () => { pair.upstream?.destroy(); this.pairs.delete(pair); });
    if (this.down) {
      // New connection attempts during the cut fail at once, as on a device whose
      // network is down. (Accepting them and staying silent would leave a WebSocket
      // handshake hanging with no timeout, which a real outage does not do forever.)
      this.stats.refusedDuringCut++;
      this.pairs.delete(pair);
      try { client.resetAndDestroy(); } catch { client.destroy(); }
      return;
    }
    const upstream = net.connect({ host: r.host, port: r.port });
    pair.upstream = upstream;
    upstream.setNoDelay(true);
    upstream.on('error', () => {});
    client.on('data', (d) => { if (!pair.dead) upstream.write(d); });
    upstream.on('data', (d) => { if (!pair.dead) client.write(d); });
    upstream.on('close', () => { if (!pair.dead) client.destroy(); });
  }

  blackhole() {
    this.down = true;
    for (const p of this.pairs) { if (!p.dead) { p.dead = true; this.stats.blackholed++; } }
  }

  restore() { this.down = false; }

  resetAll() {
    for (const p of [...this.pairs]) {
      this.stats.reset++;
      try { p.client.resetAndDestroy(); } catch { p.client.destroy(); }
      p.upstream?.destroy();
    }
  }

  async stop() {
    for (const p of this.pairs) { p.client.destroy(); p.upstream?.destroy(); }
    await Promise.all(this.servers.map((s) => new Promise((r) => s.close(() => r()))));
  }
}
