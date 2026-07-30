// ══════════════════════════════════════════════════════════════
//  Supabase Edge Function : admin-user
//  관리자가 다른 사용자의 비밀번호를 바꾸거나 계정을 삭제한다.
//
//  왜 필요한가
//    남의 비밀번호 변경·계정 삭제는 service_role 키가 필요한 관리자 API 다.
//    이 키는 RLS 를 전부 우회하므로 공개 repo(config.js)에 둘 수 없다.
//    → 키를 서버(이 함수)에만 두고, 앱은 자기 로그인 토큰으로 이 함수를 호출한다.
//    → 함수가 호출자를 검사해서 '활성 관리자' 일 때만 작업을 수행한다.
//
//  배포 : Supabase 대시보드 → Edge Functions → Deploy a new function
//         이름을 정확히  admin-user  로 하고 이 파일 내용을 붙여넣는다.
//         SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY 는
//         Supabase 가 자동으로 넣어주므로 따로 등록할 필요가 없다.
// ══════════════════════════════════════════════════════════════
import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST 만 허용됩니다' }, 405);

  const URL_ = Deno.env.get('SUPABASE_URL')!;
  const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
  const SVC  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  // ── 1) 호출자가 활성 관리자인지 확인 ──
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader) return json({ error: '로그인이 필요합니다' }, 401);

  const asUser = createClient(URL_, ANON, { global: { headers: { Authorization: authHeader } } });
  const { data: userRes, error: uErr } = await asUser.auth.getUser();
  const caller = userRes?.user;
  if (uErr || !caller) return json({ error: '로그인이 필요합니다' }, 401);

  const { data: me } = await asUser
    .from('ul_profiles').select('role, active').eq('id', caller.id).maybeSingle();
  if (!me || me.role !== 'admin' || me.active === false) {
    return json({ error: '관리자만 사용할 수 있습니다' }, 403);
  }

  // ── 2) 요청 처리 ──
  let body: Record<string, string> = {};
  try { body = await req.json(); } catch { return json({ error: '잘못된 요청입니다' }, 400); }

  const admin = createClient(URL_, SVC, { auth: { persistSession: false } });

  if (body.action === 'set_password') {
    const id = String(body.id ?? '');
    const password = String(body.password ?? '');
    if (!id) return json({ error: '대상 사용자가 없습니다' }, 400);
    if (password.length < 8) return json({ error: '비밀번호는 8자 이상이어야 합니다' }, 400);
    if (id === caller.id) return json({ error: '본인 비밀번호는 내 비밀번호 변경에서 바꿔주세요' }, 400);

    const { error } = await admin.auth.admin.updateUserById(id, { password });
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true });
  }

  if (body.action === 'delete_user') {
    const id = String(body.id ?? '');
    if (!id) return json({ error: '대상 사용자가 없습니다' }, 400);
    if (id === caller.id) return json({ error: '본인 계정은 삭제할 수 없습니다' }, 400);

    // 프로필의 이메일을 허용목록에서도 제거해 재가입을 막는다
    const { data: p } = await admin.from('ul_profiles').select('email').eq('id', id).maybeSingle();
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) return json({ error: error.message }, 400);
    if (p?.email) await admin.from('ul_invites').delete().eq('email', p.email);
    return json({ ok: true });
  }

  return json({ error: '알 수 없는 요청입니다' }, 400);
});
