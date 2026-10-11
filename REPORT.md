# Report: conference load rehearsal

**These figures come from the reference app in this repository, run on one machine. They are not measurements of any production platform.** Load generator, Next.js (`next start`) and the local Supabase stack shared that machine; generator CPU and scheduling delay were recorded in every run, and no slowdown is attributed to Supabase without them.

## What broke, in order

<!-- finding:start -->
1. **Auth at arrival, if arrival creates or signs in users behind one address.** With the per-IP limiter switched on at the CLI's default limits, 200 arrivals over 120 s from one venue address: 30/200 new anonymous users, 41/200 new email sign-ups, 89/200 password logins and 89/200 refreshes got through; the rest received HTTP 429. Reusing an existing session: 200/200. With one forwarded address per device, every path got 200/200. The first 429 for logins arrived after 35 s, once the burst of 30 was spent. Measured on the local Auth container with the limiter configured explicitly (it is off in the CLI stack by default: 40 anonymous sign-ins from one machine all succeeded).
2. **Realtime connection quota, at arrival.** The session needs 204 Realtime connections (200 devices, a facilitator, a display and 2 real browsers). With the tenant limits as seeded (200 concurrent connections, the published Free value), 4 protocol clients were refused in each of 3 runs (`ConnectionRateLimitReached: Too many connected users` x192 in the Realtime log, the clients retrying) and never saw a round result. Everything else stayed well inside the targets: decision p95 17 ms (17 ms to 19 ms), 0 acknowledged decisions lost. Changing only the tenant limits (`conference-raised`, 3 runs): 202/202 ready and 202/202 screens on every round's final result within 5 s.
3. **Reconnect wave after a half-open cut.** The venue link went silent for 20 s as round 1 closed (old connections left open, as when an access point loses its state). Within 30 s of the link returning, 62 to 97 /200 venue clients held the current result; p95 time to get there: 58 s (51 s to 58 s). The client library noticed the dead sockets through its heartbeat (25 s by default [18]); then the local API gateway (Kong in the CLI stack: 1 worker, 512 connections) logged `worker_connections are not enough` 454 (142 to 617) times per run along with HTTP 500/503, while the old connections still held its slots. Postgres was not the bottleneck: at most 18 client sessions out of 100, 1 active. 545 of 600 recovered clients got the missed result from the state fetch they make after rejoining, not from Realtime: without that fetch they would have stayed on the old result until the next round. For contrast, when every venue connection was reset at once (deliberately severe, seeded limits), 198/200 were current within 30 s, p95 3.7 s (3.1 s to 6.2 s): a clean reset frees the old connections, a silent cut does not. A 5 s client heartbeat instead of 25 s (3 runs) did not help: 46 to 47 /200 within 30 s, because the clients detected the cut early and tried to reconnect while the link was still down (600 attempts refused per run), then came back on the library's retry schedule into the same congested gateway.
4. **Headroom above 200.** With Realtime limits raised, the first step, 300 devices, failed: submit p95 never, worst round 0/302 screens current within 5 s, local gateway logged "worker_connections are not enough" 805 times. The generator was not saturated (scheduling lateness p99 3 ms, CPU max 7 %). On this machine the ceiling above 200 is the local gateway's connection limit, a property of the CLI stack; no breakpoint of the app, Realtime or Postgres was observed up to 200 devices.
5. **Everyone refreshing at once.** In the targeted refresh phase of the 20 min soak, 36/200 simultaneous token refreshes succeeded; the others failed with connection resets (UND_ERR_SOCKET x93, ECONNRESET x71) from the same local gateway ceiling. The soak itself held: 26 rounds, worst round 202/202 screens current within 5 s, no acknowledged decision lost.

Across all 30 runs: 0 acknowledged decisions lost, 0 runs with a score that did not match the stored decisions, 443 retried submissions answered as duplicates and stored once. Broadcast from the database delivered the final result with a worst-round p95 of 27 ms (19 ms to 34 ms) against 417 ms (342 ms to 531 ms) for Postgres Changes, same recipients, payload and authorization. Publishing after every decision (3 runs) still met the 5 s target, and no message-rate limit was logged, at raised or seeded limits; the per-second figure is averaged by the server [16], so this does not predict a hosted project's behaviour.
<!-- finding:end -->

## What each environment can and cannot establish

| Environment | What it can establish | What it cannot establish |
|---|---|---|
| Local Next.js + Supabase (this repository) | Reference-app correctness, query behaviour, configured limiter behaviour, delivery and recovery under generated load | Managed-plan capacity, Vercel behaviour, venue network performance |
| Owned free hosted Supabase project (optional, not run here) | Behaviour of that project's gateway, Auth, Realtime and database configuration under a permitted workload | Your configuration, a paid plan's capacity, the complete Vercel application path |
| Authorised representative deployment, later | Behaviour of the real application paths and configuration tested | Conditions left out of the test, including the physical venue network |

Local limit profiles are labelled *local default* (as the CLI seeded them, equal to the published Free values), *local with published Pro values* and *local with selected limits raised*. None of them is a Free or Pro benchmark.

## Checks for your own configuration

1. Arrival path: which Auth endpoints do participants hit on arrival, through which address, and with which per-IP limits (Auth > Rate Limits)? If OTP or magic links: which email provider, which limit? [rate limits](https://supabase.com/docs/guides/auth/rate-limits), [SMTP](https://supabase.com/docs/guides/auth/auth-smtp)
2. Connections: total Realtime clients (participants, displays, facilitator, extra tabs) against the plan's concurrent-connection and join limits, with headroom for a reconnect wave. [Realtime limits](https://supabase.com/docs/guides/realtime/limits)
3. Publication: how often results go out and to how many recipients; Broadcast or Postgres Changes; whether a client fetches state after rejoining. [messages](https://supabase.com/docs/guides/platform/manage-your-usage/realtime-messages), [Postgres Changes](https://supabase.com/docs/guides/realtime/postgres-changes)
4. Database path under a reconnect wave: pool sizes between the API layer and Postgres, and what the rejoin of every subscriber costs. [connecting](https://supabase.com/docs/guides/database/connecting-to-postgres)
5. Where the representative deployment may be load tested: Supabase staging under its rules, Vercel only with the permission that applies. [Supabase security testing](https://supabase.com/docs/guides/security/security-testing), [Vercel policy](https://vercel.com/kb/guide/what-s-vercel-s-policy-regarding-load-testing-deployments)

Numbers in square brackets refer to the sources listed at the end of the [README](README.md#sources-read-2026-10-11).

## Not covered

Hosted Supabase probes (optional, not run), runs past the local gateway's 512-connection ceiling (it would need a reconfigured gateway), any Vercel deployment, real venue Wi-Fi, mobile browsers, and token expiry during the soak (covered by a targeted refresh phase instead). Detail for every run: [results/SUMMARY.md](results/SUMMARY.md) and `results/runs/`.
