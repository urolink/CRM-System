-- ═══════════════════════════════════════════════════════════════
--  UroLink CRM — 스키마 v6
--  고객사·딜·상담일지·견적서·장비·일정 삭제 권한을 관리자 전용에서
--  '관리자 또는 작성자 본인'으로 완화합니다.
--
--  Supabase 대시보드 → SQL Editor 에 전체를 붙여넣고 1회 실행하세요.
--  여러 번 실행해도 안전합니다(idempotent).
--
--  ⚠ 이 SQL 을 실행하기 전까지는 화면(app.js)에서 작성자 본인에게 삭제
--    버튼을 보여줘도, 실제 삭제는 서버에서 거부됩니다(관리자만 여전히 가능).
--    즉 화면 코드만 바뀌고 이 SQL 을 안 돌리면 "삭제했는데 새로고침하면
--    다시 나타나는" 혼란스러운 상태가 됩니다 — 반드시 함께 실행하세요.
--
--  원리: 이 테이블들은 id + data(jsonb) 구조라, 작성자를 담는 별도 컬럼을
--  새로 만들 필요 없이 data 안의 createdById 값(로그인한 사람의 uuid)을
--  그대로 검사합니다. app.js 가 새 글을 저장할 때부터 채워 넣으므로,
--  이 SQL 실행 이전에 만들어진 기존 글에는 createdById 가 없어 계속
--  관리자만 지울 수 있습니다(안전한 기본값 — 아무나 지울 수 있게 되지 않음).
-- ═══════════════════════════════════════════════════════════════

do $$
declare t text;
begin
  foreach t in array array['ul_customers', 'ul_deals', 'ul_logs', 'ul_quotes', 'ul_equipments', 'ul_schedules']
  loop
    execute format('drop policy if exists ul_delete on %I', t);
    execute format(
      'create policy ul_delete on %I for delete to authenticated using (ul_is_active() and (ul_is_admin() or (data->>%L) = auth.uid()::text))',
      t, 'createdById');
  end loop;
end $$;


-- ───────────────────────────────────────────────────────────────
-- 확인용 (실행 후 아래를 따로 돌려 결과를 보면 됩니다)
-- ───────────────────────────────────────────────────────────────
--   select tablename, policyname, qual
--     from pg_policies
--    where policyname = 'ul_delete'
--      and tablename in ('ul_customers','ul_deals','ul_logs','ul_quotes','ul_equipments','ul_schedules');
--   -- qual 열에 "ul_is_admin() OR ((data ->> 'createdById'::text) = (auth.uid())::text)" 가 보이면 정상입니다.
