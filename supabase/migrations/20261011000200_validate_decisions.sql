-- A decision is validated where it enters, and a bad row can never block a close.
--
-- Before this migration, submit_decision stored any JSON payload, so
-- {"speed": "abc"} was acknowledged as `stored` and close_round then failed for
-- the whole round on the integer cast in score_of (22P02), leaving it open.
-- A submission_id reused for another round also answered `duplicate` while
-- nothing was stored for that round.

-- Shape of a decision: speed and risk are integers from 0 to 100, crew an
-- optional short string, nothing else.
create function public.decision_payload_ok(p jsonb)
returns boolean language plpgsql immutable as $$
declare k text;
begin
  -- Checked step by step so no cast runs on a value of the wrong type.
  if p is null or jsonb_typeof(p) <> 'object' then return false; end if;
  for k in select jsonb_object_keys(p) loop
    if k not in ('speed', 'risk', 'crew') then return false; end if;
  end loop;
  foreach k in array array['speed', 'risk'] loop
    if jsonb_typeof(p->k) is distinct from 'number' then return false; end if;
    if (p->>k)::numeric not between 0 and 100 or (p->>k)::numeric <> trunc((p->>k)::numeric) then return false; end if;
  end loop;
  if p ? 'crew' and (jsonb_typeof(p->'crew') <> 'string' or length(p->>'crew') > 32) then return false; end if;
  return true;
end $$;

-- Defensive score: a value that is not a number counts as 0 and numbers are
-- clamped, so a row written before validation existed cannot fail the close.
-- Valid payloads score exactly as before.
create or replace function public.score_of(p_team int, p_round int, p_payload jsonb)
returns int language sql immutable as $$
  select (case when jsonb_typeof(p_payload->'speed') = 'number'
               then greatest(-1000, least(1000, (p_payload->>'speed')::numeric))::int else 0 end)
       - (case when jsonb_typeof(p_payload->'risk') = 'number'
               then greatest(-1000, least(1000, (p_payload->>'risk')::numeric))::int else 0 end) / 2
       + ((p_team * 7 + p_round * 13) % 11)
$$;

create or replace function public.submit_decision(p_submission_id uuid, p_round int, p_payload jsonb)
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

  if p_submission_id is null or p_round is null or not public.decision_payload_ok(p_payload) then
    return jsonb_build_object('status', 'rejected', 'reason', 'invalid_payload');
  end if;

  select * into v_existing from public.decisions where submission_id = p_submission_id;
  if found then
    if v_existing.round <> p_round or v_existing.team <> v_part.team then
      return jsonb_build_object('status', 'rejected', 'reason', 'submission_id_reused');
    end if;
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
      if v_existing.round <> p_round or v_existing.team <> v_part.team then
        return jsonb_build_object('status', 'rejected', 'reason', 'submission_id_reused');
      end if;
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

revoke execute on function public.decision_payload_ok(jsonb) from public, anon;
