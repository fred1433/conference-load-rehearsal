# Conference load rehearsal for live team simulations

**Measured on a local Next.js and Supabase reference app.** None of the figures below come from a production platform.

A live session in a room does not load a system like a website does. The whole audience arrives within a couple of minutes when the presenter says so, every team submits in the last seconds before a round deadline, the facilitator closes the round and the result goes out to every screen at once, and when the venue Wi-Fi drops, every device comes back at the same time. This repository rehearses that shape: replayable scripts, a reference app that runs the same cycle, and measured results with the evidence kept next to them.

## Results

<!-- results:start -->
**Do 200 devices hold?** On this local bench:

- **Connections.** A room of 200 phones plus the facilitator, the display and two real browsers needs 204 live connections. With the connection limit of the Free plan (200), 4 screens were refused and never saw a result; with the limit raised, every screen got every result within 5 s and no acknowledged decision was lost.
- **Signing in on arrival.** If every phone creates an account or logs in when it arrives, from the venue's one public address, Auth's per-address limits turn most of them away (30 of 200 new anonymous users got through); phones that reuse a session they already hold all got in (200 of 200).
- **After a Wi-Fi drop.** When the venue link went silent for 20 s and came back, every phone reconnected at once and the facilitator could not start round 3 in 4 of 6 runs. That jam formed in the local stack's API gateway (one worker, 512 connections), so it says nothing yet about a hosted project: this is the scenario to repeat on a representative deployment before relying on it.

| Scenario | Workload | Realtime limits as seeded (200 connections, 100 msg/s, 100 joins/s) | Realtime limits raised |
|---|---|---|---|
| Arrival | 200 devices over 120 s, plus facilitator and display (2 real browsers on top) | 198/202 ready; 4 refused by the connection quota in each run; p95 43 ms (39 ms to 45 ms) | 202/202 ready; p95 47 ms (38 ms to 50 ms) |
| Round close | 40 teams submit in the last 5 s, facilitator closes, 3 rounds | 0 acknowledged decisions lost, 0 unacknowledged; submit p95 17 ms (17 ms to 19 ms); worst round 198/202 screens on the final result within 5 s | 0 acknowledged decisions lost, 0 unacknowledged; submit p95 20 ms (18 ms to 22 ms); worst round 202/202 screens on the final result within 5 s |
| Recovery after a silent cut | venue link silent for 20 s as round 1 closes, then back (3 runs with the client library's 25 s heartbeat, 3 with 5 s) | not run | **The session broke: the facilitator could not open round 3 in 4 of 6 runs, the round 2 close failed or took 26 s in 5 of 6, and 24 to 40 of 120 decisions per run were never acknowledged in 5 of 6.** Back on the current result within 30 s of the link returning: 62 to 97 of 200 with the 25 s heartbeat (p95 58 s (51 s to 58 s)), 46 to 47 of 200 with 5 s. Ceiling: the CLI's local gateway (512 connections), not a hosted Supabase figure. |
| Severe reset | every venue connection reset at the same instant as round 1 closes, no silent period (deliberately severe) | 198/200 current within 30 s; p95 3.7 s (3.1 s to 6.2 s); every round opened and closed, every decision acknowledged | not run |
| Headroom | steps of 300, 400, 500 devices, upper bound 500, stop at the first missed target or generator saturation | not run (the seeded quota caps connections at 200) | no step passed; first failure at 300: submit p95 never, worst round 0/302 screens current within 5 s, local gateway logged "worker_connections are not enough" 805 times. Ceiling: the CLI's local gateway (512 connections), not a hosted Supabase figure. |

Measured 2026-10-11 on Apple M1 Max, 10 cores, 64 GB; Docker VM 6 CPU / 12 GB; generator, Next.js and Supabase on the same machine. Medians, with the range across repetitions in brackets; "a to b of n" is the range across runs. Full per-run table: [results/SUMMARY.md](results/SUMMARY.md).
<!-- results:end -->

Proposed reference-app targets, to be agreed before evaluating any real deployment: zero acknowledged decisions lost, decision p95 under 1 s, every screen on the final round result within 5 s, every client back on the current result within 30 s of connectivity returning. Every percentile counts all intended clients; a client that never got there counts as "never", not as a missing sample.

<!-- chart:start -->
![Timeline of recovery-r1](results/timeline.svg)
<!-- chart:end -->

## What broke, in order

<!-- finding:start -->
1. **Auth at arrival, if arrival creates or signs in users behind one address.** With the per-IP limiter switched on at the CLI's default limits, 200 arrivals over 120 s from one venue address: 30/200 new anonymous users, 41/200 new email sign-ups, 89/200 password logins and 89/200 refreshes got through; the rest received HTTP 429. Reusing an existing session: 200/200. With one forwarded address per device, the 2 paths tried (new anonymous user and password login) got 200/200 and 200/200. The first 429 for logins arrived after 35 s, once the burst of 30 was spent. Measured on the local Auth container with the limiter configured explicitly (it is off in the CLI stack by default: 40 anonymous sign-ins from one machine all succeeded).
2. **Realtime connection quota, at arrival.** The session needs 204 Realtime connections (200 devices, a facilitator, a display and 2 real browsers). With the tenant limits as seeded (200 concurrent connections, the published Free value), 4 protocol clients were refused in each of 3 runs (`ConnectionRateLimitReached: Too many connected users` x192 in the Realtime log, the clients retrying) and never saw a round result. Everything else stayed well inside the targets: decision p95 17 ms (17 ms to 19 ms), 0 acknowledged decisions lost. Changing only the tenant limits (`conference-raised`, 3 runs, same 2 browsers): 202/202 ready and 202/202 screens on every round's final result within 5 s.
3. **After a silent cut, the facilitator was blocked.** The venue link went silent for 20 s as round 1 closed (old connections left open, as when an access point loses its state), then came back. What the rehearsal found first is that the session itself broke. Across the 6 cut runs (3 with the client library's 25 s heartbeat, 3 with 5 s): the facilitator could not open round 3 in 4 (`upstream_unreachable`), and in 1 more its open request timed out although the round did open; the round 2 close failed in 3 and took 26 s in 2 more; in 5 of 6 runs, 24 to 40 of 120 decisions were never acknowledged, and 40 more per run were refused because round 3 did not exist. No acknowledged decision was lost. The facilitator is on the wired path, not the cut link, but its requests go through the same local API gateway as the reconnecting phones: that gateway (Kong in the CLI stack: 1 worker, 512 connections) logged `worker_connections are not enough` 599 (142 to 806) times per run along with HTTP 500/503, while the old connections still held its slots. That is a ceiling of the CLI's local gateway, not a hosted Supabase figure; the question it raises for any deployment is what happens to the facilitator's actions when every phone reconnects at once. The phones themselves: within 30 s of the link returning, 62 to 97 of 200 venue clients held the current result with the default heartbeat; p95 time to get there: 58 s (51 s to 58 s). The client library noticed the dead sockets through its heartbeat (25 s by default [18]). Postgres was not the bottleneck: at most 23 client sessions out of 100, 1 active. 545 of 600 recovered clients got the missed result from the state fetch they make after rejoining, not from Realtime: without that fetch they would have stayed on the old result until the next round. A 5 s client heartbeat instead of 25 s (3 runs, without the 2 real browsers) did not help: 46 to 47 of 200 within 30 s, because the clients detected the cut early and tried to reconnect while the link was still down (600 attempts refused per run), then came back on the library's retry schedule [18] into the same congested gateway. For contrast, when every venue connection was reset at once with no silent period (deliberately severe), 198/200 were current within 30 s, p95 3.7 s (3.1 s to 6.2 s), and every round opened and closed with every decision acknowledged. That is consistent with a reset freeing the gateway's old connections where a silent cut leaves them open, but the comparison is not isolated: the reset runs also used the seeded limits, no real browsers, no 20 s silence, and time is counted from the reset rather than from the link's return.
4. **Headroom above 200.** With Realtime limits raised, the first step, 300 devices, failed: submit p95 never, worst round 0/302 screens current within 5 s, local gateway logged "worker_connections are not enough" 805 times; the facilitator's open requests failed for both rounds. The generator was not saturated (scheduling lateness p99 3 ms, CPU max 7 %). On this machine the ceiling above 200 is the local gateway's connection limit, a property of the CLI stack and not a hosted Supabase figure; no breakpoint of the app, Realtime or Postgres was observed up to 200 devices.
5. **Everyone refreshing at once.** In the targeted refresh phase of the 20 min soak, 36/200 simultaneous token refreshes succeeded. Each was tried once with no retry, unlike supabase-js, which retries a refresh that fails on the network. The others failed with connection resets (UND_ERR_SOCKET x93, ECONNRESET x71); the local gateway logged `worker_connections are not enough` 1 time in that run, so it is the likely cause, not a demonstrated one. The soak itself held: 26 rounds, worst round 202/202 screens current within 5 s, no acknowledged decision lost.

Across all 30 runs: 0 acknowledged decisions lost; 299 decisions never acknowledged, all in 6 runs where the local gateway was saturated (recovery-r1, recovery-r2, recovery-heartbeat-5s-r1, recovery-heartbeat-5s-r2, recovery-heartbeat-5s-r3, headroom-300-r1); 160 refused because their round was never opened; 0 runs with a score that did not match the stored decisions; 443 retried submissions answered as duplicates and stored once. Broadcast from the database delivered the final result with a worst-round p95 of 27 ms (19 ms to 34 ms) against 417 ms (342 ms to 531 ms) for Postgres Changes, to the same 202 measured screens with the same payload and authorization (the Postgres Changes reference also carried 2 real browsers, the Broadcast runs 0). Publishing after every decision (3 runs) still met the 5 s target, and no message-rate limit was logged, at raised or seeded limits; the per-second figure is averaged by the server [16], so this does not predict a hosted project's behaviour.
<!-- finding:end -->

## The controlled change and the other experiments

Each row changes one setting against `conference-raised`, with one exception shown in the *Real browsers* column: `conference-raised` and `conference` also ran 2 real Chromium browsers on top of the 202 protocol clients (204 connections), the other rows ran without them (202). The measured screens are the same 202 in every row.

<!-- experiments:start -->
| Experiment | Change against `conference-raised` | Real browsers | Worst round, screens current within 5 s | Delivery p95 (worst round) | Submit p95 | Realtime log |
|---|---|---|---|---|---|---|
| conference-raised (3 runs) | none (reference) | 2 | 202/202 | 417 ms (342 ms to 531 ms) | 20 ms (18 ms to 22 ms) | none |
| conference (3 runs) | tenant limits back to the seeded values | 2 | 198/202 | 256 ms (248 ms to 446 ms) | 17 ms (17 ms to 19 ms) | ConnectionRateLimitReached x192 |
| conference-pro-values (1 run) | tenant limits set to the published Pro values | 0 | 202/202 | 470 ms | 17 ms | none |
| transport-broadcast (3 runs) | Broadcast from the database on a private channel instead of Postgres Changes | 0 | 202/202 | 27 ms (19 ms to 34 ms) | 17 ms (17 ms to 19 ms) | none |
| frequency-every-change (3 runs) | a provisional publication after every decision, plus the final one | 0 | 202/202 | 524 ms (448 ms to 535 ms) | 20 ms (19 ms to 22 ms) | none |
| frequency-every-change-default (1 run) | same, with the seeded tenant limits | 0 | 200/202 | 421 ms | 19 ms | ConnectionRateLimitReached x32 |
| writers-200-stress (1 run) | stress variant, not expected workload: 5 writers per team (200 writers) | 0 | 202/202 | 428 ms | 11 ms | none |
<!-- experiments:end -->

## Five checks for your own deployment

These are questions, because the answers depend on how your app is built, not on a setting. Figures are from the providers' current documentation, read on 2026-10-11.

1. **Which Auth path and rate limits apply to arrivals?** Supabase Auth limits several endpoints per IP address with token buckets: anonymous sign-ins 30 per hour (burst equal to that limit), sign-ups and OTP-type requests 30 per 5 minutes (burst 30), `/token` (password login and refresh) 150 per 5 minutes with bursts up to 30, `/verify` 30 per 5 minutes (burst 30) [1]. 150 per 5 minutes is not 150 at once. The anonymous limit only matters if arrival calls `signInAnonymously()`, which creates a user; using the anon key alone does not [2]. If participants receive magic links or OTP codes: which provider sends them, and with what limits? The built-in sender only delivers to members of the project's team and is capped at 2 emails per hour; custom SMTP starts at 30 per hour, adjustable [1][3]. What this app measured on each path is in [Auth at arrival](#auth-at-arrival).
2. **How many connections and channels will actually be open?** Count every participant device, display, facilitator and second tab, and every channel per connection. Published Realtime limits per plan: concurrent connections 200 (Free), 500 (Pro), 10,000 (Pro without spend cap); messages per second 100 / 500 / 2,500; channel joins per second 100 / 500 / 2,500; channels per connection 100 [4]. Realtime connections are not Postgres connections: browsers using the Data API do not hold a database connection each, so device count alone says nothing about pool exhaustion [11].
3. **How often are results published, and to whom?** A database change received by N clients counts N messages; a Broadcast received by N clients counts N + 1 [5]. Message volume multiplies by the number of recipients. As a hypothesis only: 40 changes each delivered to 200 subscribers inside 5 s is 1,600 deliveries per second. The Realtime rate counter averages over 5 s ticks and 12 buckets [16], so an isolated burst, sustained traffic and retries need separate measurement, not a prediction from the per-second figure. Postgres Changes authorizes every change against each subscriber and processes changes on a single thread; the documentation points to Broadcast beyond roughly 3,000 subscribers on the same changes [6].
4. **What does a reconnect wave do to the facilitator?** On this bench, the facilitator's open and close requests shared the API gateway with every reconnecting phone and failed when it saturated (see finding 3). On a real deployment: which gateway, pool and function limits sit between the facilitator's action and the database, are they shared with participant traffic, and does the facilitator's client retry an open or close that failed? The reconnect itself costs every subscriber a rejoin and, in this app, a state fetch.
5. **Where can the representative deployment be tested, under which provider rules?** Supabase prohibits denial of service and request flooding [9] and its production checklist recommends load testing, preferably in a staging environment [10]. Vercel's policy says load testing is only permitted on Enterprise plans, coordinated through your Vercel representative, and through the sales manager before a contract [12]; its testing guide adds an engineering ticket at 50,000+ requests per second, which is not an exemption below it [13]. Establish the permission that applies before load testing anything on Vercel. Testing Supabase directly isolates the backend but skips Next.js routes, middleware and caching.

## Quick start

Requirements: Docker, Node 22 or later, Supabase CLI 2.120.0, k6 (optional, HTTP-only script). The CLI version fixes the images it starts; the figures here were measured with postgres 17.11.0.004, realtime v2.140.10, gotrue v2.197.0, kong 2.8.1 and postgrest v16.4 (recorded in every `summary.json`). `npm run env` warns if your CLI differs. npm packages are pinned in `package.json` and `package-lock.json`.

```bash
npm install
npx playwright install chromium
supabase start                       # local stack, applies supabase/migrations
npm run env                          # writes .env.local from `supabase status`
npm run build
```

Then, in a second terminal, `npm start` (Next.js in production mode on :3000; it stays in the foreground), and back in the first:

```bash
npm test                             # validation, idempotency, recovery and open-model tests
RUN_LABEL=try DEVICES=50 TEAMS=10 ARRIVAL_SECONDS=30 ROUNDS=2 ROUND_SECONDS=30 npm run rehearse
npm run matrix                       # every run behind this README (about two and a half hours)
npm run report                       # regenerates every figure from results/
```

Each run writes `results/runs/<timestamp>-<label>/` with `summary.json` (outcomes, effective configuration, pinned versions, host and generator measurements), `devices.json.gz` (every client event), `resources.json` and `server-log.txt`.

### Parameters

| Variable | Default | Meaning |
|---|---|---|
| `DEVICES` | 200 | participant devices (arrival volume, persistent sessions) |
| `TEAMS` | 40 | distinct decisions per round |
| `WRITERS_PER_TEAM` | 1 | devices per team that submit (conflicts and retries above 1) |
| `SUBSCRIBERS` | `DEVICES` | participant devices that receive the leaderboard |
| `CHANNELS_PER_CONN` | 1 | channels per Realtime connection (extra private channels) |
| `FACILITATORS` / `DISPLAYS` | 1 / 1 | wired clients; the facilitator closes rounds |
| `SESSION_MODE` | `reuse` | `fresh` (anonymous sign-up), `login`, `reuse`, `refresh` |
| `ARRIVAL_SECONDS`, `ROUNDS`, `ROUND_SECONDS`, `DEADLINE_WINDOW_SECONDS` | 120, 3, 40, 5 | session shape |
| `TRANSPORT` / `PUBLISH` | `postgres_changes` / `aggregate` | `broadcast`; `every_change` |
| `LIMITS_PROFILE` | `local-default` | `local-pro-values`, `local-raised` (Realtime tenant limits, applied through Realtime's tenant API before the run, no restart) |
| `CUT`, `CUT_AT_ROUND`, `CUT_SECONDS` | none, 1, 20 | `blackhole` (abrupt cut) or `reset` (synchronised reset) |
| `HEARTBEAT_MS`, `REFRESH_PHASE`, `LOST_RESPONSE_RATE`, `BROWSERS`, `SOAK_MINUTES` | client default, off, 0.1, 0, 0 | |

Every action is scheduled at an absolute time on a shared clock (open model), so a slow server still receives the burst it would get in the room instead of a loop that waits and quietly lowers the load, the effect Grafana's k6 documentation calls coordinated omission [14]. `tests/open-model.test.mjs` checks it: with 800 ms of injected latency the offered load stays at 50 requests per second, while a closed loop drops.

## Adapting it to another platform

The scenario logic only calls an adapter: `authenticate`, `join`, `submitDecision`, `openRound`, `closeRound`, `observeLeaderboard`, `recoverState`, `refresh` ([rehearse/adapters/reference-app.mjs](rehearse/adapters/reference-app.mjs)). Pointing it at another app means writing a sibling adapter, which needs: how a participant authenticates and joins, the route or RPC that stores a decision and how duplicates are handled, the facilitator's open and close actions, the channel names, filters and events that carry results, and how a client fetches current state after a reconnect. Run it against a staging environment you are allowed to load, under the rules in check 5.

## Assumptions

- The session runs in one room: participants on the venue Wi-Fi behind one public address, the facilitator and the room display on a wired path.
- A live leaderboard goes to every participant at each round close. This is an assumption: a facilitator-only view during the session, with participants seeing results afterwards, is a much lighter workload.
- Default actors: 200 participant devices, 40 teams, 1 writer per team, 1 facilitator, 1 display. That is **more than 200 clients in total** (202 Realtime connections, 204 with the two real browsers). A 200-writer variant exists and is labelled *stress variant, not expected workload*.
- Pre-generated sessions (`SESSION_MODE=reuse`) isolate the database and Realtime in the session runs; arrival through Auth is measured separately.

Three questions adapt this to a real platform:

1. How do participants join, and do they already have a session?
2. Who submits decisions, and who receives updates during a round?
3. What does the facilitator's "close round" action trigger?

## Network path

| Request path | Address Supabase Auth sees |
|---|---|
| Browser directly to Supabase | The venue's public address, for everyone behind the same NAT |
| Next.js server to Supabase, no IP forwarding | The server's egress address, for every participant |
| Next.js server forwarding the participant's IP | The venue's address again for participants sharing that NAT |

Forwarding does not give each attendee a unique public address. On hosted Supabase, `Sb-Forwarded-For` must be enabled in the project's rate-limit settings and sent with a secret key (`sb_secret_...`); publishable and legacy anon or service_role keys are not supported [1]. Such a key never belongs in participant traffic or in a repository. Varying forwarded values is a *forwarded-IP grouping experiment*: a server-side test of how Auth groups requests, not distributed traffic.

## Auth at arrival

<!-- auth:start -->
Default local stack, 40 anonymous sign-ins from one machine: 40 x HTTP 200 (no per-IP limiter configured in this run).

With the limiter switched on (`GOTRUE_RATE_LIMIT_HEADER`, image `gotrue:v2.197.0`, limits as configured by the CLI), 200 arrivals spread over 120 s:

| Auth path | Grouping | Succeeded | HTTP 429 | First 429 after | Successes per 30 s |
|---|---|---|---|---|---|
| New anonymous user (`signInAnonymously`) | whole room behind one IP | 30/200 | 170 | 22 s | 30, 0, 0, 0 |
| New email and password sign-up | whole room behind one IP | 41/200 | 159 | 23 s | 32, 3, 3, 3 |
| Existing user, password login | whole room behind one IP | 89/200 | 111 | 35 s | 40, 19, 15, 15 |
| Existing session, token refresh | whole room behind one IP | 89/200 | 111 | 35 s | 40, 19, 15, 15 |
| Existing session reused (`GET /user`) | whole room behind one IP | 200/200 | 0 | none | 40, 47, 58, 55 |
| New anonymous user (`signInAnonymously`) | one forwarded IP per device | 200/200 | 0 | none | 40, 47, 58, 55 |
| Existing user, password login | one forwarded IP per device | 200/200 | 0 | none | 40, 47, 58, 55 |
<!-- auth:end -->

## Steps, headroom and soak

<!-- steps:start -->
| Run | Clients (devices + facilitator + display) | Ready | Submit p95 | Worst round current within 5 s | Delivery p95 | Generator lateness p99 | Next.js CPU max | Realtime CPU max |
|---|---|---|---|---|---|---|---|---|
| baseline-r1 | 12 | 12 | 110 ms | 12/12 | 429 ms | 6 ms | 1 % | 1.23 % |
| step-50-r1 | 52 | 52 | 17 ms | 52/52 | 488 ms | 1 ms | 1 % | 1.77 % |
| step-100-r1 | 102 | 102 | 18 ms | 102/102 | 259 ms | 2 ms | 1 % | 3.19 % |
| step-200-r1 | 202 | 200 | 18 ms | 200/202 | 484 ms | 2 ms | 2 % | 4.04 % |
| headroom-300-r1 | 302 | 246 | never | 0/302 | never | 3 ms | 8 % | 8.01 % |
<!-- steps:end -->

<!-- soak:start -->
26 rounds over 22 min, 202 clients: 202 ready, 0 acknowledged decisions lost, submit p95 24 ms, worst round 202/202 current within 5 s, generator RSS max 203 MB, Realtime memory max 285 MB. The soak does not cross token expiry (JWT lifetime 3600 s), so a targeted refresh phase runs before the last round: 36/200 refreshes succeeded at the same instant, each tried once with no retry (UND_ERR_SOCKET x93, ECONNRESET x71), 36 Realtime tokens updated in band, and the last round reached 202/202 screens within 5 s.
<!-- soak:end -->

<!-- k6:start -->
k6, HTTP only, 200 devices over 120 s and 40 decisions in 5 s: join p95 24 ms, decision p95 18 ms, failed requests 0.00 %, checks 242 of 243 passed (the summary does not record which check failed), dropped iterations 0.
<!-- k6:end -->

## Tools

Realtime clients use the official `@supabase/realtime-js` in Node, because heartbeats, token updates and rejoin after a drop are what this rehearsal measures, and that is the code browsers run. k6 drives the HTTP side of the same shape with arrival-rate executors (`k6/conference-http.js`). Two real Chromium browsers (a display and a participant screen) run under the protocol load, following Grafana's hybrid approach [15]. Participants reach the app through a local TCP relay that stands in for the venue link and can blackhole or reset every connection.

## Sources (read 2026-10-11)

1. Supabase, Auth rate limits: https://supabase.com/docs/guides/auth/rate-limits
2. Supabase, Anonymous sign-ins: https://supabase.com/docs/guides/auth/auth-anonymous
3. Supabase, Custom SMTP: https://supabase.com/docs/guides/auth/auth-smtp
4. Supabase, Realtime limits: https://supabase.com/docs/guides/realtime/limits
5. Supabase, Realtime messages usage: https://supabase.com/docs/guides/platform/manage-your-usage/realtime-messages
6. Supabase, Postgres Changes: https://supabase.com/docs/guides/realtime/postgres-changes
7. Supabase, Realtime authorization: https://supabase.com/docs/guides/realtime/authorization
8. Supabase, Realtime protocol: https://supabase.com/docs/guides/realtime/protocol
9. Supabase, Security testing: https://supabase.com/docs/guides/security/security-testing
10. Supabase, Production checklist: https://supabase.com/docs/guides/deployment/going-into-prod
11. Supabase, Connecting to Postgres: https://supabase.com/docs/guides/database/connecting-to-postgres
12. Vercel, Load testing policy (updated 2025-11-24): https://vercel.com/kb/guide/what-s-vercel-s-policy-regarding-load-testing-deployments
13. Vercel, How to load test a Vercel application (updated 2025-12-09): https://vercel.com/kb/guide/how-to-effectively-load-test-your-vercel-application
14. Grafana k6, Open and closed models: https://grafana.com/docs/k6/latest/using-k6/scenarios/concepts/open-vs-closed/
15. Grafana k6, Hybrid approach: https://grafana.com/docs/k6/latest/using-k6-browser/recommended-practices/hybrid-approach-to-performance/
16. supabase/realtime at d46540b, rate counters (5 s tick, 12 buckets, average): https://github.com/supabase/realtime/blob/d46540b3a4a79113f40301d5e5cb690f41150b9b/lib/realtime/tenants.ex#L192-L262 and Free-tier tenant defaults: https://github.com/supabase/realtime/blob/d46540b3a4a79113f40301d5e5cb690f41150b9b/config/runtime.exs#L146-L150
17. supabase/auth at ce9a8ee, IP limiting skipped when no rate-limit header is configured: https://github.com/supabase/auth/blob/ce9a8eee0cc042be8c7a42981a7ddae631e41d91/internal/api/middleware.go#L72-L78
18. supabase-js at b9753a1, Realtime client defaults: 25 s heartbeat (`HEARTBEAT_INTERVAL: 25000`) and reconnect schedule of 1, 2, 5 then 10 s: https://github.com/supabase/supabase-js/blob/b9753a1e3a8ad867b5c1dbefaf9a5a41cd4ce147/packages/core/realtime-js/src/RealtimeClient.ts#L45-L52 ; 10 s default timeout (`DEFAULT_TIMEOUT = 10000`): https://github.com/supabase/supabase-js/blob/b9753a1e3a8ad867b5c1dbefaf9a5a41cd4ce147/packages/core/realtime-js/src/lib/constants.ts#L20

MIT licence.
