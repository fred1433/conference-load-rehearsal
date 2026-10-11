// One simulated client: a participant phone or laptop, a room display or the facilitator.
import { randomUUID } from 'node:crypto';
import { sleep } from './common.mjs';

export class Device {
  constructor({ id, role, team, writer, subscriber, path, user, adapter, clock, cfg }) {
    Object.assign(this, { id, role, team, writer, subscriber, path, user, adapter, clock, cfg });
    this.ready = false;
    this.joined = false;
    this.readyAt = null;
    this.plannedArrival = null;
    this.finalVersion = 0;
    this.receipts = []; // { t, version, via }
    this.subscribedOnce = new Set();
    this.mainSubscribedCount = 0;
    this.statusLog = [];
    this.recoveries = [];
    this.submissions = [];
    this.auth = null;
    this.joinAttempts = 0;
    this.authAttempts = 0;
    this.errors = [];
    this.rt = null;
  }

  #hold(version, via) {
    if (version > this.finalVersion) {
      this.finalVersion = version;
      this.receipts.push({ t: this.clock.now(), version, via });
    }
  }

  async arrive(plannedAt) {
    this.plannedArrival = plannedAt;
    for (;;) {
      this.authAttempts++;
      this.auth = await this.adapter.authenticate(this, this.role === 'participant' ? this.cfg.sessionMode : 'reuse');
      if (this.auth.ok) break;
      this.errors.push({ t: this.clock.now(), op: 'auth', status: this.auth.status, error: this.auth.error });
      if (this.authAttempts >= 3) return;
      await sleep(1000 * this.authAttempts);
    }
    let joined;
    for (;;) {
      this.joinAttempts++;
      joined = await this.adapter.join(this);
      if (joined.ok && joined.data?.status === 'joined') break;
      this.errors.push({ t: this.clock.now(), op: 'join', status: joined.status, error: joined.error ?? joined.data?.reason });
      if (this.joinAttempts >= 3) return;
      await sleep(1000 * this.joinAttempts);
    }
    this.joined = true;
    this.#hold(joined.data.state?.final_version ?? 0, 'join');
    if (!this.subscriber) { this.#markReady(); return; }

    let resolveSubscribed;
    const subscribed = new Promise((r) => { resolveSubscribed = r; });
    this.rt = this.adapter.observeLeaderboard(this, {
      onResult: (row) => { if (row?.kind === 'final') this.#hold(row.result_version, 'realtime'); },
      onStatus: (i, status, err) => {
        const t = this.clock.now();
        this.statusLog.push({ t, ch: i, status, err: err?.message });
        if (status !== 'SUBSCRIBED') return;
        this.subscribedOnce.add(i);
        if (i === 0) {
          this.mainSubscribedCount++;
          // A rejoin after the first subscription: fetch state to catch what was missed.
          if (this.mainSubscribedCount > 1) this.recover('rejoin');
        }
        if (this.subscribedOnce.size === this.rt?.channelCount) resolveSubscribed();
      },
    });
    if (this.subscribedOnce.size === this.rt.channelCount) resolveSubscribed();
    await subscribed;
    this.#markReady();
  }

  #markReady() {
    if (this.ready) return;
    this.ready = true;
    this.readyAt = this.clock.now();
  }

  async recover(reason) {
    const started = this.clock.now();
    for (let attempt = 1; attempt <= 5; attempt++) {
      const r = await this.adapter.recoverState(this);
      if (r.ok && r.data?.final_version != null) {
        this.#hold(r.data.final_version, 'recover');
        this.recoveries.push({ reason, started, done: this.clock.now(), attempt, version: r.data.final_version });
        return;
      }
      await sleep(500 * attempt);
    }
    this.recoveries.push({ reason, started, done: null });
  }

  async submit(round, plannedAt, loseFirstResponse) {
    const submission_id = randomUUID();
    const payload = { speed: 40 + ((this.team * 17 + round * 5) % 60), risk: (this.team * 11 + round * 3) % 50, crew: 'balanced' };
    const rec = { submission_id, round, team: this.team, plannedAt, attempts: 0, lostResponse: false, status: null, reason: null, ackAt: null, errors: [] };
    this.submissions.push(rec);
    while (rec.attempts < 4) {
      rec.attempts++;
      const r = await this.adapter.submitDecision(this, { submission_id, round, payload });
      if (rec.attempts === 1 && loseFirstResponse && r.ok) {
        // The request reached the server but the phone never saw the answer.
        rec.lostResponse = true;
        continue;
      }
      if (r.ok && r.data?.status) {
        rec.status = r.data.status;
        rec.reason = r.data.reason ?? null;
        rec.ackAt = this.clock.now();
        return;
      }
      rec.errors.push(r.error ?? `http_${r.status}`);
      await sleep(250 * rec.attempts);
    }
  }

  async refreshSession() {
    const started = this.clock.now();
    const r = await this.adapter.refresh(this);
    let realtimeOk = null;
    if (r.ok && this.rt) {
      try { await this.rt.setAuth(this.token); realtimeOk = true; } catch { realtimeOk = false; }
    }
    this.refreshResult = { started, ms: r.ms, ok: r.ok, status: r.status, error: r.error, realtimeOk };
  }

  close() { this.rt?.close(); }

  snapshot() {
    return {
      id: this.id, role: this.role, team: this.team, writer: this.writer, subscriber: this.subscriber, path: this.path,
      plannedArrival: this.plannedArrival, joined: this.joined, ready: this.ready, readyAt: this.readyAt,
      authAttempts: this.authAttempts, joinAttempts: this.joinAttempts, auth: this.auth,
      finalVersion: this.finalVersion, receipts: this.receipts, statusLog: this.statusLog,
      recoveries: this.recoveries, submissions: this.submissions, errors: this.errors, refresh: this.refreshResult ?? null,
    };
  }
}
