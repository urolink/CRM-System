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

  // 이메일 = 로그인 아이디. auth 계정 · 프로필 · 허용목록을 한꺼번에 바꿔야
  // "화면에는 새 주소인데 로그인은 옛 주소로만 되는" 어긋난 상태가 안 생긴다.
  if (body.action === 'set_email') {
    const id = String(body.id ?? '');
    const email = String(body.email ?? '').trim().toLowerCase();
    if (!id) return json({ error: '대상 사용자가 없습니다' }, 400);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ error: '이메일 형식이 올바르지 않습니다' }, 400);
    }

    // 다른 계정이 쓰고 있는 주소인지 먼저 확인 (auth 쪽 오류 메시지가 불친절해서)
    const { data: dup } = await admin
      .from('ul_profiles').select('id').eq('email', email).neq('id', id).maybeSingle();
    if (dup) return json({ error: '이미 다른 계정이 사용 중인 이메일입니다' }, 400);

    const { data: before } = await admin
      .from('ul_profiles').select('email').eq('id', id).maybeSingle();
    const oldEmail = before?.email ?? null;

    // 1) auth 계정. email_confirm 을 켜서 확인 메일 없이 바로 쓸 수 있게 한다
    //    (관리자가 발급·관리하는 계정이므로 본인 확인 절차가 따로 있다)
    const { error: aErr } = await admin.auth.admin.updateUserById(id, {
      email,
      email_confirm: true,
    });
    if (aErr) return json({ error: aErr.message }, 400);

    // 2) 프로필. 여기서 실패하면 auth 와 어긋나므로 되돌린다
    const { error: pErr } = await admin.from('ul_profiles').update({ email }).eq('id', id);
    if (pErr) {
      if (oldEmail) {
        await admin.auth.admin.updateUserById(id, { email: oldEmail, email_confirm: true });
      }
      return json({ error: '프로필 저장에 실패해 이메일을 되돌렸습니다: ' + pErr.message }, 400);
    }

    // 3) 가입 허용목록도 새 주소로 옮긴다 (옛 주소가 남아 있으면 재가입 경로가 생긴다)
    if (oldEmail && oldEmail !== email) {
      await admin.from('ul_invites').delete().eq('email', oldEmail);
    }
    await admin.from('ul_invites').upsert({ email }, { onConflict: 'email' });

    return json({ ok: true, email });
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
