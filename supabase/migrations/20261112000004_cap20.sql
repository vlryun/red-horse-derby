-- ═══════════════════════════════════════════════════════════════════════
-- 붉은 말의 대질주 · 정원 최대 20명 고정 (소융인의 밤 행사 기준)
--  * 관리자 설정에서 1~20명만 허용
--  * DB 규칙으로도 20명 초과 불가 (SQL 로 직접 바꿔도 거부)
-- 여러 번 실행해도 안전(멱등). 0001~0003 다음에 실행.
-- ═══════════════════════════════════════════════════════════════════════

update public.game_state set max_players = 20 where id = 1 and max_players > 20;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'game_state_max_players_20') then
    alter table public.game_state add constraint game_state_max_players_20 check (max_players between 1 and 20);
  end if;
end $$;

-- 정원(1~20) · 경주 시간(30~180초). null 이면 그대로.
create or replace function public.admin_update_settings(p_token text, p_max_players integer, p_race_seconds integer)
returns void language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  v_count integer;
begin
  perform public._admin_check(p_token);
  perform 1 from public.game_state where id = 1 for update;
  if p_max_players is not null then
    if p_max_players not between 1 and 20 then
      raise exception 'BAD_SETTINGS';
    end if;
    select count(*) into v_count from public.participants;
    if p_max_players < v_count then
      raise exception 'BELOW_COUNT';
    end if;
  end if;
  if p_race_seconds is not null and p_race_seconds not between 30 and 180 then
    raise exception 'BAD_SETTINGS';
  end if;
  update public.game_state
     set max_players  = coalesce(p_max_players, max_players),
         race_seconds = coalesce(p_race_seconds, race_seconds),
         updated_at   = now()
   where id = 1;
end $$;
