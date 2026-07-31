-- ═══════════════════════════════════════════════════════════════
--  UroLink CRM — 스키마 v4
--  추가 테이블 1개: ul_prospects (타겟병원 — 아직 계약 안 된 잠재 병원)
--
--  Supabase 대시보드 → SQL Editor 에 전체를 붙여넣고 1회 실행하세요.
--  여러 번 실행해도 안전합니다(idempotent).
--
--  ⚠ 이 SQL 을 실행하기 전까지는 타겟병원이 브라우저에만 남고
--    서버에 저장되지 않습니다(다른 사람과 공유되지 않음).
-- ═══════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────
-- 테이블 + RLS + 변경시각 트리거
-- 기존 테이블들과 완전히 같은 구조·정책입니다.
--   조회 · 추가 · 수정 : 로그인한 사람 전부
--   삭제               : 관리자만 (ul_is_admin)
-- ───────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['ul_prospects']
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

    -- ⚠ ul_is_active() 를 반드시 겁니다.
    --   v2 에서 나머지 테이블은 '차단(active=false)' 계정을 막도록 올렸으므로
    --   여기만 using(true) 로 두면 차단된 계정이 타겟병원을 읽고 쓸 수 있습니다.
    execute format('create policy ul_read   on %I for select to authenticated using (ul_is_active())', t);
    execute format('create policy ul_insert on %I for insert to authenticated with check (ul_is_active())', t);
    execute format('create policy ul_update on %I for update to authenticated using (ul_is_active()) with check (ul_is_active())', t);
    -- 삭제는 여기만 일반 사용자도 허용합니다.
    --   '고객사로 전환' 이 타겟병원 행을 지우는 방식으로 동작하기 때문에,
    --   관리자만 삭제 가능하게 두면 일반 담당자는 전환할 때마다 저장이 막힙니다.
    --   타겟병원은 아직 계약 전의 영업 리드라 딜·고객사만큼 보존 가치가 크지 않습니다.
    --   (전환 자체를 관리자만 하게 하려면 아래를 ul_is_admin() and ul_is_active() 로 바꾸세요)
    execute format('create policy ul_delete on %I for delete to authenticated using (ul_is_active())', t);

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
--    where table_name = 'ul_prospects';
--   -- 1행이 나오면 정상입니다.
--
--   -- 저장된 타겟병원 확인
--   select data->>'name' as 병원명, data->>'status' as 상태, data->>'rep' as 담당자
--     from ul_prospects order by 1;
