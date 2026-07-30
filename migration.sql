-- ═══════════════════════════════════════════════════════════════
--  UroLink CRM — Supabase 스키마
--  Supabase 대시보드 → SQL Editor 에 전체 붙여넣고 1회 실행.
--  여러 번 실행해도 안전합니다(idempotent).
-- ═══════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────
-- 1. 프로필 (역할)
--    auth.users 1건 = ul_profiles 1건. role 은 'admin' 또는 'user'.
-- ───────────────────────────────────────────────────────────────
create table if not exists ul_profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text,
  display_name text,
  role         text not null default 'user' check (role in ('admin','user')),
  created_at   timestamptz not null default now()
);

-- 계정이 만들어지면 프로필을 자동 생성 (관리자가 Supabase 대시보드에서 계정 추가 → 즉시 로그인 가능)
create or replace function ul_on_auth_user_created()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into ul_profiles (id, email, display_name)
  values (new.id, new.email, split_part(coalesce(new.email, ''), '@', 1))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists ul_auth_user_created on auth.users;
create trigger ul_auth_user_created
  after insert on auth.users
  for each row execute function ul_on_auth_user_created();

-- 관리자 판별. security definer 라서 RLS 재귀에 걸리지 않습니다.
create or replace function ul_is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select coalesce((select role = 'admin' from ul_profiles where id = auth.uid()), false);
$$;

-- 일반 사용자가 스스로 role 을 admin 으로 바꾸는 것을 차단
-- (RLS 는 컬럼 단위 제한이 안 되므로 트리거로 막습니다)
create or replace function ul_guard_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role is distinct from old.role and not ul_is_admin() then
    raise exception '역할 변경 권한이 없습니다';
  end if;
  return new;
end $$;

drop trigger if exists ul_profiles_guard on ul_profiles;
create trigger ul_profiles_guard
  before update on ul_profiles
  for each row execute function ul_guard_role();

alter table ul_profiles enable row level security;

drop policy if exists ul_prof_read   on ul_profiles;
drop policy if exists ul_prof_update on ul_profiles;
drop policy if exists ul_prof_delete on ul_profiles;

-- 로그인한 사람은 구성원 목록을 볼 수 있음 (담당자 표시용)
create policy ul_prof_read on ul_profiles
  for select to authenticated using (true);
-- 본인 정보는 본인이, 남의 정보는 관리자만 수정 (role 변경은 위 트리거가 추가로 막음)
create policy ul_prof_update on ul_profiles
  for update to authenticated
  using (id = auth.uid() or ul_is_admin())
  with check (id = auth.uid() or ul_is_admin());
create policy ul_prof_delete on ul_profiles
  for delete to authenticated using (ul_is_admin());


-- ───────────────────────────────────────────────────────────────
-- 2. 데이터 테이블 8종
--    id(text) + data(jsonb) 구조. 앱의 객체를 그대로 data 에 넣습니다.
--    → 필드를 추가해도 스키마 변경(마이그레이션)이 필요 없습니다.
--    한 행 = 한 건이라 여러 명이 동시에 써도 서로의 데이터를 덮지 않습니다.
--
--    ul_products  의 id = 제품코드
--    ul_reps      의 id = 담당자 이름
--    그 외        의 id = 앱이 만든 고유 id
-- ───────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'ul_customers','ul_deals','ul_logs','ul_quotes',
    'ul_equipments','ul_products','ul_schedules','ul_reps'
  ]
  loop
    execute format($f$
      create table if not exists %I (
        id         text primary key,
        data       jsonb not null,
        updated_at timestamptz not null default now(),
        updated_by uuid references auth.users(id) on delete set null
      )$f$, t);

    execute format('alter table %I enable row level security', t);

    execute format('drop policy if exists ul_read   on %I', t);
    execute format('drop policy if exists ul_insert on %I', t);
    execute format('drop policy if exists ul_update on %I', t);
    execute format('drop policy if exists ul_delete on %I', t);

    -- 로그인한 사람: 조회 · 추가 · 수정 전부 허용
    execute format('create policy ul_read   on %I for select to authenticated using (true)', t);
    execute format('create policy ul_insert on %I for insert to authenticated with check (true)', t);
    execute format('create policy ul_update on %I for update to authenticated using (true) with check (true)', t);
    -- 삭제는 관리자만
    execute format('create policy ul_delete on %I for delete to authenticated using (ul_is_admin())', t);

    -- 변경 시각·변경자 자동 기록
    execute format('drop trigger if exists %I on %I', t || '_stamp', t);
  end loop;
end $$;

create or replace function ul_stamp()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'ul_customers','ul_deals','ul_logs','ul_quotes',
    'ul_equipments','ul_products','ul_schedules','ul_reps'
  ]
  loop
    execute format(
      'create trigger %I before insert or update on %I for each row execute function ul_stamp()',
      t || '_stamp', t);
  end loop;
end $$;


-- ═══════════════════════════════════════════════════════════════
--  실행 후 해야 할 일
-- ═══════════════════════════════════════════════════════════════
--
-- (1) 자유 회원가입 차단  ← 공개 repo 라면 필수
--     Authentication → Sign In / Providers → Email
--       · "Allow new users to sign up"  끄기
--       · "Confirm email"               끄기 (관리자 발급 계정은 확인메일 불필요)
--
-- (2) 계정 발급
--     Authentication → Users → "Add user" → Create new user
--       · 이메일 + 비밀번호 입력, "Auto Confirm User" 체크
--     → 위 트리거가 ul_profiles 행을 자동으로 만들어 줍니다.
--
-- (3) 첫 관리자 지정  ← 본인 이메일로 바꿔서 실행
--     update ul_profiles set role = 'admin' where email = 'daheechoi@example.com';
--
-- (4) 확인
--     select email, display_name, role from ul_profiles order by created_at;
--
-- ── 참고: 데이터가 잘 들어오는지 보기 ──
--     select id, data->>'name' as 고객사, updated_at from ul_customers order by updated_at desc limit 20;
--     select id, data->>'stage' as 단계, data->>'amount' as 금액 from ul_deals limit 20;
