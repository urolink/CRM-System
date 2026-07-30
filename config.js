/* ══════════════════════════════════════════════════════════════
   UroLink CRM — 접속 설정
   ══════════════════════════════════════════════════════════════

   SUPABASE_KEY 를 채우면 서버 모드(로그인 + 여러 명 공유)로 동작합니다.
   비워두면 localStorage 모드(이 브라우저 단독)로 동작합니다.

   키 찾는 곳: Supabase 대시보드 → Settings → API Keys → anon / publishable
   ⚠ service_role(secret) 키는 절대 여기에 넣지 마세요.
     그 키는 RLS를 전부 우회하므로, 공개 repo에 올라가면 DB가 통째로 열립니다.
   ══════════════════════════════════════════════════════════════ */
window.UROLINK_CONFIG = {
  SUPABASE_URL: 'https://gfbnbdhkgvwoiezoowyn.supabase.co',
  SUPABASE_KEY: ''   // ← anon / publishable 키를 여기에 붙여넣으세요
};
