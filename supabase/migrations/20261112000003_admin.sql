-- ═══════════════════════════════════════════════════════════════════════
-- 붉은 말의 대질주 · 4단계: 관리자 기능 확장
--  * 테스트봇/리허설 구분 (is_test) → "테스트봇만 삭제", 기록에 리허설 표시
--  * 참가자 접속 상태 (휴대폰이 30초마다 get_me 로 남기는 last_seen_at 기준, 추가 부하 없음)
--  * 현장 지원: 복구코드 확인 · 복구 잠금 해제
--  * 경주 기록 상세 (전체 순위 · 결과 일치 현황)
-- 여러 번 실행해도 안전(멱등). 0001, 0002 다음에 실행.
-- ═══════════════════════════════════════════════════════════════════════

alter table public.participants add column if not exists is_test boolean not null default false;
alter table public.races add column if not exists is_test boolean not null default false;

-- 기존 테스트봇 표시 (이 파일 적용 전에 만들어진 봇)
update public.participants set is_test = true where nickname like '테스트봇%' and is_test = false;

-- ─── 테스트봇: is_test 로 표시 ────────────────────────────────────────
create or replace function public.admin_add_bots(p_token text, p_count integer)
returns integer language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  g       public.game_state;
  v_room  integer;
  v_added integer := 0;
  v_no    smallint;
  v_nick  text;
  v_k     integer := 1;
  v_pid   uuid;
begin
  perform public._admin_check(p_token);
  select * into g from public.game_state where id = 1 for update;
  if g.current_race_id is not null then
    raise exception 'RACE_ACTIVE';
  end if;
  select g.max_players - count(*) into v_room from public.participants;
  for i in 1..least(greatest(coalesce(p_count, 0), 0), greatest(v_room, 0)) loop
    select min(n)::smallint into v_no from generate_series(1, 50) n
     where not exists (select 1 from public.participants where horse_no = n);
    exit when v_no is null;
    loop
      v_nick := '테스트봇' || v_k;
      v_k := v_k + 1;
      exit when not exists (select 1 from public.participants where nickname_key = public._nickname_key(v_nick));
    end loop;
    insert into public.participants (horse_no, nickname, nickname_key, is_test)
    values (v_no, v_nick, public._nickname_key(v_nick), true) returning id into v_pid;
    insert into public.participant_secrets (participant_id, token_hash, recovery_code)
    values (v_pid, encode(sha256(convert_to(public._new_secret(), 'UTF8')), 'hex'), public._new_recovery_code());
    v_added := v_added + 1;
  end loop;
  return v_added;
end $$;

-- 테스트봇만 삭제 (실제 참가자는 유지). 삭제한 수 반환.
create or replace function public.admin_remove_bots(p_token text)
returns integer language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  g public.game_state;
  v_n integer;
begin
  perform public._admin_check(p_token);
  select * into g from public.game_state where id = 1 for update;
  if g.current_race_id is not null then
    raise exception 'RACE_ACTIVE';
  end if;
  delete from public.participants where is_test;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- ─── 경주 시작: 리허설(전원 테스트봇) 여부 기록 ──────────────────────
create or replace function public.admin_start_race(p_token text, p_engine_version integer, p_countdown_ms integer)
returns json language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  g        public.game_state;
  b        bytea := uuid_send(gen_random_uuid());
  v_seed   bigint;
  v_id     uuid;
  v_cd     integer := least(greatest(coalesce(p_countdown_ms, 5000), 3000), 15000);
  v_ent    jsonb;
  v_test   boolean;
begin
  perform public._admin_check(p_token);
  if p_engine_version is null or p_engine_version not between 1 and 1000 then
    raise exception 'BAD_SETTINGS';
  end if;
  select * into g from public.game_state where id = 1 for update;
  if g.current_race_id is not null then
    raise exception 'RACE_ACTIVE';
  end if;
  select jsonb_agg(jsonb_build_object('id', horse_no, 'name', nickname) order by horse_no), bool_and(is_test)
    into v_ent, v_test from public.participants;
  if v_ent is null then
    raise exception 'NO_PARTICIPANTS';
  end if;
  v_seed := (get_byte(b, 0)::bigint << 24) | (get_byte(b, 1)::bigint << 16) | (get_byte(b, 2)::bigint << 8) | get_byte(b, 3)::bigint;

  insert into public.races (round_no, seed, entrants, race_seconds, engine_version, start_at, is_test)
  values (g.round_no, v_seed, v_ent, g.race_seconds, p_engine_version,
          clock_timestamp() + make_interval(secs => v_cd / 1000.0), coalesce(v_test, false))
  returning id into v_id;

  update public.game_state set phase = 'racing', current_race_id = v_id, updated_at = now() where id = 1;
  return public._race_full(v_id);
end $$;

-- ─── 참가자 관리 ──────────────────────────────────────────────────────

-- 관리자용 참가자 목록: 접속 상태 · 테스트봇 여부 · 복구코드/실패 횟수
-- online = 최근 75초 안에 휴대폰이 확인 요청을 보냄 (휴대폰은 30초마다 보냄)
create or replace function public.admin_participants(p_token text)
returns json language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
begin
  perform public._admin_check(p_token);
  return (select coalesce(json_agg(x order by x.horse_no), '[]'::json) from (
    select p.id, p.horse_no, p.nickname, p.is_test,
           s.recovery_code, s.recovery_fails,
           public._epoch_ms(s.last_seen_at) as last_seen_ms,
           (not p.is_test and s.last_seen_at > now() - interval '75 seconds') as online,
           public._epoch_ms(p.created_at) as created_ms
      from public.participants p
      join public.participant_secrets s on s.participant_id = p.id) x);
end $$;

-- 복구 잠금 해제 (5회 실패로 잠긴 참가자)
create or replace function public.admin_unlock_recovery(p_token text, p_horse_no integer)
returns void language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
begin
  perform public._admin_check(p_token);
  update public.participant_secrets s set recovery_fails = 0
    from public.participants p
   where p.id = s.participant_id and p.horse_no = p_horse_no;
end $$;

-- ─── 기록 ─────────────────────────────────────────────────────────────

create or replace function public.admin_race_history(p_token text)
returns json language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
begin
  perform public._admin_check(p_token);
  return (select coalesce(json_agg(x order by x.created_at desc), '[]'::json) from (
    select id, round_no, status, seed, race_seconds, engine_version, result_hash, is_test,
           jsonb_array_length(entrants) as entrant_count,
           (standings -> 0 ->> 'name') as winner, (standings -> 1 ->> 'name') as runner_up,
           created_at, published_at
      from public.races order by created_at desc limit 100) x);
end $$;

-- 경주 상세: 전체 정보 + 결과 일치 현황
create or replace function public.admin_race_detail(p_token text, p_race_id uuid)
returns json language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
declare
  r public.races;
begin
  perform public._admin_check(p_token);
  select * into r from public.races where id = p_race_id;
  if not found then
    raise exception 'NO_RACE';
  end if;
  return json_build_object(
    'race', public._race_full(r.id),
    'is_test', r.is_test,
    'created_ms', public._epoch_ms(r.created_at),
    'published_ms', case when r.published_at is null then null else public._epoch_ms(r.published_at) end,
    'reports', (select count(*) from public.race_reports where race_id = r.id),
    'matching', (select count(*) from public.race_reports where race_id = r.id and hash = r.result_hash)
  );
end $$;

-- ─── 함수 실행 권한 ───────────────────────────────────────────────────
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('admin_add_bots', 'admin_remove_bots', 'admin_start_race', 'admin_participants',
                         'admin_unlock_recovery', 'admin_race_history', 'admin_race_detail')
  loop
    execute format('revoke execute on function %s from public', f.sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('grant execute on function %s to anon, authenticated', f.sig);
    end if;
  end loop;
end $$;

-- ─── 행사 설정: 정원 20명 (2026-11-12 결정) ───────────────────────────
-- 시스템은 1~50명을 지원하며, 관리자 화면 "설정"에서 언제든 바꿀 수 있다.
-- 아직 기본값(50)일 때만 20으로 바꿔서, 나중에 관리자가 정한 값을 다시 실행해도 덮어쓰지 않는다.
alter table public.game_state alter column max_players set default 20;
update public.game_state set max_players = 20
 where id = 1 and max_players = 50 and (select count(*) from public.participants) <= 20;
