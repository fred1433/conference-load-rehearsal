-- close_round on a round that was never opened now says so, instead of
-- reporting it as already closed.
create or replace function public.close_round(p_round int)
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
    if not exists (select 1 from public.rounds where session_id = v_part.session_id and number = p_round) then
      return jsonb_build_object('status', 'rejected', 'reason', 'round_not_opened', 'final_version', v_version);
    end if;
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
