-- ═══════════════════════════════════════════════════════════════════════
-- 붉은 말의 대질주 · 2단계: 참가자 / 대기실
--
-- 보안 모델
--  * 참가자는 Supabase Auth 를 쓰지 않는다. (익명 로그인은 IP당 시간 제한이 있어
--    행사장 Wi-Fi 하나로 50명이 몰리면 막힐 수 있음)
--  * 각 기기가 만든 비밀 토큰(64자리 hex)의 SHA-256 해시만 서버에 저장한다.
--  * 테이블 쓰기 권한은 아무에게도 없다. 모든 변경은 아래 SECURITY DEFINER 함수로만,
--    서버에서 검증된 뒤에 일어난다.
--  * 공개 정보(번호·닉네임·게임 단계)만 SELECT 가능. 토큰/복구코드 테이블은 완전 비공개.
--
-- 이 파일은 여러 번 실행해도 안전하다(멱등).
-- ═══════════════════════════════════════════════════════════════════════

-- ─── 게임 상태 (단일 행) ───────────────────────────────────────────────
create table if not exists public.game_state (
  id           smallint primary key default 1 check (id = 1),
  phase        text not null default 'lobby'
               check (phase in ('lobby', 'closed', 'countdown', 'racing', 'paused', 'finished')),
  max_players  smallint not null default 50 check (max_players between 1 and 50),
  race_seconds smallint not null default 70 check (race_seconds between 30 and 180),
  round_no     integer  not null default 1 check (round_no >= 1),
  updated_at   timestamptz not null default now()
);
insert into public.game_state (id) values (1) on conflict (id) do nothing;

-- ─── 참가자 (공개 정보) ───────────────────────────────────────────────
create table if not exists public.participants (
  id           uuid primary key default gen_random_uuid(),
  horse_no     smallint not null unique check (horse_no between 1 and 50),
  nickname     text not null check (char_length(nickname) between 1 and 12),
  -- 중복 판정 키 (대소문자/공백 무시). unique 제약 = 최후 방어선
  nickname_key text not null unique,
  created_at   timestamptz not null default now()
);

-- ─── 참가자 비밀 정보 (비공개) ─────────────────────────────────────────
create table if not exists public.participant_secrets (
  participant_id uuid primary key references public.participants (id) on delete cascade,
  token_hash     text not null unique,
  recovery_code  text not null,
  recovery_fails smallint not null default 0,
  last_seen_at   timestamptz not null default now()
);

-- ─── 권한 / RLS ───────────────────────────────────────────────────────
-- Supabase 는 public 스키마 새 테이블에 anon/authenticated 권한을 기본 부여하므로 명시적으로 회수
revoke all on public.game_state, public.participants, public.participant_secrets from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.game_state, public.participants, public.participant_secrets from anon, authenticated';
    execute 'grant select on public.game_state, public.participants to anon, authenticated';
  end if;
end $$;

alter table public.game_state enable row level security;
alter table public.participants enable row level security;
alter table public.participant_secrets enable row level security;

drop policy if exists game_state_read on public.game_state;
create policy game_state_read on public.game_state for select using (true);
drop policy if exists participants_read on public.participants;
create policy participants_read on public.participants for select using (true);
-- participant_secrets: 정책 없음 = 아무도 직접 접근 불가

-- ─── 내부 헬퍼 ────────────────────────────────────────────────────────
create or replace function public._token_hash(p_token text)
returns text
language plpgsql immutable
set search_path = pg_catalog, public
as $$
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_TOKEN';
  end if;
  return encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
end $$;

-- 닉네임 정규화: NFC, 앞뒤 공백 제거, 연속 공백 1칸, 1~10자, 허용 문자만
-- (클라이언트 src/lib/nickname.ts 와 반드시 같은 규칙)
create or replace function public._normalize_nickname(p_nickname text)
returns text
language plpgsql immutable
set search_path = pg_catalog, public
as $$
declare
  v text;
begin
  if p_nickname is null then
    raise exception 'INVALID_NICKNAME';
  end if;
  v := regexp_replace(btrim(normalize(p_nickname, NFC)), '\s+', ' ', 'g');
  if char_length(v) < 1 or char_length(v) > 10 then
    raise exception 'INVALID_NICKNAME';
  end if;
  if v !~ '^[가-힣ㄱ-ㅎㅏ-ㅣA-Za-z0-9 _.!?~-]+$' then
    raise exception 'INVALID_NICKNAME';
  end if;
  return v;
end $$;

create or replace function public._nickname_key(p_nickname text)
returns text
language sql immutable
set search_path = pg_catalog, public
as $$ select lower(replace(p_nickname, ' ', '')) $$;

-- 복구 코드 6자리 (헷갈리는 0/O/1/I 제외한 32자). gen_random_uuid 의 난수 바이트 사용 (확장 불필요)
create or replace function public._new_recovery_code()
returns text
language plpgsql volatile
set search_path = pg_catalog, public
as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  b bytea := uuid_send(gen_random_uuid());
  code text := '';
begin
  for i in 0..5 loop
    code := code || substr(alphabet, (get_byte(b, i) % 32) + 1, 1);
  end loop;
  return code;
end $$;

create or replace function public._participant_json(p_id uuid, p_renamed boolean)
returns json
language sql stable
set search_path = pg_catalog, public
as $$
  select json_build_object(
    'id', p.id,
    'horse_no', p.horse_no,
    'nickname', p.nickname,
    'recovery_code', s.recovery_code,
    'renamed', p_renamed
  )
  from public.participants p
  join public.participant_secrets s on s.participant_id = p.id
  where p.id = p_id
$$;

-- ─── 공개 RPC ─────────────────────────────────────────────────────────

-- 참가 신청.
-- 같은 토큰으로 다시 호출하면 기존 참가 정보를 그대로 돌려준다(멱등)
--  → 새로고침, 버튼 연타, 네트워크 타임아웃 후 재시도 모두 안전.
-- 오류: INVALID_TOKEN / INVALID_NICKNAME / REGISTRATION_CLOSED / FULL
create or replace function public.join_game(p_token text, p_nickname text)
returns json
language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  v_hash    text := public._token_hash(p_token);
  v_state   public.game_state;
  v_pid     uuid;
  v_base    text;
  v_nick    text;
  v_key     text;
  v_suffix  integer := 1;
  v_no      smallint;
  v_count   integer;
begin
  select participant_id into v_pid from public.participant_secrets where token_hash = v_hash;
  if found then
    return public._participant_json(v_pid, false);
  end if;

  v_base := public._normalize_nickname(p_nickname);

  -- 직렬화: 동시에 50명이 눌러도 번호/정원 계산이 겹치지 않도록 상태 행 잠금
  select * into v_state from public.game_state where id = 1 for update;

  -- 잠금 대기 중 같은 토큰의 다른 요청이 먼저 끝났을 수 있으므로 재확인
  select participant_id into v_pid from public.participant_secrets where token_hash = v_hash;
  if found then
    return public._participant_json(v_pid, false);
  end if;

  if v_state.phase <> 'lobby' then
    raise exception 'REGISTRATION_CLOSED';
  end if;

  select count(*) into v_count from public.participants;
  if v_count >= v_state.max_players then
    raise exception 'FULL';
  end if;

  -- 중복 닉네임 → 뒤에 번호를 붙인다 (민수 → 민수2 → 민수3 …)
  v_nick := v_base;
  loop
    v_key := public._nickname_key(v_nick);
    exit when not exists (select 1 from public.participants where nickname_key = v_key);
    v_suffix := v_suffix + 1;
    v_nick := left(v_base, 12 - char_length(v_suffix::text)) || v_suffix::text;
  end loop;

  -- 가장 작은 빈 번호 배정
  select min(g)::smallint into v_no
  from generate_series(1, 50) as g
  where not exists (select 1 from public.participants where horse_no = g);
  if v_no is null then
    raise exception 'FULL';
  end if;

  insert into public.participants (horse_no, nickname, nickname_key)
  values (v_no, v_nick, v_key)
  returning id into v_pid;

  insert into public.participant_secrets (participant_id, token_hash, recovery_code)
  values (v_pid, v_hash, public._new_recovery_code());

  -- 주의: 여기서 game_state 를 UPDATE 하지 말 것.
  -- 휴대폰 50대가 game_state 를 실시간 구독하므로 참가 1건마다 메시지 50개가 퍼진다.

  return public._participant_json(v_pid, v_nick <> v_base);
end $$;

-- 내 참가 정보 (없으면 null). 접속 시각 기록.
create or replace function public.get_me(p_token text)
returns json
language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  v_pid uuid;
begin
  update public.participant_secrets
     set last_seen_at = now()
   where token_hash = public._token_hash(p_token)
  returning participant_id into v_pid;
  if v_pid is null then
    return null;
  end if;
  return public._participant_json(v_pid, false);
end $$;

-- 참가 취소 (참가 접수 중에만). 닉네임 오타 수정용.
create or replace function public.leave_game(p_token text)
returns void
language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  v_hash  text := public._token_hash(p_token);
  v_phase text;
begin
  select phase into v_phase from public.game_state where id = 1 for update;
  if v_phase <> 'lobby' then
    raise exception 'REGISTRATION_CLOSED';
  end if;
  delete from public.participants p
   using public.participant_secrets s
   where s.participant_id = p.id and s.token_hash = v_hash;
end $$;

-- 다른 브라우저로 이동 (카톡 인앱 브라우저 → 크롬 등): 번호 + 복구코드로 이 기기에 다시 연결.
-- 실패 횟수를 기록해야 하므로 예외 대신 {error} 를 반환한다(예외는 UPDATE 를 롤백시킴).
-- 반환: 참가자 JSON 또는 {"error": "RECOVERY_FAILED" | "RECOVERY_LOCKED" | "ALREADY_JOINED"}
create or replace function public.recover_participant(p_horse_no integer, p_code text, p_token text)
returns json
language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  v_hash text := public._token_hash(p_token);
  v_sec  public.participant_secrets;
  v_mine uuid;
begin
  if p_horse_no is null or p_horse_no not between 1 and 50 or p_code is null or char_length(p_code) > 20 then
    return json_build_object('error', 'RECOVERY_FAILED');
  end if;

  select participant_id into v_mine from public.participant_secrets where token_hash = v_hash;

  select s.* into v_sec
    from public.participant_secrets s
    join public.participants p on p.id = s.participant_id
   where p.horse_no = p_horse_no
     for update of s;
  if not found then
    return json_build_object('error', 'RECOVERY_FAILED');
  end if;
  if v_mine is not null then
    if v_mine = v_sec.participant_id then
      return public._participant_json(v_mine, false);
    end if;
    return json_build_object('error', 'ALREADY_JOINED');
  end if;
  if v_sec.recovery_fails >= 5 then
    return json_build_object('error', 'RECOVERY_LOCKED');
  end if;
  if upper(btrim(p_code)) <> v_sec.recovery_code then
    update public.participant_secrets
       set recovery_fails = recovery_fails + 1
     where participant_id = v_sec.participant_id;
    return json_build_object('error', 'RECOVERY_FAILED');
  end if;

  -- 성공: 토큰 교체 (이전 기기는 자동으로 연결 해제됨)
  update public.participant_secrets
     set token_hash = v_hash, recovery_fails = 0, last_seen_at = now()
   where participant_id = v_sec.participant_id;
  return public._participant_json(v_sec.participant_id, false);
end $$;

-- 대기실 요약 (휴대폰이 주기적으로 조회. 가볍게 유지)
-- server_time: 3단계에서 기기 시계 보정에 사용
create or replace function public.get_lobby()
returns json
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select json_build_object(
    'phase', g.phase,
    'count', (select count(*) from public.participants),
    'max_players', g.max_players,
    'race_seconds', g.race_seconds,
    'round_no', g.round_no,
    'server_time', now()
  )
  from public.game_state g
  where g.id = 1
$$;

-- ─── 함수 실행 권한 ───────────────────────────────────────────────────
revoke execute on function public._token_hash(text) from public;
revoke execute on function public._normalize_nickname(text) from public;
revoke execute on function public._nickname_key(text) from public;
revoke execute on function public._new_recovery_code() from public;
revoke execute on function public._participant_json(uuid, boolean) from public;
revoke execute on function public.join_game(text, text) from public;
revoke execute on function public.get_me(text) from public;
revoke execute on function public.leave_game(text) from public;
revoke execute on function public.recover_participant(integer, text, text) from public;
revoke execute on function public.get_lobby() from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'grant execute on function public.join_game(text, text) to anon, authenticated';
    execute 'grant execute on function public.get_me(text) to anon, authenticated';
    execute 'grant execute on function public.leave_game(text) to anon, authenticated';
    execute 'grant execute on function public.recover_participant(integer, text, text) to anon, authenticated';
    execute 'grant execute on function public.get_lobby() to anon, authenticated';
  end if;
end $$;

-- ─── 실시간 구독 (Supabase Realtime) ──────────────────────────────────
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'participants') then
      execute 'alter publication supabase_realtime add table public.participants';
    end if;
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'game_state') then
      execute 'alter publication supabase_realtime add table public.game_state';
    end if;
  end if;
end $$;
