-- ═══════════════════════════════════════════════════════════════
--  UroLink CRM — 스키마 v2 : 앱 안에서 계정 발급하기
--  Supabase 대시보드 → SQL Editor 에 전체 붙여넣고 1회 실행.
--  (migration.sql 을 이미 실행한 프로젝트에 이어서 적용합니다)
-- ═══════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────
-- 1. 프로필 확장 — 부서 / 직급 / 활성 여부
-- ───────────────────────────────────────────────────────────────
alter table ul_profiles add column if not exists dept     text;
alter table ul_profiles add column if not exists position text;
alter table ul_profiles add column if not exists active   boolean not null default true;


-- ───────────────────────────────────────────────────────────────
-- 2. 초대 허용목록 (allowlist)
--
--    앱에서 계정을 발급하려면 브라우저가 직접 회원가입 API를 호출해야 합니다.
--    그런데 이 앱은 주소와 anon 키가 공개되어 있으므로, 회원가입을 그냥 열면
--    누구나 가입해서 전체 데이터에 접근할 수 있습니다.
--
--    그래서 "관리자가 미리 등록한 이메일만 가입 가능"하게 잠급니다.
--    → 회원가입은 열어두되, 아래 트리거가 허용목록에 없는 이메일을 거부합니다.
-- ───────────────────────────────────────────────────────────────
create table if not exists ul_invites (
  email      text primary key,
  invited_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  used_at    timestamptz
);

alter table ul_invites enable row level security;
drop policy if exists ul_inv_admin on ul_invites;
create policy ul_inv_admin on ul_invites
  for all to authenticated
  using (ul_is_admin()) with check (ul_is_admin());

-- 허용목록에 없는 이메일의 가입을 차단
create or replace function ul_gate_signup()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from ul_invites where lower(email) = lower(new.email)) then
    update ul_invites set used_at = now() where lower(email) = lower(new.email);
    return new;
  end if;
  raise exception '등록되지 않은 이메일입니다. 관리자에게 계정 발급을 요청하세요.';
end $$;

drop trigger if exists ul_gate_signup_trg on auth.users;
create trigger ul_gate_signup_trg
  before insert on auth.users
  for each row execute function ul_gate_signup();

-- ⚠ 이 트리거는 Supabase 대시보드의 Add user 에도 적용됩니다.
--   대시보드로 직접 만들고 싶을 때는 먼저 아래처럼 이메일을 넣어주세요.
--     insert into ul_invites(email) values ('someone@urolink.co.kr') on conflict do nothing;


-- ───────────────────────────────────────────────────────────────
-- 3. 비활성 계정은 데이터 접근 차단 (서버측 강제)
--    화면에서 막는 것만으로는 REST API 직접 호출을 못 막으므로 RLS 에 반영합니다.
-- ───────────────────────────────────────────────────────────────
create or replace function ul_is_active()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select coalesce((select active from ul_profiles where id = auth.uid()), false);
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'ul_customers','ul_deals','ul_logs','ul_quotes',
    'ul_equipments','ul_products','ul_schedules','ul_reps'
  ]
  loop
    execute format('drop policy if exists ul_read   on %I', t);
    execute format('drop policy if exists ul_insert on %I', t);
    execute format('drop policy if exists ul_update on %I', t);
    execute format('drop policy if exists ul_delete on %I', t);

    -- 활성 계정만 조회·추가·수정 / 삭제는 활성 관리자만
    execute format('create policy ul_read   on %I for select to authenticated using (ul_is_active())', t);
    execute format('create policy ul_insert on %I for insert to authenticated with check (ul_is_active())', t);
    execute format('create policy ul_update on %I for update to authenticated using (ul_is_active()) with check (ul_is_active())', t);
    execute format('create policy ul_delete on %I for delete to authenticated using (ul_is_active() and ul_is_admin())', t);
  end loop;
end $$;


-- ───────────────────────────────────────────────────────────────
-- 4. 기존 계정 보정 — 이미 있는 계정을 활성 처리하고 허용목록에 등록
-- ───────────────────────────────────────────────────────────────
update ul_profiles set active = true where active is null;
insert into ul_invites(email, used_at)
  select email, now() from ul_profiles where email is not null
  on conflict (email) do nothing;


-- ═══════════════════════════════════════════════════════════════
--  실행 후 Supabase 설정 2가지 (앱에서 계정 발급이 되려면 반드시 필요)
--    Authentication → Sign In / Providers → Email
--      · Allow new users to sign up : 켜기
--        (위 허용목록 트리거가 등록되지 않은 이메일을 전부 거부하므로 안전합니다)
--      · Confirm email : 끄기
--        (켜져 있으면 발급한 계정이 메일 확인 전까지 로그인되지 않습니다)
--
--  확인
--    select email, display_name, dept, position, role, active from ul_profiles order by created_at;
--    select * from ul_invites order by created_at desc;
-- ═══════════════════════════════════════════════════════════════
