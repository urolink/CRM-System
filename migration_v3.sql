-- ═══════════════════════════════════════════════════════════════
--  UroLink CRM — 스키마 v3
--  추가 테이블 2개: ul_targets (영업 목표), ul_audits (변경 이력)
--
--  Supabase 대시보드 → SQL Editor 에 전체를 붙여넣고 1회 실행하세요.
--  여러 번 실행해도 안전합니다(idempotent).
--
--  ⚠ 이 SQL 을 실행하기 전까지는 목표·변경이력이 브라우저에만 남고
--    서버에 저장되지 않습니다(다른 사람과 공유되지 않음).
-- ═══════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────
-- 테이블 + RLS + 변경시각 트리거
-- 기존 8개 테이블과 완전히 같은 구조·정책입니다.
--   조회 · 추가 · 수정 : 로그인한 사람 전부
--   삭제               : 관리자만 (ul_is_admin)
-- ───────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['ul_targets', 'ul_audits']
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

    -- ⚠ ul_is_active() 를 반드시 걸어야 합니다.
    --   v2 에서 나머지 테이블은 '차단(active=false)' 계정을 막도록 올렸는데,
    --   여기만 using(true) 로 두면 차단된 계정이 목표·변경이력을 읽고 쓸 수 있습니다.
    execute format('create policy ul_read   on %I for select to authenticated using (ul_is_active())', t);
    execute format('create policy ul_insert on %I for insert to authenticated with check (ul_is_active())', t);
    execute format('create policy ul_update on %I for update to authenticated using (ul_is_active()) with check (ul_is_active())', t);
    execute format('create policy ul_delete on %I for delete to authenticated using (ul_is_admin() and ul_is_active())', t);

    execute format('drop trigger if exists %I on %I', t || '_stamp', t);
    execute format(
      'create trigger %I before insert or update on %I for each row execute function ul_stamp()',
      t || '_stamp', t);
  end loop;
end $$;


-- ───────────────────────────────────────────────────────────────
-- 확인용 (실행 후 아래를 따로 돌려 결과를 보면 됩니다)
-- ───────────────────────────────────────────────────────────────
--   select table_name
--     from information_schema.tables
--    where table_name in ('ul_targets','ul_audits');
--   -- 2행이 나오면 정상입니다.
--
--   -- 저장된 목표 확인
--   select data->>'ym' as 년월, data->>'rep' as 담당자, data->>'amount' as 목표액
--     from ul_targets order by 1, 2;
--
--   -- 최근 변경 이력 확인
--   select data->>'at' as 시각, data->>'by' as 변경자, data->>'label' as 대상, data->'chg' as 변경내용
--     from ul_audits order by 1 desc limit 20;
