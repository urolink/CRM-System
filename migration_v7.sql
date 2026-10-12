-- ═══════════════════════════════════════════════════════════════
--  UroLink CRM — 스키마 v7
--  추가 테이블: ul_contact_reviews (연락처 점검의 "정상으로 확인" 표시)
--
--  Supabase 대시보드 → SQL Editor 에 전체를 붙여넣고 1회 실행하세요.
--  여러 번 실행해도 안전합니다(idempotent).
--
--  ⚠ 다른 테이블과 달리 **관리자만 읽고 쓸 수 있습니다.**
--    (다른 ul_* 테이블은 로그인한 사람 전부가 읽을 수 있음)
--    영업담당자는 관리자가 무엇을 확인·표시했는지 볼 수 없어야 하기 때문입니다.
--  ⚠ 이 SQL 을 실행하기 전까지는 확인 표시가 관리자의 브라우저에만 남고,
--    다른 기기·다른 관리자와 공유되지 않습니다.
-- ═══════════════════════════════════════════════════════════════

create table if not exists ul_contact_reviews (
  id         text primary key,
  data       jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

alter table ul_contact_reviews enable row level security;

drop policy if exists ul_cr_admin on ul_contact_reviews;

-- 조회·추가·수정·삭제 전부 관리자만. 일반 사용자가 조회하면 에러 없이 "빈 목록"이 돌아옵니다.
create policy ul_cr_admin on ul_contact_reviews
  for all to authenticated
  using (ul_is_admin() and ul_is_active())
  with check (ul_is_admin() and ul_is_active());

drop trigger if exists ul_contact_reviews_stamp on ul_contact_reviews;
create trigger ul_contact_reviews_stamp
  before insert or update on ul_contact_reviews
  for each row execute function ul_stamp();

-- ───────────────────────────────────────────────────────────────
-- 확인용 (실행 후 따로 돌려 결과를 보면 됩니다)
-- ───────────────────────────────────────────────────────────────
--   select policyname, cmd, qual from pg_policies where tablename = 'ul_contact_reviews';
--   -- ul_cr_admin / ALL / (ul_is_admin() AND ul_is_active()) 1행이 나오면 정상입니다.
