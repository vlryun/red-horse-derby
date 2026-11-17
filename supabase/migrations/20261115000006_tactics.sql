-- ═══════════════════════════════════════════════════════════════════════
-- 붉은 말의 대질주 · 경주 중 참가자 작전 (엔진 v4)
--
--  * 경주 중 세 번 작전 선택 창이 열린다. 창 시각은 경주 시간 설정만으로 정해짐
--    (src/engine/tactics.ts 의 tacticWindows 와 같은 정수 계산).
--  * 창이 열려 있는 동안(서버 시계 기준) 본인 말의 작전을 고르고 바꿀 수 있다.
--    (경주, 말, 창)마다 한 행 → 중복 요청·새로고침에도 마지막 선택 하나만 남는다.
--  * 마감 후에는 바꿀 수 없고, 마감 + 0.3초가 지난 창의 선택만 공개한다.
--    → 모든 화면이 같은 작전 기록으로 같은 경주를 계산 (적용은 마감 1초 뒤 틱).
--
-- 이 파일은 여러 번 실행해도 안전하다(멱등).
-- ═══════════════════════════════════════════════════════════════════════

create table if not exists public.race_tactics (
  race_id    uuid not null references public.races (id) on delete cascade,
  horse_no   smallint not null,
  window_no  smallint not null check (window_no between 1 and 3),
  tactic     text not null check (tactic in ('SAVE', 'CHASE', 'SPRINT')),
  updated_at timestamptz not null default now(),
  primary key (race_id, horse_no, window_no)
);
revoke all on public.race_tactics from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.race_tactics from anon, authenticated';
  end if;
end $$;
alter table public.race_tactics enable row level security;

-- 창 시각(ms, 경주 경과 기준): 길이 = clamp(초×130, 3500, 6000), 마감 = 초 × (170, 360, 600)
create or replace function public._tactic_close_ms(p_seconds integer, p_window integer)
returns bigint language sql immutable
set search_path = pg_catalog, public
as $$
  select p_seconds::bigint * (case p_window when 1 then 170 when 2 then 360 else 600 end)
$$;

create or replace function public._tactic_open_ms(p_seconds integer, p_window integer)
returns bigint language sql immutable
set search_path = pg_catalog, public
as $$
  select public._tactic_close_ms(p_seconds, p_window) - least(6000, greatest(3500, p_seconds * 130))
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
  if p_window is null or p_window not between 1 and 3 or p_tactic is null or p_tactic not in ('SAVE', 'CHASE', 'SPRINT') then
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
  v_el := public._race_elapsed_ms(r);
  if v_el < public._tactic_open_ms(r.race_seconds, p_window) or v_el >= public._tactic_close_ms(r.race_seconds, p_window) then
    raise exception 'TACTIC_CLOSED';
  end if;
  insert into public.race_tactics (race_id, horse_no, window_no, tactic)
  values (r.id, v_no, p_window, p_tactic)
  on conflict (race_id, horse_no, window_no) do update set tactic = excluded.tactic, updated_at = now();
  return json_build_object('window', p_window, 'tactic', p_tactic);
end $$;

-- 내 선택 (새로고침 후 복원용)
create or replace function public.get_my_tactics(p_token text, p_race_id uuid)
returns json language sql stable security definer
set search_path = pg_catalog, public
as $$
  select coalesce(json_agg(json_build_object('window', t.window_no, 'tactic', t.tactic) order by t.window_no), '[]'::json)
    from public.race_tactics t
    join public.participants p on p.horse_no = t.horse_no
    join public.participant_secrets s on s.participant_id = p.id
   where t.race_id = p_race_id and s.token_hash = public._token_hash(p_token)
$$;

-- 마감된 창의 작전 전체 (모든 화면이 같은 기록으로 계산). 마감 + 0.3초 지난 창만.
create or replace function public.get_race_tactics(p_race_id uuid)
returns json language sql stable security definer
set search_path = pg_catalog, public
as $$
  with r as (
    select x.*, public._race_elapsed_ms(x) as el from public.races x where x.id = p_race_id
  ), closed as (
    select w from r, generate_series(1, 3) w
     where r.engine_version >= 4
       and (r.status in ('finished', 'aborted') or r.el >= public._tactic_close_ms(r.race_seconds, w) + 300)
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

revoke all on function public.submit_tactic(text, uuid, integer, text),
                       public.get_my_tactics(text, uuid),
                       public.get_race_tactics(uuid) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'grant execute on function public.submit_tactic(text, uuid, integer, text), public.get_my_tactics(text, uuid), public.get_race_tactics(uuid) to anon, authenticated';
  end if;
end $$;
