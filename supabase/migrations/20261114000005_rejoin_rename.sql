-- ═══════════════════════════════════════════════════════════════════════
-- 붉은 말의 대질주 · 내보낸 참가자 재참가 + 경주 전 닉네임 변경
--
--  1) 진행자가 "내보내기" 한 기기는 기록해 두고, 그 기기는 참가 접수가 마감된 상태에서도
--     (정원이 남아 있으면) 다시 참가할 수 있다. 다음 경주부터 출전.
--     전체 초기화로 지워진 기기는 해당 없음 (새 행사로 보고 일반 접수 규칙).
--  2) 참가자는 경주가 진행 중이 아닐 때(대기실·마감·라운드 사이) 닉네임을 바꿀 수 있다.
--     번호·복구코드는 그대로. 같은 닉네임이 있으면 기존처럼 뒤에 숫자를 붙인다.
--
-- 이 파일은 여러 번 실행해도 안전하다(멱등).
-- ═══════════════════════════════════════════════════════════════════════

-- ─── 내보낸 기기 기록 (비공개) ─────────────────────────────────────────
create table if not exists public.kicked_tokens (
  token_hash text primary key,
  kicked_at  timestamptz not null default now()
);
revoke all on public.kicked_tokens from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.kicked_tokens from anon, authenticated';
  end if;
end $$;
alter table public.kicked_tokens enable row level security;

-- ─── 내보내기: 지우기 전에 그 기기를 "재참가 가능"으로 기록 ─────────────
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
  insert into public.kicked_tokens (token_hash)
  select s.token_hash
    from public.participant_secrets s
    join public.participants p on p.id = s.participant_id
   where p.horse_no = p_horse_no
  on conflict (token_hash) do update set kicked_at = now();
  delete from public.participants where horse_no = p_horse_no;
end $$;

-- ─── 참가: 내보낸 기기는 마감 중에도 재참가 허용 ─────────────────────────
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
  v_kicked  boolean;
begin
  select participant_id into v_pid from public.participant_secrets where token_hash = v_hash;
  if found then
    return public._participant_json(v_pid, false);
  end if;

  v_base := public._normalize_nickname(p_nickname);

  -- 직렬화: 동시에 여러 명이 눌러도 번호/정원 계산이 겹치지 않도록 상태 행 잠금
  select * into v_state from public.game_state where id = 1 for update;

  select participant_id into v_pid from public.participant_secrets where token_hash = v_hash;
  if found then
    return public._participant_json(v_pid, false);
  end if;

  v_kicked := exists (select 1 from public.kicked_tokens where token_hash = v_hash);
  if v_state.phase <> 'lobby' and not v_kicked then
    raise exception 'REGISTRATION_CLOSED';
  end if;

  select count(*) into v_count from public.participants;
  if v_count >= v_state.max_players then
    raise exception 'FULL';
  end if;

  v_nick := v_base;
  loop
    v_key := public._nickname_key(v_nick);
    exit when not exists (select 1 from public.participants where nickname_key = v_key);
    v_suffix := v_suffix + 1;
    v_nick := left(v_base, 12 - char_length(v_suffix::text)) || v_suffix::text;
  end loop;

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

  delete from public.kicked_tokens where token_hash = v_hash;

  -- 주의: 여기서 game_state 를 UPDATE 하지 말 것 (휴대폰들이 game_state 를 실시간 구독)
  return public._participant_json(v_pid, v_nick <> v_base);
end $$;

-- ─── 이 기기가 내보내진 기기인지 (재참가 안내용, 공개 정보 아님 → 본인 토큰으로만) ───
create or replace function public.can_rejoin(p_token text)
returns boolean
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select exists (select 1 from public.kicked_tokens where token_hash = public._token_hash(p_token))
$$;

-- ─── 닉네임 변경: 경주 진행 중(시작~결과 정리 전)이 아닐 때만 ───────────
create or replace function public.rename_participant(p_token text, p_nickname text)
returns json
language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  v_hash   text := public._token_hash(p_token);
  v_state  public.game_state;
  v_pid    uuid;
  v_base   text;
  v_nick   text;
  v_key    text;
  v_suffix integer := 1;
begin
  v_base := public._normalize_nickname(p_nickname);
  select * into v_state from public.game_state where id = 1 for update;
  select participant_id into v_pid from public.participant_secrets where token_hash = v_hash;
  if not found then
    raise exception 'NOT_JOINED';
  end if;
  if v_state.current_race_id is not null then
    raise exception 'NAME_LOCKED';
  end if;

  v_nick := v_base;
  loop
    v_key := public._nickname_key(v_nick);
    exit when not exists (select 1 from public.participants where nickname_key = v_key and id <> v_pid);
    v_suffix := v_suffix + 1;
    v_nick := left(v_base, 12 - char_length(v_suffix::text)) || v_suffix::text;
  end loop;

  update public.participants set nickname = v_nick, nickname_key = v_key where id = v_pid;
  return public._participant_json(v_pid, v_nick <> v_base);
end $$;

-- 전체 초기화 때 내보내기 기록도 비움 (새 행사)
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
  delete from public.kicked_tokens where true;
end $$;

revoke all on function public.can_rejoin(text), public.rename_participant(text, text) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'grant execute on function public.can_rejoin(text), public.rename_participant(text, text) to anon, authenticated';
  end if;
end $$;
