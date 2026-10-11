-- Reference app: a live team simulation run in a room.
-- Participants join a session, one decision per team per round, a facilitator
-- closes the round, the leaderboard is published to every subscriber.

create table public.sessions (
  id uuid primary key,
  label text not null,
  transport text not null default 'postgres_changes'
    check (transport in ('postgres_changes', 'broadcast')),
  publish text not null default 'aggregate'
    check (publish in ('aggregate', 'every_change')),
  current_round int not null default 0,
  result_version int not null default 0,
  final_version int not null default 0,
  created_at timestamptz not null default now()
);

create table public.participants (
  user_id uuid primary key references auth.users on delete cascade,
  session_id uuid not null references public.sessions on delete cascade,
  team int not null,
  role text not null check (role in ('participant', 'facilitator', 'display')),
  joined_at timestamptz not null default clock_timestamp()
);
create index participants_session_idx on public.participants (session_id);

create table public.rounds (
  session_id uuid not null references public.sessions on delete cascade,
  number int not null,
  status text not null default 'open' check (status in ('open', 'closed')),
  deadline_at timestamptz not null,
  opened_at timestamptz not null default clock_timestamp(),
  closed_at timestamptz,
  primary key (session_id, number)
);

create table public.decisions (
  submission_id uuid primary key,
  session_id uuid not null references public.sessions on delete cascade,
  round int not null,
  team int not null,
  user_id uuid not null,
  payload jsonb not null,
  received_at timestamptz not null default clock_timestamp(),
  unique (session_id, round, team)
);

create table public.team_scores (
  session_id uuid not null references public.sessions on delete cascade,
  team int not null,
  total int not null default 0,
  rounds_scored int not null default 0,
  primary key (session_id, team)
);

create table public.results (
  session_id uuid not null references public.sessions on delete cascade,
  result_version int not null,
  round int not null,
  kind text not null check (kind in ('final', 'provisional')),
  leaderboard jsonb not null,
  published_at timestamptz not null default clock_timestamp(),
  primary key (session_id, result_version)
);

alter table public.sessions enable row level security;
alter table public.participants enable row level security;
alter table public.rounds enable row level security;
alter table public.decisions enable row level security;
alter table public.team_scores enable row level security;
alter table public.results enable row level security;

-- Postgres Changes: Realtime checks this policy for every subscriber of every change.
create policy results_members_read on public.results for select to authenticated
  using (exists (
    select 1 from public.participants p
    where p.user_id = (select auth.uid()) and p.session_id = results.session_id
  ));

create policy participants_self_read on public.participants for select to authenticated
  using (user_id = (select auth.uid()));

-- Broadcast on private channels: Realtime checks this policy when a client joins.
create policy session_members_receive on realtime.messages for select to authenticated
  using (
    split_part((select realtime.topic()), ':', 1) = 'session'
    and exists (
      select 1 from public.participants p
      where p.user_id = (select auth.uid())
        and split_part((select realtime.topic()), ':', 2) = p.session_id::text
    )
  );

alter publication supabase_realtime add table public.results;

-- Deterministic score so totals can be recomputed and checked after a run.
create function public.score_of(p_team int, p_round int, p_payload jsonb)
returns int language sql immutable as $$
  select coalesce((p_payload->>'speed')::int, 0)
       - coalesce((p_payload->>'risk')::int, 0) / 2
       + ((p_team * 7 + p_round * 13) % 11)
$$;

create function public.leaderboard_of(p_session uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('team', s.team, 'total', s.total) order by s.total desc, s.team), '[]'::jsonb)
  from public.team_scores s where s.session_id = p_session
$$;

create function public.publish_results(p_session uuid, p_round int, p_kind text)
returns int language plpgsql security definer set search_path = '' as $$
declare
  v_version int;
  v_transport text;
  v_board jsonb;
begin
  update public.sessions
     set result_version = result_version + 1,
         final_version = case when p_kind = 'final' then result_version + 1 else final_version end
   where id = p_session
  returning result_version, transport into v_version, v_transport;

  if p_kind = 'final' then
    v_board := public.leaderboard_of(p_session);
  else
    select coalesce(jsonb_agg(jsonb_build_object('team', d.team, 'submitted', true) order by d.team), '[]'::jsonb)
      into v_board
      from public.decisions d where d.session_id = p_session and d.round = p_round;
  end if;

  -- Same row, same payload in both transports: only the delivery path differs.
  insert into public.results (session_id, result_version, round, kind, leaderboard)
  values (p_session, v_version, p_round, p_kind, v_board);

  if v_transport = 'broadcast' then
    perform realtime.send(
      jsonb_build_object('session_id', p_session, 'result_version', v_version,
                         'round', p_round, 'kind', p_kind, 'leaderboard', v_board),
      'leaderboard', 'session:' || p_session::text, true);
  end if;
  return v_version;
end $$;

create function public.get_state(p_session uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'session_id', s.id,
    'current_round', s.current_round,
    'round_status', r.status,
    'deadline_at', r.deadline_at,
    'result_version', s.result_version,
    'final_version', s.final_version,
    'leaderboard', public.leaderboard_of(s.id))
  from public.sessions s
  left join public.rounds r on r.session_id = s.id and r.number = s.current_round
  where s.id = p_session
    and exists (select 1 from public.participants p where p.user_id = auth.uid() and p.session_id = s.id)
$$;

create function public.join_session(p_session uuid, p_team int, p_role text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    return jsonb_build_object('status', 'rejected', 'reason', 'no_user');
  end if;
  insert into public.participants (user_id, session_id, team, role)
  values (auth.uid(), p_session, p_team, p_role)
  on conflict (user_id) do update
    set session_id = excluded.session_id, team = excluded.team, role = excluded.role;
  return jsonb_build_object('status', 'joined', 'state', public.get_state(p_session));
end $$;

-- Idempotent on submission_id; one stored decision per team and round.
-- FOR SHARE on the round row orders this against close_round: a decision is
-- either acknowledged before the close and scored, or rejected.
create function public.submit_decision(p_submission_id uuid, p_round int, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_part public.participants;
  v_status text;
  v_publish text;
  v_inserted uuid;
  v_existing public.decisions;
begin
  select * into v_part from public.participants where user_id = auth.uid();
  if not found then
    return jsonb_build_object('status', 'rejected', 'reason', 'not_joined');
  end if;

  select * into v_existing from public.decisions where submission_id = p_submission_id;
  if found then
    return jsonb_build_object('status', 'duplicate', 'team', v_existing.team, 'round', v_existing.round);
  end if;

  select r.status into v_status from public.rounds r
   where r.session_id = v_part.session_id and r.number = p_round for share;
  if v_status is distinct from 'open' then
    return jsonb_build_object('status', 'rejected', 'reason', 'round_not_open');
  end if;

  insert into public.decisions (submission_id, session_id, round, team, user_id, payload)
  values (p_submission_id, v_part.session_id, p_round, v_part.team, v_part.user_id, p_payload)
  on conflict do nothing
  returning submission_id into v_inserted;

  if v_inserted is null then
    select * into v_existing from public.decisions where submission_id = p_submission_id;
    if found then
      return jsonb_build_object('status', 'duplicate', 'team', v_existing.team, 'round', v_existing.round);
    end if;
    return jsonb_build_object('status', 'rejected', 'reason', 'team_already_submitted');
  end if;

  select publish into v_publish from public.sessions where id = v_part.session_id;
  if v_publish = 'every_change' then
    perform public.publish_results(v_part.session_id, p_round, 'provisional');
  end if;
  return jsonb_build_object('status', 'stored', 'team', v_part.team, 'round', p_round);
end $$;

create function public.open_round(p_round int, p_seconds numeric)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_part public.participants;
begin
  select * into v_part from public.participants where user_id = auth.uid() and role = 'facilitator';
  if not found then
    return jsonb_build_object('status', 'rejected', 'reason', 'not_facilitator');
  end if;
  insert into public.rounds (session_id, number, deadline_at)
  values (v_part.session_id, p_round, clock_timestamp() + make_interval(secs => p_seconds::double precision))
  on conflict do nothing;
  update public.sessions set current_round = greatest(current_round, p_round) where id = v_part.session_id;
  return jsonb_build_object('status', 'open', 'round', p_round);
end $$;

-- Closes once. A second call reports the already published version and scores nothing.
create function public.close_round(p_round int)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_part public.participants;
  v_closed int;
  v_version int;
  v_count int;
begin
  select * into v_part from public.participants where user_id = auth.uid() and role = 'facilitator';
  if not found then
    return jsonb_build_object('status', 'rejected', 'reason', 'not_facilitator');
  end if;

  update public.rounds set status = 'closed', closed_at = clock_timestamp()
   where session_id = v_part.session_id and number = p_round and status = 'open'
  returning number into v_closed;

  if v_closed is null then
    select final_version into v_version from public.sessions where id = v_part.session_id;
    return jsonb_build_object('status', 'already_closed', 'final_version', v_version);
  end if;

  insert into public.team_scores (session_id, team, total, rounds_scored)
  select d.session_id, d.team, public.score_of(d.team, d.round, d.payload), 1
    from public.decisions d where d.session_id = v_part.session_id and d.round = p_round
  on conflict (session_id, team) do update
    set total = public.team_scores.total + excluded.total,
        rounds_scored = public.team_scores.rounds_scored + 1;
  get diagnostics v_count = row_count;

  v_version := public.publish_results(v_part.session_id, p_round, 'final');
  return jsonb_build_object('status', 'closed', 'round', p_round, 'final_version', v_version, 'scored', v_count);
end $$;

revoke execute on function public.publish_results(uuid, int, text) from public, anon, authenticated;
revoke execute on function public.leaderboard_of(uuid) from public, anon;
grant execute on function public.get_state(uuid), public.join_session(uuid, int, text),
  public.submit_decision(uuid, int, jsonb), public.open_round(int, numeric),
  public.close_round(int) to authenticated;
revoke execute on function public.get_state(uuid), public.join_session(uuid, int, text),
  public.submit_decision(uuid, int, jsonb), public.open_round(int, numeric),
  public.close_round(int) from anon, public;
