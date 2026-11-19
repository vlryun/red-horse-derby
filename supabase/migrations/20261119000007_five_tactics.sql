-- ═══════════════════════════════════════════════════════════════════════
-- 붉은 말의 대질주 · 작전 타임 5회 (엔진 v8)
--
--  * v8 경주는 작전 창이 5개, v4~v7 경주는 예전처럼 3개 (경주에 기록된 엔진 버전으로 구분)
--  * 창 시각은 src/engine/tactics.ts 의 tacticWindows 와 같은 정수 계산
--      v4~v7: 마감 = 초 × (170, 360, 600), 길이 = clamp(초×130, 3500, 6000)
--      v8   : 마감 = 초 × (150, 290, 430, 570, 710), 길이 = clamp(초×100, 3000, 6000)
--  * 마감·공개 규칙은 그대로: 열린 창에서만 선택·변경, 마지막 선택 하나, 마감 + 0.3초 뒤 공개
--
-- 이 파일은 여러 번 실행해도 안전하다(멱등).
-- ═══════════════════════════════════════════════════════════════════════

-- 창 번호 1..5 허용
do $$
declare
  c text;
begin
  for c in
    select con.conname from pg_constraint con
     where con.conrelid = 'public.race_tactics'::regclass and con.contype = 'c'
       and pg_get_constraintdef(con.oid) like '%window_no%'
  loop
    execute format('alter table public.race_tactics drop constraint %I', c);
  end loop;
end $$;
alter table public.race_tactics add constraint race_tactics_window_no_check check (window_no between 1 and 5);

create or replace function public._tactic_window_count(p_engine integer)
returns integer language sql immutable
set search_path = pg_catalog, public
as $$ select case when p_engine >= 8 then 5 else 3 end $$;

create or replace function public._tactic_close_ms_v(p_seconds integer, p_window integer, p_engine integer)
returns bigint language sql immutable
set search_path = pg_catalog, public
as $$
  select p_seconds::bigint * (
    case when p_engine >= 8 then
      case p_window when 1 then 150 when 2 then 290 when 3 then 430 when 4 then 570 else 710 end
    else
      case p_window when 1 then 170 when 2 then 360 else 600 end
    end)
$$;

create or replace function public._tactic_open_ms_v(p_seconds integer, p_window integer, p_engine integer)
returns bigint language sql immutable
set search_path = pg_catalog, public
as $$
  select public._tactic_close_ms_v(p_seconds, p_window, p_engine)
       - case when p_engine >= 8 then least(6000, greatest(3000, p_seconds * 100))
              else least(6000, greatest(3500, p_seconds * 130)) end
$$;

-- 작전 선택 (창이 열려 있을 때만). 같은 창에서 다시 고르면 바꿔 씀.
create or replace function public.submit_tactic(p_token text, p_race_id uuid, p_window integer, p_tactic text)
returns json language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  v_no smallint;
  r    public.races;
  v_el bigint;
begin
  if p_window is null or p_window not between 1 and 5 or p_tactic is null or p_tactic not in ('SAVE', 'CHASE', 'SPRINT') then
    raise exception 'BAD_TACTIC';
  end if;
  select p.horse_no into v_no
    from public.participants p
    join public.participant_secrets s on s.participant_id = p.id
   where s.token_hash = public._token_hash(p_token);
  if v_no is null then
    raise exception 'NOT_JOINED';
  end if;
  select * into r from public.races where id = p_race_id;
  if r.id is null or r.engine_version < 4 or r.status not in ('racing', 'paused')
     or not exists (select 1 from public.game_state g where g.id = 1 and g.current_race_id = r.id)
     or not (r.entrants @> jsonb_build_array(jsonb_build_object('id', v_no))) then
    raise exception 'TACTIC_CLOSED';
  end if;
  if p_window > public._tactic_window_count(r.engine_version) then
    raise exception 'BAD_TACTIC';
  end if;
  v_el := public._race_elapsed_ms(r);
  if v_el < public._tactic_open_ms_v(r.race_seconds, p_window, r.engine_version)
     or v_el >= public._tactic_close_ms_v(r.race_seconds, p_window, r.engine_version) then
    raise exception 'TACTIC_CLOSED';
  end if;
  insert into public.race_tactics (race_id, horse_no, window_no, tactic)
  values (r.id, v_no, p_window, p_tactic)
  on conflict (race_id, horse_no, window_no) do update set tactic = excluded.tactic, updated_at = now();
  return json_build_object('window', p_window, 'tactic', p_tactic);
end $$;

-- 마감된 창의 작전 전체 (모든 화면이 같은 기록으로 계산). 마감 + 0.3초 지난 창만.
create or replace function public.get_race_tactics(p_race_id uuid)
returns json language sql stable security definer
set search_path = pg_catalog, public
as $$
  with r as (
    select x.*, public._race_elapsed_ms(x) as el from public.races x where x.id = p_race_id
  ), closed as (
    select w from r, generate_series(1, public._tactic_window_count(r.engine_version)) w
     where r.engine_version >= 4
       and (r.status in ('finished', 'aborted') or r.el >= public._tactic_close_ms_v(r.race_seconds, w, r.engine_version) + 300)
  )
  select json_build_object(
    'closed', coalesce((select json_agg(w order by w) from closed), '[]'::json),
    'tactics', coalesce((
      select json_agg(json_build_object('id', t.horse_no, 'window', t.window_no, 'tactic', t.tactic) order by t.window_no, t.horse_no)
        from public.race_tactics t
       where t.race_id = p_race_id and t.window_no in (select w from closed)
    ), '[]'::json)
  )
  from r
$$;

revoke all on function public.submit_tactic(text, uuid, integer, text), public.get_race_tactics(uuid) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'grant execute on function public.submit_tactic(text, uuid, integer, text), public.get_race_tactics(uuid) to anon, authenticated';
  end if;
end $$;
