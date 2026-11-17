-- ═══════════════════════════════════════════════════════════════════════
-- 붉은 말의 대질주 · 3단계: 서버 기준 경주 동기화 + 관리자 인증
--
-- 서버가 정하는 것 (어떤 브라우저도 바꿀 수 없음)
--  * 시드(난수) · 출전 명단(시작 순간 고정) · 경주 시간 · 시작 시각 · 일시정지 누적 시간
--  * 공식 결과: 관리자의 "결과 공개" 요청을 서버가 검증한 뒤 저장
-- 각 기기는 위 값으로 같은 결정론적 엔진을 돌려 같은 장면을 그린다.
--
-- 관리자 인증: 비밀번호(솔트 + SHA-256 5000회) → 12시간 세션 토큰. 5회 실패 시 60초 잠금.
-- 이 파일은 여러 번 실행해도 안전하다(멱등). 1단계 파일(…0001_lobby.sql) 다음에 실행.
-- ═══════════════════════════════════════════════════════════════════════

-- ─── 경주 ─────────────────────────────────────────────────────────────
create table if not exists public.races (
  id             uuid primary key default gen_random_uuid(),
  round_no       integer not null,
  seed           bigint  not null check (seed between 0 and 4294967295),
  entrants       jsonb   not null,          -- [{id: 말번호, name: 닉네임}] 게이트 순서
  race_seconds   smallint not null check (race_seconds between 30 and 180),
  engine_version integer not null,
  status         text not null default 'racing' check (status in ('racing', 'paused', 'finished', 'aborted')),
  start_at       timestamptz not null,
  paused_at      timestamptz,
  paused_ms      bigint not null default 0,
  result_hash    text,
  standings      jsonb,
  published_at   timestamptz,
  created_at     timestamptz not null default now()
);

alter table public.game_state add column if not exists current_race_id uuid;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'game_state_current_race_fk') then
    alter table public.game_state
      add constraint game_state_current_race_fk foreign key (current_race_id) references public.races (id) on delete set null;
  end if;
end $$;

-- 휴대폰이 보고한 결과 해시 (모든 기기가 같은 결과를 봤는지 확인용)
create table if not exists public.race_reports (
  race_id        uuid not null references public.races (id) on delete cascade,
  participant_id uuid not null references public.participants (id) on delete cascade,
  hash           text not null check (hash ~ '^[0-9a-f]{8}$'),
  engine_version integer not null,
  reported_at    timestamptz not null default now(),
  primary key (race_id, participant_id)
);

-- ─── 관리자 ───────────────────────────────────────────────────────────
create table if not exists public.admin_config (
  id            smallint primary key default 1 check (id = 1),
  salt          text not null,
  password_hash text not null,
  fail_count    integer not null default 0,
  locked_until  timestamptz,
  created_at    timestamptz not null default now()
);
create table if not exists public.admin_sessions (
  token_hash text primary key,
  expires_at timestamptz not null
);

-- ─── 권한 / RLS ───────────────────────────────────────────────────────
revoke all on public.races, public.race_reports, public.admin_config, public.admin_sessions from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.races, public.race_reports, public.admin_config, public.admin_sessions from anon, authenticated';
    execute 'grant select on public.races to anon, authenticated';
  end if;
end $$;
alter table public.races enable row level security;
alter table public.race_reports enable row level security;
alter table public.admin_config enable row level security;
alter table public.admin_sessions enable row level security;
drop policy if exists races_read on public.races;
create policy races_read on public.races for select using (true);

-- ─── 내부 헬퍼 ────────────────────────────────────────────────────────
create or replace function public._epoch_ms(p timestamptz)
returns bigint language sql immutable
set search_path = pg_catalog, public
as $$ select floor(extract(epoch from p) * 1000)::bigint $$;

create or replace function public._new_secret()
returns text language sql volatile
set search_path = pg_catalog, public
as $$ select encode(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid()), 'hex') $$;

create or replace function public._pw_hash(p_salt text, p_password text)
returns text language plpgsql immutable
set search_path = pg_catalog, public
as $$
declare
  h bytea := convert_to(p_salt || ':' || coalesce(p_password, ''), 'UTF8');
  s bytea := convert_to(p_salt, 'UTF8');
begin
  for i in 1..5000 loop
    h := sha256(h || s);
  end loop;
  return encode(h, 'hex');
end $$;

create or replace function public._admin_new_session()
returns json language plpgsql volatile
set search_path = pg_catalog, public
as $$
declare
  t   text := public._new_secret();
  exp timestamptz := now() + interval '12 hours';
begin
  delete from public.admin_sessions where expires_at < now();
  insert into public.admin_sessions (token_hash, expires_at) values (encode(sha256(convert_to(t, 'UTF8')), 'hex'), exp);
  return json_build_object('token', t, 'expires_at_ms', public._epoch_ms(exp));
end $$;

create or replace function public._admin_check(p_token text)
returns void language plpgsql stable
set search_path = pg_catalog, public
as $$
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' or not exists (
    select 1 from public.admin_sessions
     where token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex') and expires_at > now()
  ) then
    raise exception 'ADMIN_AUTH';
  end if;
end $$;

-- 경과 시간(ms). 음수 = 출발 전 카운트다운. 일시정지 중엔 멈춤.
create or replace function public._race_elapsed_ms(r public.races)
returns bigint language sql stable
set search_path = pg_catalog, public
as $$
  select public._epoch_ms(coalesce(r.paused_at, clock_timestamp())) - public._epoch_ms(r.start_at) - r.paused_ms
$$;

create or replace function public._race_meta(r public.races)
returns json language sql stable
set search_path = pg_catalog, public
as $$
  select json_build_object(
    'id', r.id,
    'round_no', r.round_no,
    'status', r.status,
    'start_at_ms', public._epoch_ms(r.start_at),
    'paused_at_ms', case when r.paused_at is null then null else public._epoch_ms(r.paused_at) end,
    'paused_ms', r.paused_ms,
    'published', r.standings is not null
  )
$$;

create or replace function public._race_full(p_id uuid)
returns json language sql stable
set search_path = pg_catalog, public
as $$
  select json_build_object(
    'id', r.id,
    'round_no', r.round_no,
    'seed', r.seed,
    'entrants', r.entrants,
    'race_seconds', r.race_seconds,
    'engine_version', r.engine_version,
    'status', r.status,
    'start_at_ms', public._epoch_ms(r.start_at),
    'paused_at_ms', case when r.paused_at is null then null else public._epoch_ms(r.paused_at) end,
    'paused_ms', r.paused_ms,
    'result_hash', r.result_hash,
    'standings', r.standings,
    'server_ms', public._epoch_ms(clock_timestamp())
  )
  from public.races r where r.id = p_id
$$;

-- 현재 경주 (잠금 포함). 없으면 NO_RACE
create or replace function public._current_race_for_update()
returns public.races language plpgsql volatile
set search_path = pg_catalog, public
as $$
declare
  g public.game_state;
  r public.races;
begin
  select * into g from public.game_state where id = 1 for update;
  if g.current_race_id is null then
    raise exception 'NO_RACE';
  end if;
  select * into r from public.races where id = g.current_race_id for update;
  return r;
end $$;

-- ─── 공개 RPC (누구나) ────────────────────────────────────────────────

-- 기기 시계 보정용. 가능한 한 가볍게.
create or replace function public.server_time()
returns bigint language sql volatile security definer
set search_path = pg_catalog, public
as $$ select public._epoch_ms(clock_timestamp()) $$;

-- 대기실 요약 + 현재 경주 상태(시드·명단 제외 → 가벼움). 휴대폰이 3초마다 조회.
create or replace function public.get_lobby()
returns json language sql stable security definer
set search_path = pg_catalog, public
as $$
  select json_build_object(
    'phase', g.phase,
    'count', (select count(*) from public.participants),
    'max_players', g.max_players,
    'race_seconds', g.race_seconds,
    'round_no', g.round_no,
    'server_time', clock_timestamp(),
    'server_ms', public._epoch_ms(clock_timestamp()),
    'race', (select public._race_meta(r) from public.races r where r.id = g.current_race_id)
  )
  from public.game_state g
  where g.id = 1
$$;

-- 경주 전체 정보 (시드·명단·공식 결과). 경주가 바뀔 때 한 번만 받는다.
create or replace function public.get_race(p_race_id uuid)
returns json language sql stable security definer
set search_path = pg_catalog, public
as $$ select public._race_full(p_race_id) $$;

-- 휴대폰이 경주 종료 후 자기가 계산한 결과 해시를 보고 (같은 결과를 봤는지 확인용)
create or replace function public.report_result(p_token text, p_race_id uuid, p_hash text, p_engine_version integer)
returns void language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  v_pid uuid;
  v_no  smallint;
begin
  if p_hash is null or p_hash !~ '^[0-9a-f]{8}$' or p_engine_version is null then
    return;
  end if;
  select p.id, p.horse_no into v_pid, v_no
    from public.participants p
    join public.participant_secrets s on s.participant_id = p.id
   where s.token_hash = public._token_hash(p_token);
  if v_pid is null then
    return;
  end if;
  if not exists (select 1 from public.races r
                  where r.id = p_race_id and r.entrants @> jsonb_build_array(jsonb_build_object('id', v_no))) then
    return;
  end if;
  insert into public.race_reports (race_id, participant_id, hash, engine_version)
  values (p_race_id, v_pid, p_hash, p_engine_version)
  on conflict (race_id, participant_id)
  do update set hash = excluded.hash, engine_version = excluded.engine_version, reported_at = now();
end $$;

-- ─── 관리자 인증 ──────────────────────────────────────────────────────

create or replace function public.admin_status()
returns json language sql stable security definer
set search_path = pg_catalog, public
as $$ select json_build_object('configured', exists (select 1 from public.admin_config)) $$;

-- 최초 1회: 관리자 비밀번호 설정 (이미 있으면 ALREADY_CONFIGURED)
-- 초기화가 필요하면 Supabase SQL Editor 에서: delete from admin_config;
create or replace function public.admin_bootstrap(p_password text)
returns json language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  v_salt text := public._new_secret();
  v_rows integer;
begin
  if p_password is null or char_length(p_password) < 8 or char_length(p_password) > 64 then
    raise exception 'WEAK_PASSWORD';
  end if;
  insert into public.admin_config (id, salt, password_hash)
  values (1, v_salt, public._pw_hash(v_salt, p_password))
  on conflict (id) do nothing;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'ALREADY_CONFIGURED';
  end if;
  return public._admin_new_session();
end $$;

-- 로그인. 실패 횟수를 저장해야 하므로 예외 대신 {error} 반환.
create or replace function public.admin_login(p_password text)
returns json language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  c public.admin_config;
begin
  select * into c from public.admin_config where id = 1 for update;
  if not found then
    return json_build_object('error', 'ADMIN_NOT_CONFIGURED');
  end if;
  if c.locked_until is not null and c.locked_until > now() then
    return json_build_object('error', 'ADMIN_LOCKED',
                             'retry_ms', public._epoch_ms(c.locked_until) - public._epoch_ms(now()));
  end if;
  if public._pw_hash(c.salt, p_password) <> c.password_hash then
    if c.fail_count + 1 >= 5 then
      update public.admin_config set fail_count = 0, locked_until = now() + interval '60 seconds' where id = 1;
    else
      update public.admin_config set fail_count = fail_count + 1 where id = 1;
    end if;
    return json_build_object('error', 'ADMIN_BAD_PASSWORD');
  end if;
  update public.admin_config set fail_count = 0, locked_until = null where id = 1;
  return public._admin_new_session();
end $$;

create or replace function public.admin_logout(p_token text)
returns void language sql volatile security definer
set search_path = pg_catalog, public
as $$ delete from public.admin_sessions where token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex') $$;

create or replace function public.admin_change_password(p_token text, p_new_password text)
returns void language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  v_salt text := public._new_secret();
begin
  perform public._admin_check(p_token);
  if p_new_password is null or char_length(p_new_password) < 8 or char_length(p_new_password) > 64 then
    raise exception 'WEAK_PASSWORD';
  end if;
  update public.admin_config set salt = v_salt, password_hash = public._pw_hash(v_salt, p_new_password) where id = 1;
  -- 다른 모든 세션 종료
  delete from public.admin_sessions where token_hash <> encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
end $$;

-- ─── 관리자: 대기실 ───────────────────────────────────────────────────

-- 참가 접수 열기/마감 (경주가 진행/표시 중이 아닐 때)
create or replace function public.admin_set_phase(p_token text, p_phase text)
returns void language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  g public.game_state;
begin
  perform public._admin_check(p_token);
  if p_phase not in ('lobby', 'closed') then
    raise exception 'BAD_STATE';
  end if;
  select * into g from public.game_state where id = 1 for update;
  if g.current_race_id is not null then
    raise exception 'RACE_ACTIVE';
  end if;
  update public.game_state set phase = p_phase, updated_at = now() where id = 1;
end $$;

-- 정원(1~50) · 경주 시간(30~180초). null 이면 그대로.
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
    if p_max_players not between 1 and 50 then
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

-- 테스트 모드: 가상 참가자 추가 (정원까지). 추가된 수 반환.
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
    insert into public.participants (horse_no, nickname, nickname_key)
    values (v_no, v_nick, public._nickname_key(v_nick)) returning id into v_pid;
    insert into public.participant_secrets (participant_id, token_hash, recovery_code)
    values (v_pid, encode(sha256(convert_to(public._new_secret(), 'UTF8')), 'hex'), public._new_recovery_code());
    v_added := v_added + 1;
  end loop;
  return v_added;
end $$;

-- 참가자 내보내기 (중복 참가·부적절 닉네임 대응). 경주 중엔 불가.
create or replace function public.admin_remove_participant(p_token text, p_horse_no integer)
returns void language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  g public.game_state;
begin
  perform public._admin_check(p_token);
  select * into g from public.game_state where id = 1 for update;
  if g.current_race_id is not null then
    raise exception 'RACE_ACTIVE';
  end if;
  delete from public.participants where horse_no = p_horse_no;
end $$;

-- ─── 관리자: 경주 진행 ────────────────────────────────────────────────

-- 경주 시작: 서버가 시드를 뽑고, 그 순간의 참가자로 명단을 고정하고, 카운트다운 후 출발 시각을 정한다.
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
begin
  perform public._admin_check(p_token);
  if p_engine_version is null or p_engine_version not between 1 and 1000 then
    raise exception 'BAD_SETTINGS';
  end if;
  select * into g from public.game_state where id = 1 for update;
  if g.current_race_id is not null then
    raise exception 'RACE_ACTIVE';
  end if;
  select jsonb_agg(jsonb_build_object('id', horse_no, 'name', nickname) order by horse_no)
    into v_ent from public.participants;
  if v_ent is null then
    raise exception 'NO_PARTICIPANTS';
  end if;
  v_seed := (get_byte(b, 0)::bigint << 24) | (get_byte(b, 1)::bigint << 16) | (get_byte(b, 2)::bigint << 8) | get_byte(b, 3)::bigint;

  insert into public.races (round_no, seed, entrants, race_seconds, engine_version, start_at)
  values (g.round_no, v_seed, v_ent, g.race_seconds, p_engine_version,
          clock_timestamp() + make_interval(secs => v_cd / 1000.0))
  returning id into v_id;

  update public.game_state set phase = 'racing', current_race_id = v_id, updated_at = now() where id = 1;
  return public._race_full(v_id);
end $$;

create or replace function public.admin_pause_race(p_token text)
returns json language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  r public.races;
begin
  perform public._admin_check(p_token);
  r := public._current_race_for_update();
  if r.status <> 'racing' then
    raise exception 'BAD_STATE';
  end if;
  update public.races set status = 'paused', paused_at = clock_timestamp() where id = r.id;
  update public.game_state set phase = 'paused', updated_at = now() where id = 1;
  return public._race_full(r.id);
end $$;

create or replace function public.admin_resume_race(p_token text)
returns json language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  r public.races;
begin
  perform public._admin_check(p_token);
  r := public._current_race_for_update();
  if r.status <> 'paused' then
    raise exception 'BAD_STATE';
  end if;
  update public.races
     set status = 'racing',
         paused_ms = paused_ms + (public._epoch_ms(clock_timestamp()) - public._epoch_ms(paused_at)),
         paused_at = null
   where id = r.id;
  update public.game_state set phase = 'racing', updated_at = now() where id = 1;
  return public._race_full(r.id);
end $$;

-- 결과 공개: 관리자 화면이 계산한 결과를 서버가 검증한 뒤 공식 기록으로 저장.
--  * 경주 시간이 충분히 지났는지 (설정 시간의 80% 이상)
--  * 같은 엔진 버전인지
--  * 순위표가 출전 명단과 정확히 일치하는지 (같은 번호들, 1..N 등수)
create or replace function public.admin_publish_result(
  p_token text, p_race_id uuid, p_engine_version integer, p_hash text, p_standings jsonb)
returns json language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  r      public.races;
  v_n    integer;
  v_ok   boolean;
begin
  perform public._admin_check(p_token);
  r := public._current_race_for_update();
  if r.id <> p_race_id then
    raise exception 'NO_RACE';
  end if;
  if r.status = 'finished' then
    if r.result_hash = p_hash then
      return public._race_full(r.id); -- 재시도 안전
    end if;
    raise exception 'BAD_STATE';
  end if;
  if r.status <> 'racing' then
    raise exception 'BAD_STATE';
  end if;
  if p_engine_version is distinct from r.engine_version then
    raise exception 'ENGINE_MISMATCH';
  end if;
  if public._race_elapsed_ms(r) < r.race_seconds * 800 then
    raise exception 'RACE_NOT_FINISHED';
  end if;
  if p_hash is null or p_hash !~ '^[0-9a-f]{8}$' then
    raise exception 'INVALID_STANDINGS';
  end if;

  v_n := jsonb_array_length(r.entrants);
  begin
    v_ok := jsonb_typeof(p_standings) = 'array'
      and jsonb_array_length(p_standings) = v_n
      and (select array_agg((e ->> 'id')::int order by (e ->> 'id')::int) from jsonb_array_elements(p_standings) e)
        = (select array_agg((e ->> 'id')::int order by (e ->> 'id')::int) from jsonb_array_elements(r.entrants) e)
      and (select array_agg((e ->> 'rank')::int order by (e ->> 'rank')::int) from jsonb_array_elements(p_standings) e)
        = (select array_agg(g order by g) from generate_series(1, v_n) g);
  exception when others then
    v_ok := false;
  end;
  if not coalesce(v_ok, false) then
    raise exception 'INVALID_STANDINGS';
  end if;

  update public.races
     set status = 'finished', result_hash = p_hash, standings = p_standings, published_at = now()
   where id = r.id;
  update public.game_state set phase = 'finished', updated_at = now() where id = 1;
  return public._race_full(r.id);
end $$;

-- 비상: 경주 중단 (기록은 남김, 결과 없음)
create or replace function public.admin_abort_race(p_token text)
returns void language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  r public.races;
begin
  perform public._admin_check(p_token);
  r := public._current_race_for_update();
  if r.status <> 'finished' then
    update public.races set status = 'aborted' where id = r.id;
  end if;
  update public.game_state set phase = 'closed', current_race_id = null, updated_at = now() where id = 1;
end $$;

-- 다음 라운드: 같은 참가자로 다시 (접수는 마감 상태 유지, 필요하면 관리자가 다시 열기)
create or replace function public.admin_next_round(p_token text)
returns void language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  r public.races;
begin
  perform public._admin_check(p_token);
  r := public._current_race_for_update();
  if r.status not in ('finished', 'aborted') then
    raise exception 'RACE_ACTIVE';
  end if;
  update public.game_state
     set phase = 'closed', current_race_id = null, round_no = round_no + 1, updated_at = now()
   where id = 1;
end $$;

-- 전체 초기화: 참가자 삭제, 1라운드부터, 접수 시작. (지난 경주 기록은 보관)
create or replace function public.admin_reset_all(p_token text)
returns void language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
begin
  perform public._admin_check(p_token);
  perform 1 from public.game_state where id = 1 for update;
  update public.races set status = 'aborted' where status in ('racing', 'paused');
  update public.game_state
     set phase = 'lobby', current_race_id = null, round_no = 1, updated_at = now()
   where id = 1;
  -- Supabase(pg_safeupdate)는 WHERE 없는 DELETE 를 거부하므로 명시
  delete from public.participants where true;
end $$;

-- 결과 일치 현황: 몇 대가 보고했고, 공식 결과와 같은 해시가 몇 대인지
create or replace function public.admin_race_report(p_token text)
returns json language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
declare
  g public.game_state;
  r public.races;
begin
  perform public._admin_check(p_token);
  select * into g from public.game_state where id = 1;
  if g.current_race_id is null then
    return null;
  end if;
  select * into r from public.races where id = g.current_race_id;
  return json_build_object(
    'entrants', jsonb_array_length(r.entrants),
    'reports', (select count(*) from public.race_reports where race_id = r.id),
    'official_hash', r.result_hash,
    'matching', (select count(*) from public.race_reports where race_id = r.id and hash = r.result_hash),
    'hashes', (select coalesce(json_object_agg(hash, n), '{}'::json)
                 from (select hash, count(*) n from public.race_reports where race_id = r.id group by hash) x)
  );
end $$;

-- 지난 경주 기록 (최근 순)
create or replace function public.admin_race_history(p_token text)
returns json language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
begin
  perform public._admin_check(p_token);
  return (select coalesce(json_agg(x order by x.created_at desc), '[]'::json) from (
    select id, round_no, status, seed, race_seconds, engine_version, result_hash,
           jsonb_array_length(entrants) as entrant_count,
           (standings -> 0 ->> 'name') as winner, (standings -> 1 ->> 'name') as runner_up,
           created_at, published_at
      from public.races order by created_at desc limit 50) x);
end $$;

-- ─── 함수 실행 권한 ───────────────────────────────────────────────────
do $$
declare
  f record;
begin
  -- 내부 헬퍼(_로 시작)는 아무도 직접 호출 불가
  for f in
    select p.oid::regprocedure as sig, p.proname
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and (p.proname like '\_%' or p.proname in (
         'server_time', 'get_lobby', 'get_race', 'report_result', 'admin_status', 'admin_bootstrap', 'admin_login',
         'admin_logout', 'admin_change_password', 'admin_set_phase', 'admin_update_settings', 'admin_add_bots',
         'admin_remove_participant', 'admin_start_race', 'admin_pause_race', 'admin_resume_race',
         'admin_publish_result', 'admin_abort_race', 'admin_next_round', 'admin_reset_all', 'admin_race_report',
         'admin_race_history'))
  loop
    execute format('revoke execute on function %s from public', f.sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      if f.proname like '\_%' then
        -- Supabase 기본 권한이 직접 부여했을 수도 있으므로 명시적으로 회수
        execute format('revoke execute on function %s from anon, authenticated', f.sig);
      else
        -- 공개/관리자 함수: 실행은 허용 (관리자 함수는 내부에서 세션 토큰 검사)
        execute format('grant execute on function %s to anon, authenticated', f.sig);
      end if;
    end if;
  end loop;
end $$;
