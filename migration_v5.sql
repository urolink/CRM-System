-- ═══════════════════════════════════════════════════════════════
--  UroLink CRM — 스키마 v5
--  자동 로그아웃 예외 플래그 (ul_profiles.idle_exempt)
--  ※ v4(ul_prospects · 타겟병원)를 먼저 실행한 뒤 이 파일을 실행하세요.
--
--  Supabase 대시보드 → SQL Editor 에 전체를 붙여넣고 1회 실행하세요.
--  여러 번 실행해도 안전합니다(idempotent).
--
--  동작
--   · idle_exempt = false (기본) → 30분 동안 아무 조작이 없으면 자동 로그아웃
--   · idle_exempt = true         → 자동 로그아웃 없음
--  아래 UPDATE 가 "지금 존재하는 계정"을 전부 예외로 지정합니다.
--  이후에 만들어지는 계정은 기본값(false)이라 30분 제한을 받습니다.
-- ═══════════════════════════════════════════════════════════════

alter table ul_profiles
  add column if not exists idle_exempt boolean not null default false;

-- 지금 있는 계정(이상헌 · 최다희 · admin)을 자동 로그아웃 예외로 지정.
-- 이메일을 일일이 적지 않고 '이미 존재하는 계정' 기준으로 잡아 오타 위험을 없앤다.
-- ⚠ 이 SQL 을 실행하는 시점 이후에 생성되는 계정만 30분 제한을 받습니다.
update ul_profiles
   set idle_exempt = true
 where created_at < now()
   and idle_exempt = false;


-- ───────────────────────────────────────────────────────────────
-- 확인용 (실행 후 아래를 따로 돌려 결과를 보면 됩니다)
-- ───────────────────────────────────────────────────────────────
--   select display_name as 이름, email as 이메일, role as 역할,
--          case when idle_exempt then '예외(제한 없음)' else '30분 자동 로그아웃' end as 자동로그아웃,
--          created_at as 가입일
--     from ul_profiles
--    order by created_at;
--
--   -- 특정 계정만 제한을 걸거나 풀고 싶을 때
--   -- update ul_profiles set idle_exempt = false where email = 'someone@urolink.co.kr';
--   -- update ul_profiles set idle_exempt = true  where email = 'someone@urolink.co.kr';
--   -- (사용자 관리 화면의 시계 아이콘으로도 켜고 끌 수 있습니다)
