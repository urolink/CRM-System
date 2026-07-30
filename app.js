/* ══════════════════════════════════════════════════════════════
   UroLink CRM — 애플리케이션 로직
   저장소: localStorage (키 urolink_crm_v1). 백엔드 없이 단독 동작.
   ══════════════════════════════════════════════════════════════ */

/* ───────────────────────── 1. 상수 ───────────────────────── */
const LS_KEY = 'urolink_crm_v1';
/* 배포 버전 — index.html 의 ?v= 값과 version.json 과 반드시 동일하게 유지 */
const APP_VERSION = '20260730h';

const STAGES = [
  {name:'상담중',    prob:25,  color:'#0ea5e9'},
  {name:'데모/시연', prob:45,  color:'#6366f1'},
  {name:'견적발송',  prob:60,  color:'#8b5cf6'},
  {name:'협의중',    prob:80,  color:'#ea580c'},
  {name:'계약완료',  prob:100, color:'#16a34a'},
  {name:'실주',      prob:0,   color:'#dc2626'}
];
const OPEN_STAGES = STAGES.filter(s => s.name !== '계약완료' && s.name !== '실주').map(s => s.name);
const stageOf = n => STAGES.find(s => s.name === n) || STAGES[0];

const SCH_TYPES = {
  '방문':    '#0e7490', '전화':  '#0ea5e9', '데모/시연': '#6366f1',
  '설치':    '#16a34a', 'A/S':   '#ea580c', '학회':      '#7c3aed', '내부': '#94a3b8'
};

/* ───────────────────────── 2. 유틸 ───────────────────────── */
const $  = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const num = v => { const n = Number(String(v == null ? '' : v).replace(/[^\d.-]/g, '')); return isFinite(n) ? n : 0; };
const comma = n => num(n).toLocaleString('ko-KR');

/* 금액 축약: 12,300,000 → 1,230만 / 320,000,000 → 3.2억 */
function money(n) {
  n = num(n);
  const s = n < 0 ? '-' : ''; n = Math.abs(n);
  if (n >= 100000000) return s + (n / 100000000).toFixed(n >= 1000000000 ? 0 : 1).replace(/\.0$/, '') + '억';
  if (n >= 10000)     return s + Math.round(n / 10000).toLocaleString('ko-KR') + '만';
  return s + n.toLocaleString('ko-KR');
}
const won = n => comma(n) + '원';

function pad(n) { return String(n).padStart(2, '0'); }
function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function today() { return ymd(new Date()); }
function parseD(s) { if (!s) return null; const p = String(s).slice(0, 10).split('-'); const d = new Date(+p[0], +p[1] - 1, +p[2]); return isNaN(d) ? null : d; }
function dDays(s) { const d = parseD(s); if (!d) return null; const t = parseD(today()); return Math.round((d - t) / 86400000); }
function addMonths(s, m) { const d = parseD(s); if (!d) return ''; d.setMonth(d.getMonth() + num(m)); return ymd(d); }
function fmtDate(s) { return s ? String(s).slice(0, 10).replace(/-/g, '.') : '-'; }

function commaInput(el) {
  const v = el.value.replace(/[^\d]/g, '');
  el.value = v ? Number(v).toLocaleString('ko-KR') : '';
}
function toast(msg) {
  $('toast-msg').textContent = msg || '저장되었습니다';
  const t = $('toast'); t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 1800);
}
function fillSelect(el, arr, opts) {
  opts = opts || {};
  if (!el) return;
  const cur = opts.keep ? el.value : null;
  el.innerHTML = (opts.blank ? `<option value="">${esc(opts.blank)}</option>` : '')
    + arr.map(o => {
        const v = typeof o === 'object' ? o.v : o, l = typeof o === 'object' ? o.l : o;
        return `<option value="${esc(v)}">${esc(l)}</option>`;
      }).join('');
  if (cur != null) el.value = cur;
}
/* 기간 필터 → [시작, 종료] (YYYY-MM-DD) */
function periodRange(year, type) {
  if (type === 'year') return [`${year}-01-01`, `${year}-12-31`];
  if (/^Q/.test(type)) { const q = num(type[1]); const s = (q - 1) * 3 + 1; return [`${year}-${pad(s)}-01`, ymd(new Date(year, s + 2, 0))]; }
  const m = num(type); return [`${year}-${pad(m)}-01`, ymd(new Date(year, m, 0))];
}
function inRange(d, a, b) { if (!d) return false; d = String(d).slice(0, 10); return d >= a && d <= b; }

/* ───────────────────────── 3. 데이터 계층 ─────────────────────────
   두 가지 모드로 동작합니다.
     local  : config.js 의 SUPABASE_KEY 가 비어있을 때. 이 브라우저에만 저장.
     remote : 키가 채워져 있을 때. 로그인 필수, 여러 명이 같은 데이터를 공유.

   remote 모드의 저장은 "전체 덮어쓰기"가 아니라 행 단위 diff 입니다.
   마지막 동기화 시점의 사본(SHADOW)과 비교해 바뀐 행만 upsert / 없어진 행만 delete 하므로,
   두 사람이 서로 다른 건을 동시에 고쳐도 상대 데이터가 날아가지 않습니다.
   ───────────────────────────────────────────────────────────────── */
let DB = null;

const CFG = window.UROLINK_CONFIG || {};
const TABLES = { customers: 'ul_customers', deals: 'ul_deals', logs: 'ul_logs', quotes: 'ul_quotes',
                 equipments: 'ul_equipments', products: 'ul_products', schedules: 'ul_schedules', reps: 'ul_reps' };
const KEY_FIELD = { products: 'code', reps: 'name' };   // 그 외 컬렉션은 'id'
const rowKey = (coll, row) => String(row[KEY_FIELD[coll] || 'id'] || '');

let SB = null;              // supabase 클라이언트
let ME = null;              // 로그인 사용자 프로필
let MODE = 'local';         // 'local' | 'remote'
let SHADOW = {};            // 마지막 동기화 시점의 데이터 사본 (diff 기준)
let SYNCING = 0;

const isRemote = () => MODE === 'remote';
const isAdmin = () => MODE === 'local' || !!(ME && ME.role === 'admin');
const clone = o => JSON.parse(JSON.stringify(o));
const cacheKey = () => isRemote() ? LS_KEY + '_cache' : LS_KEY;

function ensureAdmin() {
  if (isAdmin()) return true;
  alert('삭제는 관리자만 할 수 있습니다.\n필요하면 관리자에게 요청해주세요.');
  return false;
}
function blankDB() {
  return { customers: [], deals: [], logs: [], quotes: [], equipments: [], products: [], schedules: [],
           reps: [], meta: { ver: 1, updatedAt: null, sample: false } };
}
function fixShape() {
  const b = blankDB();
  Object.keys(b).forEach(k => { if (DB[k] == null) DB[k] = b[k]; });
  if (!DB.meta) DB.meta = b.meta;
  /* 단계 개편(리드발굴 폐지) 이전 데이터 이관 — 없는 단계면 칸반에서 사라지므로 */
  (DB.deals || []).forEach(d => { if (d.stage === '상담중') { d.stage = '상담중'; d.prob = 25; } });
}
const isEmptyDB = () => Object.keys(TABLES).every(k => !(DB[k] || []).length);
/* 샘플 데이터 존재 여부 — meta 플래그는 브라우저별이라, 시드된 실제 행으로 판별(서버 공유 시에도 정확) */
const hasSampleData = () => (DB.customers || []).some(c => c.id === 'c1' && c.name === '한강비뇨의학과의원');

/* ── local 모드 로드 ── */
function loadLocal() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    DB = raw ? JSON.parse(raw) : null;
  } catch (e) { DB = null; }
  if (!DB || typeof DB !== 'object') { DB = blankDB(); seed(); fixShape(); save(true); return; }
  fixShape();
}

/* ── 저장: 로컬 캐시 기록 + (remote면) 서버 diff 반영 ── */
function save(silent) {
  DB.meta.updatedAt = new Date().toISOString();
  try {
    localStorage.setItem(cacheKey(), JSON.stringify(DB));
  } catch (e) {
    if (!isRemote()) {
      alert('저장 실패: 브라우저 저장 공간이 부족합니다.\n설정 → JSON 내보내기로 백업 후 데이터를 정리해주세요.');
      return;
    }
  }
  refreshCounts();
  if (isRemote()) pushDiff(silent);
  else if (!silent) toast();
  flushAutoAdded();
}

function syncing(on) {
  SYNCING = Math.max(0, SYNCING + (on ? 1 : -1));
  const el = $('footer-meta');
  if (!el) return;
  if (SYNCING) el.textContent = '서버 동기화 중...';
  else if (DB) refreshCounts();
  else el.textContent = '';
}

/* ── 서버로 변경분만 밀어넣기 ── */
async function pushDiff(silent) {
  if (!SB) return;
  const ops = [], summary = [];
  Object.keys(TABLES).forEach(coll => {
    const cur = DB[coll] || [], prev = SHADOW[coll] || [];
    const curMap = new Map(), prevMap = new Map();
    cur.forEach(r => { const k = rowKey(coll, r); if (k) curMap.set(k, r); });
    prev.forEach(r => { const k = rowKey(coll, r); if (k) prevMap.set(k, r); });
    const ups = [], dels = [];
    curMap.forEach((row, k) => {
      const p = prevMap.get(k);
      if (!p || JSON.stringify(p) !== JSON.stringify(row)) ups.push({ id: k, data: row });
    });
    prevMap.forEach((_, k) => { if (!curMap.has(k)) dels.push(k); });
    if (ups.length) { ops.push(SB.from(TABLES[coll]).upsert(ups)); summary.push(coll + '+' + ups.length); }
    if (dels.length) { ops.push(SB.from(TABLES[coll]).delete().in('id', dels)); summary.push(coll + '-' + dels.length); }
  });
  if (!ops.length) { if (!silent) toast('변경된 내용이 없습니다'); return; }

  syncing(true);
  let res;
  try { res = await Promise.all(ops); }
  catch (e) { syncing(false); toast('네트워크 오류 — 서버에 저장하지 못했습니다'); console.error(e); return; }
  syncing(false);

  const bad = res.find(r => r && r.error);
  if (bad) {
    const m = String(bad.error.message || '');
    // SHADOW 를 갱신하지 않으므로 다음 저장 때 자동으로 재시도됩니다.
    toast(/row-level security|permission|policy/i.test(m)
      ? '권한이 없어 서버에 저장되지 않았습니다 (삭제는 관리자만)'
      : '서버 저장 실패 — 다음 저장 때 다시 시도합니다');
    console.error('[pushDiff]', bad.error);
    return;
  }
  SHADOW = clone(DB);
  if (!silent) toast('저장되었습니다');
}

/* ── 서버에서 최신 데이터 가져오기 ── */
async function pullRemote(withToast) {
  if (!isRemote() || !SB) return;
  syncing(true);
  const names = Object.keys(TABLES);
  let res;
  try { res = await Promise.all(names.map(n => SB.from(TABLES[n]).select('id,data'))); }
  catch (e) { syncing(false); toast('네트워크 오류 — 서버에서 불러오지 못했습니다'); console.error(e); return false; }
  syncing(false);

  const bad = res.find(r => r && r.error);
  if (bad) {
    console.error('[pullRemote]', bad.error);
    const m = String(bad.error.message || '');
    if (/relation .* does not exist|schema cache/i.test(m)) {
      alert('서버에 테이블이 없습니다.\nmigration.sql 을 Supabase SQL Editor 에서 먼저 실행해주세요.');
    } else {
      toast('서버에서 불러오지 못했습니다 — 캐시된 데이터를 표시합니다');
    }
    if (!DB) { try { DB = JSON.parse(localStorage.getItem(cacheKey()) || 'null'); } catch (e) {} }
    if (!DB) DB = blankDB();
    fixShape();
    return false;
  }

  const meta = DB && DB.meta ? DB.meta : blankDB().meta;
  DB = blankDB();
  names.forEach((n, i) => { DB[n] = (res[i].data || []).map(r => r.data).filter(Boolean); });
  DB.meta = meta;
  fixShape();
  SHADOW = clone(DB);
  try { localStorage.setItem(cacheKey(), JSON.stringify(DB)); } catch (e) {}
  refreshSelects(); refreshCounts();
  if (RENDER[CUR_PAGE]) RENDER[CUR_PAGE]();
  if (withToast) toast('최신 데이터를 불러왔습니다');
  return true;
}
const custById  = id => DB.customers.find(c => c.id === id);
const prodByCode = c => DB.products.find(p => p.code === c);
const custName  = id => { const c = custById(id); return c ? c.name : '(삭제된 고객사)'; };
const repNames  = () => DB.reps.map(r => r.name);

/* 고객사 누적 수주액 */
function custWonAmount(id) {
  return DB.deals.filter(d => d.custId === id && d.stage === '계약완료').reduce((s, d) => s + num(d.amount), 0);
}

/* ───────────────────────── 4. 샘플(가상) 데이터 ───────────────────────── */
function seed() {
  const Y = new Date().getFullYear(), M = new Date().getMonth() + 1;
  const dm = (mOff, dom) => ymd(new Date(Y, M - 1 + mOff, dom));            // N개월 전/후의 특정 일자
  const dd = n => { const t = new Date(); t.setDate(t.getDate() + n); return ymd(t); }; // 오늘 ±N일

  DB.reps = [
    {name:'김성호', role:'영업1파트 팀장'}, {name:'이지현', role:'영업1파트'},
    {name:'박준영', role:'영업2파트'},     {name:'최다희', role:'영업2파트 파트장'},
    {name:'정민우', role:'서비스팀'}
  ];

  DB.products = [
    {code:'UL-L900',  name:'UL-Litho 900 체외충격파쇄석기',   cat:'장비',     price:320000000, unit:'SET', warranty:24, memo:'대형 · 설치공사 별도'},
    {code:'UL-L500',  name:'UL-Litho 500 체외충격파쇄석기',   cat:'장비',     price:245000000, unit:'SET', warranty:24, memo:'중형 · 의원 표준형'},
    {code:'UL-H100',  name:'UL-Holmi 100W 홀뮴 레이저',       cat:'장비',     price:165000000, unit:'SET', warranty:24, memo:''},
    {code:'UL-TP2',   name:'UL-Therm P2 전립선 온열치료기',   cat:'장비',     price:96000000,  unit:'SET', warranty:24, memo:''},
    {code:'UL-DX',    name:'UL-Dynamic X 요역동학검사장비',   cat:'장비',     price:48000000,  unit:'SET', warranty:18, memo:''},
    {code:'UL-SF7',   name:'UL-Scope F7 연성요관내시경',      cat:'장비',     price:42000000,  unit:'EA',  warranty:12, memo:''},
    {code:'UL-F200',  name:'UL-Flow 200 요류측정기',          cat:'장비',     price:18500000,  unit:'SET', warranty:12, memo:''},
    {code:'UL-S300',  name:'UL-Scan 300 방광스캐너',          cat:'장비',     price:12800000,  unit:'EA',  warranty:12, memo:''},
    {code:'UL-BK19',  name:'UL-Basket 1.9F 결석 바스켓',      cat:'소모품',   price:420000,    unit:'EA',  warranty:0,  memo:'일회용'},
    {code:'UL-FB273', name:'UL-Fiber 273 레이저 파이버',      cat:'소모품',   price:320000,    unit:'EA',  warranty:0,  memo:''},
    {code:'UL-ST6',   name:'UL-Stent 6Fr 요관 스텐트',        cat:'소모품',   price:95000,     unit:'EA',  warranty:0,  memo:''},
    {code:'UL-WR38',  name:'UL-Wire 0.038 가이드와이어',      cat:'소모품',   price:38000,     unit:'EA',  warranty:0,  memo:''},
    {code:'UL-CARE',  name:'UL-CARE 연간 유지보수계약',       cat:'서비스',   price:6000000,   unit:'년',  warranty:0,  memo:'정기점검 2회 포함'}
  ];

  const C = [
    ['한강비뇨의학과의원','의원','서울','강남구','A','김성호','02-555-0101','최원장','ESWL보유,학회활동'],
    ['미래비뇨기과의원','의원','서울','송파구','B','김성호','02-444-2201','박원장','결석센터'],
    ['강북본비뇨의학과의원','의원','서울','강북구','D','이지현','02-988-3311','한원장',''],
    ['수원영통유로의원','의원','경기','수원시','B','이지현','031-222-7788','오원장','다점포'],
    ['인천송도비뇨의학과의원','의원','인천','연수구','C','이지현','032-777-1102','윤원장',''],
    ['대전둔산비뇨의학과','병원','대전','서구','A','박준영','042-511-9090','정원장','ESWL보유,전립선특화'],
    ['청주센트럴비뇨기과','의원','충북','청주시','C','박준영','043-260-4500','신원장',''],
    ['세종유로케어의원','의원','세종','한솔동','B','박준영','044-863-1200','권원장','신규개원'],
    ['대구중앙비뇨의학과','병원','대구','중구','A','최다희','053-421-6600','류원장','ESWL보유,학회활동'],
    ['부산해운대유로클리닉','의원','부산','해운대구','B','최다희','051-747-3030','강원장','결석센터'],
    ['창원마산비뇨기과의원','의원','경남','창원시','D','최다희','055-249-8800','조원장',''],
    ['광주첨단비뇨기과','의원','광주','광산구','C','최다희','062-971-5050','문원장',''],
    ['제주한라유로클리닉','의원','제주','제주시','C','이지현','064-742-2020','고원장',''],
    ['메디플러스의료기','대리점','서울','영등포구','B','김성호','02-2634-7000','김대표','소모품유통']
  ];
  DB.customers = C.map((r, i) => ({
    id: 'c' + (i + 1), name: r[0], type: r[1], sido: r[2], gugun: r[3], grade: r[4], rep: r[5],
    phone: r[6], doctor: r[7], dept: '비뇨의학과',
    tags: r[8] ? r[8].split(',') : [], addr: r[2] + ' ' + r[3], memo: '', createdAt: dm(-14, 1)
  }));

  const DL = [
    // [고객, 제품코드, 금액, 단계, 예상 수주일, 담당, 다음액션, 액션예정일]
    ['c1','UL-H100',158000000,'협의중',      dm(0,25), '김성호','원장 최종 결재 확인',      dd(3)],
    ['c1','UL-BK19',12600000, '계약완료',    dm(-1,18),'김성호','',                         ''],
    ['c2','UL-L500',238000000,'견적발송',    dm(1,10), '김성호','견적 조건 재협의',          dd(5)],
    ['c2','UL-ST6', 4750000,  '계약완료',    dm(-2,7), '김성호','',                          ''],
    ['c3','UL-S300',12300000, '상담중',      dm(1,20), '이지현','원장 미팅 일정 확정',       dd(-2)],
    ['c4','UL-DX',  46000000, '데모/시연',   dm(0,28), '이지현','데모 장비 반출 신청',       dd(1)],
    ['c4','UL-F200',17800000, '계약완료',    dm(-3,12),'이지현','',                         ''],
    ['c5','UL-SF7', 40500000, '상담중',    dm(2,15), '이지현','학회 부스 팔로업',          dd(8)],
    ['c6','UL-L900',312000000,'협의중',      dm(1,2),  '박준영','설치공사 견적 첨부',        dd(2)],
    ['c6','UL-CARE',6000000,  '계약완료',    dm(-1,5), '박준영','',                          ''],
    ['c7','UL-TP2', 92000000, '견적발송',    dm(1,25), '박준영','리스 조건 안내',            dd(6)],
    ['c8','UL-L500',241000000,'상담중',      dm(2,5),  '박준영','개원 일정 확인',            dd(4)],
    ['c9','UL-H100',162000000,'계약완료',    dm(0,8),  '최다희','',                           ''],
    ['c9','UL-FB273',9600000, '협의중',      dm(0,26), '최다희','연간 소모품 단가 확정',     dd(0)],
    ['c10','UL-SF7',41000000, '데모/시연',   dm(1,8),  '최다희','시연 결과 리포트 전달',      dd(-1)],
    ['c11','UL-S300',12500000,'실주',        dm(-1,20),'최다희','',                         ''],
    ['c12','UL-F200',18000000,'상담중',      dm(1,15), '최다희','원장 재방문',               dd(9)],
    ['c13','UL-WR38',3800000, '계약완료',    dm(-2,22),'이지현','',                         ''],
    ['c14','UL-BK19',21000000,'계약완료',    dm(-1,28),'김성호','',                         ''],
    ['c14','UL-ST6', 9500000, '견적발송',    dm(0,26), '김성호','분기 발주 확정',            dd(7)]
  ];
  DB.deals = DL.map((r, i) => {
    const p = DB.products.find(x => x.code === r[1]);
    return { id: 'd' + (i + 1), custId: r[0], product: p ? p.name : r[1], productCode: r[1],
             qty: 1, amount: r[2], stage: r[3], prob: stageOf(r[3]).prob, expectedDate: r[4],
             rep: r[5], nextAction: r[6], nextActionDate: r[7], memo: '', createdAt: dm(-2, 1),
             closedAt: (r[3] === '계약완료' || r[3] === '실주') ? r[4] : '' };
  });

  /* 전년 실적 — 전년 동기간·YoY 비교가 화면 전반에 쓰이므로 함께 시드 */
  const PY = Y - 1;
  const PREV = [
    // [고객, 제품코드, 금액, 월, 담당]
    ['c1','UL-L500', 232000000,11,'김성호'], ['c1','UL-BK19',  9800000, 6,'김성호'],
    ['c2','UL-S300',  12100000, 5,'김성호'], ['c3','UL-F200', 17200000, 9,'이지현'],
    ['c4','UL-SF7',   39500000, 4,'이지현'], ['c5','UL-BK19',  7400000, 7,'이지현'],
    ['c6','UL-H100', 158000000,10,'박준영'], ['c6','UL-FB273', 8200000, 8,'박준영'],
    ['c7','UL-S300',  12400000,11,'박준영'], ['c9','UL-L900',305000000, 9,'최다희'],
    ['c9','UL-ST6',    5200000,10,'최다희'], ['c10','UL-DX',  45000000, 7,'최다희'],
    ['c12','UL-WR38',  3400000,12,'최다희'], ['c14','UL-BK19',18500000, 4,'김성호'],
    ['c14','UL-ST6',   8800000, 9,'김성호'], ['c13','UL-F200',17600000, 7,'이지현'],
    ['c8','UL-S300',  12600000, 1,'박준영'], ['c11','UL-F200',17900000, 5,'최다희']
  ];
  PREV.forEach((r, i) => {
    const p = DB.products.find(x => x.code === r[1]);
    const dt = PY + '-' + pad(r[3]) + '-15';
    DB.deals.push({ id: 'p' + (i + 1), custId: r[0], productCode: r[1], product: p ? p.name : r[1],
      qty: 1, amount: r[2], stage: '계약완료', prob: 100, expectedDate: dt, rep: r[4],
      nextAction: '', nextActionDate: '', memo: '', createdAt: PY + '-' + pad(r[3]) + '-01', closedAt: dt });
  });

  const LG = [
    ['c1','방문','홀뮴 레이저 100W 최종 사양 협의. 기존 80W 대비 파워·파이버 호환성 문의.','UL-H100','원장 결재 확인','김성호',dd(-4)],
    ['c1','전화','소모품 단가 인상분 문의 대응. 연간 계약 전환 제안.','UL-BK19','연간 계약 견적','김성호',dd(-11)],
    ['c2','방문','쇄석기 교체 검토 중. 경쟁사 견적 보유. 설치 공간 실측 완료.','UL-L500','조건 재협의','김성호',dd(-2)],
    ['c3','전화','방광스캐너 단순 문의 → 원장 직접 통화 필요.','UL-S300','원장 미팅','이지현',dd(-6)],
    ['c4','데모/시연','요역동학 장비 반일 시연. 간호팀 조작 만족도 높음.','UL-DX','데모기 반출','이지현',dd(-1)],
    ['c5','학회','대한비뇨의학회 부스 상담. 연성내시경 관심 표명.','UL-SF7','자료 발송','이지현',dd(-16)],
    ['c6','방문','대형 쇄석기 도입 확정 단계. 전기·급배수 공사 범위 확인.','UL-L900','설치 견적','박준영',dd(-3)],
    ['c7','방문','전립선 온열치료 도입 검토. 리스 조건 요청.','UL-TP2','리스 안내','박준영',dd(-5)],
    ['c8','전화','하반기 개원 예정. 장비 패키지 전체 문의.','UL-L500','개원 일정 확인','박준영',dd(-8)],
    ['c9','시술참관','홀뮴 레이저 설치 후 첫 시술 참관. 셋업 이상 없음.','UL-H100','','최다희',dd(-7)],
    ['c9','방문','연간 소모품 단가 협의. 파이버 물량 상향 논의.','UL-FB273','단가 확정','최다희',dd(-2)],
    ['c10','데모/시연','연성내시경 2일 시연 완료. 세척·소독 동선 이슈 제기.','UL-SF7','리포트 전달','최다희',dd(-9)],
    ['c11','전화','예산 미확보로 금년 도입 보류 통보.','UL-S300','','최다희',dd(-20)],
    ['c12','방문','요류측정기 노후 교체 필요. 견적 요청 예정.','UL-F200','원장 재방문','최다희',dd(-12)],
    ['c13','이메일','가이드와이어 정기 발주 확정.','UL-WR38','','이지현',dd(-18)],
    ['c14','방문','분기 소모품 발주 협의. 바스켓 재고 확인.','UL-BK19','발주 확정','김성호',dd(-4)]
  ];
  DB.logs = LG.map((r, i) => ({ id: 'g' + (i + 1), custId: r[0], type: r[1], content: r[2],
    interest: (DB.products.find(p => p.code === r[3]) || {}).name || '', nextAction: r[4],
    nextActionDate: '', rep: r[5], date: r[6] }));

  const EQ = [
    ['c1','UL-L500','L5-2201', dm(-26,14),'정상','김성호','구매'],
    ['c1','UL-F200','F2-3310', dm(-14,3), '정상','김성호','구매'],
    ['c2','UL-S300','S3-4102', dm(-8,21), '정상','김성호','구매'],
    ['c4','UL-F200','F2-3455', dm(-3,12), '정상','이지현','구매'],
    ['c5','UL-S300','S3-4180', dm(-19,7), '수리중','정민우','구매'],
    ['c6','UL-L500','L5-2140', dm(-33,9), '교체예정','박준영','구매'],
    ['c6','UL-DX', 'DX-1020',  dm(-11,25),'정상','박준영','리스'],
    ['c7','UL-F200','F2-3402', dm(-6,17), '정상','박준영','구매'],
    ['c9','UL-H100','H1-5501', dm(0,8),   '정상','최다희','구매'],
    ['c9','UL-L900','L9-1108', dm(-40,4), '정상','최다희','구매'],
    ['c10','UL-SF7','SF-7021', dm(-2,3),  '정상','최다희','데모기'],
    ['c11','UL-F200','F2-3288',dm(-29,19),'정상','최다희','구매'],
    ['c12','UL-S300','S3-4033',dm(-23,11),'정상','최다희','구매'],
    ['c13','UL-SF7','SF-7008', dm(-16,6), '정상','이지현','구매']
  ];
  DB.equipments = EQ.map((r, i) => {
    const p = DB.products.find(x => x.code === r[1]);
    return { id: 'e' + (i + 1), custId: r[0], model: p ? p.name : r[1], modelCode: r[1], serial: r[2],
      installDate: r[3], warrantyEnd: addMonths(r[3], p ? p.warranty : 12), status: r[4], rep: r[5],
      contract: r[6], memo: '',
      as: i % 3 === 0 ? [{ id: uid(), date: addMonths(r[3], 12), type: '정기점검', content: '연간 정기점검 · 소모부품 교체', engineer: '정민우' }] : [] };
  });

  const SC = [
    [dd(0),  '09:30','c1', '방문','원장 미팅 — 홀뮴 레이저 결재 확인','김성호',false,''],
    [dd(0),  '14:00','c4', '데모/시연','요역동학 장비 시연 2일차','이지현',false,''],
    [dd(1),  '10:00','c6', '방문','설치공사 실측 동행','박준영',false,''],
    [dd(2),  '11:00','c9', '방문','소모품 단가 협의','최다희',false,''],
    [dd(3),  '15:30','c2', '전화','견적 조건 재협의','김성호',false,''],
    [dd(5),  '13:00','c7', '방문','리스 조건 설명','박준영',false,''],
    [dd(7),  '10:30','c14','방문','분기 발주 확정','김성호',false,''],
    [dd(-1), '09:00','c10','데모/시연','시연 종료 · 장비 회수','최다희',false,''],
    [dd(-2), '14:00','c3', '전화','원장 통화 시도','이지현',false,''],
    [dd(-4), '11:00','c1', '방문','사양 협의','김성호',true,'100W 확정. 파이버 호환 확인 완료.'],
    [dd(-6), '16:00','c5', 'A/S','방광스캐너 수리 접수','정민우',true,'프로브 케이블 교체. 부품 발주.'],
    [dd(8),  '09:00','c5', '학회','지역 비뇨의학회 부스 지원','이지현',false,'']
  ];
  DB.schedules = SC.map((r, i) => ({ id: 's' + (i + 1), date: r[0], time: r[1], custId: r[2],
    type: r[3], title: r[4], rep: r[5], done: r[6], result: r[7] }));

  const QT = [
    ['c1','UL-H100',1,158000000,0,'발송',   dd(-6)],
    ['c2','UL-L500',1,245000000,3,'발송',   dd(-3)],
    ['c6','UL-L900',1,320000000,3,'발송',   dd(-4)],
    ['c7','UL-TP2', 1,96000000, 4,'발송',   dd(-5)],
    ['c9','UL-FB273',30,320000,5,'임시저장',dd(-1)],
    ['c14','UL-ST6',100,95000, 8,'발송',    dd(-2)]
  ];
  DB.quotes = QT.map((r, i) => {
    const p = DB.products.find(x => x.code === r[1]);
    return { id: 'q' + (i + 1), no: 'UL' + String(new Date().getFullYear()).slice(2) + '-' + pad(i + 1),
      custId: r[0], date: r[6], validDays: 30, rep: custById(r[0]) ? custById(r[0]).rep : '김성호',
      items: [{ code: r[1], name: p ? p.name : r[1], qty: r[2], price: r[3], disc: r[4] }],
      status: r[5], memo: '설치·기본 교육 포함 / 소모품 별도' };
  });

  DB.meta.sample = true;
}

/* ───────────────────────── 5. 라우팅 ───────────────────────── */
const PAGES = ['overview','mix','dashboard','analysis','sales','schedule','quotes','customers','equipments','products','settings'];
/* 사이드바 하이라이트 귀속: 장비 페이지는 '고객사·장비' 메뉴에 속함 */
const NAV_OF = { equipments: 'customers' };
const RENDER = {
  overview: () => renderOverview(), mix: () => renderMix(), dashboard: () => renderDashboard(),
  analysis: () => renderAnalysis(), sales: () => renderSales(),
  schedule: () => renderSchedule(), quotes: () => renderQuotes(), customers: () => renderCustomers(),
  equipments: () => renderEquip(), products: () => renderProducts(), settings: () => renderSettings()
};
let CUR_PAGE = 'overview';

function showPage(page, el) {
  if (!PAGES.includes(page)) page = 'overview';
  /* 사용자 관리는 관리자 전용 — 주소창(#settings)으로 직접 들어오는 경우까지 차단 */
  if (page === 'settings' && !isAdmin()) {
    page = 'overview';
    toast('사용자 관리는 관리자만 접근할 수 있습니다');
  }
  CUR_PAGE = page;
  PAGES.forEach(p => $('page-' + p).classList.toggle('active', p === page));
  const navKey = NAV_OF[page] || page;
  document.querySelectorAll('.sidebar .nav-link[data-page]').forEach(a => a.classList.toggle('active', a.dataset.page === navKey));
  document.querySelectorAll('#m-bottomnav button[data-page]').forEach(b => b.classList.toggle('on', b.dataset.page === navKey));
  if (el && !el.dataset.page) { /* 사이드바 외 호출 */ }
  try { history.replaceState(null, '', '#' + page); } catch (e) { location.hash = page; }
  closeSidebar();
  window.scrollTo(0, 0);
  RENDER[page]();
}
function toggleSidebar() { $('sidebar').classList.toggle('open'); $('sidebarOverlay').classList.toggle('open'); }
function closeSidebar() { $('sidebar').classList.remove('open'); $('sidebarOverlay').classList.remove('open'); }

/* ══ 알림 (원텍 사이드바 벨) ══
   오늘 일정 · 놓친 일정 · 지연된 다음 액션 · 보증만료 임박 · 장기 미접촉을 한곳에 모은다. */
function alertItems() {
  const out = [], td = today();
  DB.schedules.filter(s => s.date === td && !s.done).forEach(s => out.push({
    sec: '오늘 일정', ic: 'bi-calendar-event', c: '#0e7490',
    t: (s.custId ? custName(s.custId) : '내부') + ' · ' + s.type,
    sub: (s.time ? s.time + ' ' : '') + s.title, go: "showPage('schedule')", urgent: true }));
  DB.schedules.filter(s => !s.done && s.date < td).forEach(s => out.push({
    sec: '놓친 일정', ic: 'bi-exclamation-circle', c: '#dc2626',
    t: (s.custId ? custName(s.custId) : '내부') + ' · ' + fmtDate(s.date).slice(5),
    sub: s.title + ' — 결과 미입력', go: "showPage('schedule');schOverdue()", urgent: true }));
  DB.deals.filter(d => OPEN_STAGES.includes(d.stage) && d.nextAction).forEach(d => {
    const n = dDays(d.nextActionDate || d.expectedDate);
    if (n == null || n > 0) return;
    out.push({ sec: '다음 액션', ic: 'bi-flag', c: n < 0 ? '#dc2626' : '#ea580c',
      t: custName(d.custId) + ' · ' + money(d.amount) + '원',
      sub: d.nextAction + (n < 0 ? ' (' + (-n) + '일 지연)' : ' (오늘)'),
      go: "openDrawer('" + d.id + "')", urgent: true });
  });
  DB.equipments.forEach(e => {
    const n = dDays(e.warrantyEnd);
    if (n != null && n >= 0 && n <= 90) out.push({ sec: '보증 만료 임박', ic: 'bi-shield-exclamation', c: '#ea580c',
      t: custName(e.custId) + ' · ' + e.model, sub: 'D-' + n + ' (' + fmtDate(e.warrantyEnd) + ')', go: "showPage('equipments')" });
    if (e.status === '수리중') out.push({ sec: 'A/S 진행', ic: 'bi-tools', c: '#dc2626',
      t: custName(e.custId) + ' · ' + e.model, sub: '수리중 — 진행 확인 필요', go: "showPage('equipments')" });
  });
  DB.customers.forEach(c => {
    if (c.grade !== 'A' && c.grade !== 'B') return;
    const last = DB.logs.filter(l => l.custId === c.id).map(l => l.date).sort().pop();
    const gap = last ? -dDays(last) : null;
    if (gap == null || gap > 60) out.push({ sec: '장기 미접촉', ic: 'bi-person-dash', c: '#7c3aed',
      t: c.name + ' (' + c.grade + '등급)', sub: last ? gap + '일간 접촉 없음' : '접촉 이력 없음',
      go: "openCustDetail('" + c.id + "')" });
  });
  return out;
}
function renderBell() {
  if (!DB) return;
  const items = alertItems();
  const urgent = items.filter(x => x.urgent).length;
  const badge = $('bell-badge');
  if (badge) {
    badge.textContent = urgent || items.length || '';
    badge.style.display = (urgent || items.length) ? 'inline-block' : 'none';
    badge.style.background = urgent ? '#dc2626' : '#94a3b8';
  }
  const body = $('bp-body'), cnt = $('bp-count');
  if (!body) return;
  if (cnt) cnt.textContent = items.length ? items.length + '건' + (urgent ? ' · 급함 ' + urgent : '') : '';
  if (!items.length) { body.innerHTML = '<div class="bp-empty"><i class="bi bi-check2-circle" style="font-size:20px;color:#cbd5e1"></i><div class="mt-2">확인할 알림이 없습니다</div></div>'; return; }
  const secs = [];
  items.forEach(x => { if (!secs.includes(x.sec)) secs.push(x.sec); });
  body.innerHTML = secs.map(sc => '<div class="bp-sec">' + esc(sc) + '</div>'
    + items.filter(x => x.sec === sc).slice(0, 8).map(x =>
      '<div class="bp-item" onclick="closeBell();' + x.go + '">'
      + '<i class="bi ' + x.ic + '" style="color:' + x.c + '"></i>'
      + '<div style="flex:1;min-width:0"><div class="bp-t">' + esc(x.t) + '</div>'
      + '<div class="bp-s">' + esc(x.sub) + '</div></div></div>').join('')).join('');
}
function toggleBell() {
  const p = $('bell-panel');
  if (!p) return;
  if (p.classList.contains('on')) { p.classList.remove('on'); return; }
  renderBell();
  p.classList.add('on');
}
function closeBell() { const p = $('bell-panel'); if (p) p.classList.remove('on'); }

function refreshCounts() {
  if (!DB) return;   // 로그인 직후 서버 로드 이전(DB 미생성) 시점 방어
  const setCnt = (id, v) => { const el = $(id); if (el) el.textContent = v || ''; };
  setCnt('cnt-deals',  DB.deals.filter(d => OPEN_STAGES.includes(d.stage)).length);
  setCnt('cnt-sch',    DB.schedules.filter(s => !s.done && (dDays(s.date) ?? -99) >= 0).length);
  setCnt('cnt-quotes', DB.quotes.length);
  setCnt('cnt-cust',   DB.customers.length);
  setCnt('cnt-equip',  DB.equipments.length);
  setCnt('cnt-prod',   DB.products.length);
  renderBell();
  const u = DB.meta.updatedAt ? new Date(DB.meta.updatedAt) : null;
  $('footer-meta').textContent = u ? '최근 저장 ' + u.getFullYear() + '.' + pad(u.getMonth() + 1) + '.' + pad(u.getDate()) + ' ' + pad(u.getHours()) + ':' + pad(u.getMinutes()) : '';
}

/* ══ 콤보박스(직접 입력 + 자동완성) 지원 ══
   고객사·제품·담당자는 목록에서 고르거나 새 이름을 그대로 타이핑할 수 있다.
   저장 시 resolve*() 가 기존 항목을 찾고, 없으면 마스터에 자동 등록한다. */
function fillDatalist(id, vals) {
  const el = $(id);
  if (!el) return;
  el.innerHTML = vals.filter(Boolean).map(v => '<option value="' + esc(v) + '"></option>').join('');
}
function refreshDatalists() {
  fillDatalist('dl-cust', DB.customers.map(c => c.name).sort((a, b) => String(a).localeCompare(String(b), 'ko')));
  fillDatalist('dl-prod', DB.products.map(p => p.name));
  fillDatalist('dl-rep', repNames());
}
const trimv = v => String(v == null ? '' : v).trim();
const prodByName = nm => DB.products.find(p => p.name === nm) || DB.products.find(p => p.code === nm);
const AUTO_ADDED = [];   /* 이번 저장에서 자동 등록된 항목 안내용 */

function resolveCust(v) {
  const nm = trimv(v);
  if (!nm) return '';
  const hit = DB.customers.find(x => x.name === nm) || DB.customers.find(x => x.id === nm);
  if (hit) return hit.id;
  const c = { id: uid(), name: nm, type: '의원', doctor: '', dept: '비뇨의학과', grade: 'C',
    sido: '', gugun: '', rep: '', phone: '', addr: '', tags: [], memo: '', createdAt: today(), auto: true };
  DB.customers.push(c);
  AUTO_ADDED.push('고객사 ' + nm);
  return c.id;
}
function autoProdCode() {
  let i = DB.products.length + 1;
  while (prodByCode('P' + String(i).padStart(3, '0'))) i++;
  return 'P' + String(i).padStart(3, '0');
}
function resolveProd(v, catHint) {
  const nm = trimv(v);
  if (!nm) return '';
  const hit = prodByName(nm);
  if (hit) return hit.code;
  const code = autoProdCode();
  DB.products.push({ code, name: nm, cat: catHint || '장비', price: 0, unit: 'EA', warranty: 12, memo: '자동 등록', auto: true });
  AUTO_ADDED.push('제품 ' + nm);
  return code;
}
function resolveRep(v) {
  const nm = trimv(v);
  if (!nm) return '';
  if (!DB.reps.some(r => r.name === nm)) { DB.reps.push({ name: nm, role: '', auto: true }); AUTO_ADDED.push('담당자 ' + nm); }
  return nm;
}
/* 저장 후 자동 등록 안내 */
function flushAutoAdded() {
  if (!AUTO_ADDED.length) return;
  const msg = AUTO_ADDED.join(' · ') + ' 자동 등록됨';
  AUTO_ADDED.length = 0;
  refreshDatalists();
  setTimeout(() => toast(msg), 700);
}

function refreshSelects() {
  refreshDatalists();
  /* sch-rep 은 renderSchedule 이 '👥 담당 전체' 라벨로 직접 채운다(라벨 덮어쓰기 방지) */
  ['pipe-rep','c-rep'].forEach(id => fillSelect($(id), repNames(), { blank: '전체 담당자', keep: true }));
  fillSelect($('d-stage'), STAGES.map(s => s.name));
  fillSelect($('dl-stage'), STAGES.map(s => s.name), { blank: '전체 단계', keep: true });
  fillSelect($('p-cat'), [...new Set(DB.products.map(p => p.cat))], { blank: '전체 분류', keep: true });
  fillSelect($('c-region'), [...new Set(DB.customers.map(c => c.sido).filter(Boolean))].sort(), { blank: '전체 지역', keep: true });
  // 연도 select
  const years = [...new Set([new Date().getFullYear(), ...DB.deals.map(d => num(String(d.expectedDate).slice(0, 4))).filter(y => y > 2000)])].sort((a, b) => b - a);
  const ay = $('ana-year'); if (ay && !ay.options.length) fillSelect(ay, years.map(y => ({ v: y, l: y + '년' })));
  // 파이프라인 칩
  const chips = $('pipe-chips');
  if (chips && !chips.children.length) {
    chips.innerHTML = `<span class="pipe-chip on" onclick="setPipeChip('all',this)">전체</span>`
      + OPEN_STAGES.map(s => `<span class="pipe-chip" onclick="setPipeChip('${esc(s)}',this)">${esc(s)}</span>`).join('');
  }
}

/* ───────────────────────── 6. 현황판 (구 종합 현황) ───────────────────────── */
let DB_PERIOD = 'year';
let CHARTS = {};
function chart(id, cfg) {
  if (CHARTS[id]) { CHARTS[id].destroy(); delete CHARTS[id]; }
  const el = $(id); if (!el) return;
  CHARTS[id] = new Chart(el, cfg);
}
function setDbPeriod(p, el) {
  DB_PERIOD = p;
  document.querySelectorAll('#db-period-btns .dash-period-btn').forEach(b => b.classList.remove('on'));
  if (el) el.classList.add('on');
  renderOverview();
}
function dbRange() {
  const now = new Date(), y = now.getFullYear(), m = now.getMonth() + 1;
  if (DB_PERIOD === 'month') return [`${y}-${pad(m)}-01`, ymd(new Date(y, m, 0))];
  if (DB_PERIOD === 'quarter') { const q = Math.floor((m - 1) / 3), s = q * 3 + 1; return [`${y}-${pad(s)}-01`, ymd(new Date(y, s + 2, 0))]; }
  return [`${y}-01-01`, `${y}-12-31`];
}

function renderDashboard() {
  const [a, b] = dbRange();
  const label = DB_PERIOD === 'month' ? '이번달' : DB_PERIOD === 'quarter' ? '이번분기' : '올해';
  const inP = DB.deals.filter(d => inRange(d.expectedDate, a, b));
  const wonD = inP.filter(d => d.stage === '계약완료');
  const lostD = inP.filter(d => d.stage === '실주');
  const openD = DB.deals.filter(d => OPEN_STAGES.includes(d.stage));
  const wonAmt = wonD.reduce((s, d) => s + num(d.amount), 0);
  const openAmt = openD.reduce((s, d) => s + num(d.amount), 0);
  const wgt = openD.reduce((s, d) => s + num(d.amount) * num(d.prob) / 100, 0);
  const closed = wonD.length + lostD.length;
  const winRate = closed ? Math.round(wonD.length / closed * 100) : 0;

  $('db-band').innerHTML = `
    <div class="wt-hero">
      <div class="l">${esc(label)} 확정 수주 (계약완료)</div>
      <b>${money(wonAmt)}원</b>
      <div class="s">${wonD.length}건 · 평균 ${money(wonD.length ? wonAmt / wonD.length : 0)}원</div>
    </div>
    <div class="wt-fact clickable" onclick="showPage('sales')">
      <div class="l">진행 파이프라인</div><b>${money(openAmt)}원</b><div class="s">${openD.length}건 열림</div></div>
    <div class="wt-fact">
      <div class="l">확률가중 예상</div><b>${money(wgt)}원</b><div class="s">단계 확률 반영</div></div>
    <div class="wt-fact">
      <div class="l">수주 성공률</div><b class="${winRate >= 50 ? 'gr' : winRate < 30 ? 'rd' : ''}">${winRate}%</b>
      <div class="s">종결 ${closed}건 중 ${wonD.length}건</div></div>
    <div class="wt-fact clickable" onclick="showPage('customers')">
      <div class="l">거래 고객사</div><b>${DB.customers.length}</b>
      <div class="s">A등급 ${DB.customers.filter(c => c.grade === 'A').length}곳</div></div>`;

  /* 월별 차트 (최근 12개월, 계약완료 기준) */
  const months = [], labels = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(d.getFullYear() + '-' + pad(d.getMonth() + 1));
    labels.push((d.getMonth() + 1) + '월');
  }
  const mAmt = months.map(m => DB.deals.filter(d => d.stage === '계약완료' && String(d.expectedDate).slice(0, 7) === m).reduce((s, d) => s + num(d.amount), 0));
  const mCnt = months.map(m => DB.deals.filter(d => d.stage === '계약완료' && String(d.expectedDate).slice(0, 7) === m).length);
  chart('chart-db-month', {
    type: 'bar',
    data: { labels, datasets: [
      { label: '수주액', data: mAmt, backgroundColor: '#0e7490', borderRadius: 5, yAxisID: 'y', order: 2 },
      { label: '건수', data: mCnt, type: 'line', borderColor: '#ea580c', backgroundColor: '#ea580c', borderWidth: 2, pointRadius: 3, yAxisID: 'y1', order: 1 }
    ] },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } },
        tooltip: { callbacks: { label: c => c.dataset.label === '건수' ? c.parsed.y + '건' : won(c.parsed.y) } } },
      scales: { y: { beginAtZero: true, ticks: { font: { size: 10 }, callback: v => money(v) }, grid: { color: '#f1f5f9' } },
        y1: { position: 'right', beginAtZero: true, ticks: { font: { size: 10 }, precision: 0 }, grid: { display: false } },
        x: { ticks: { font: { size: 10 } }, grid: { display: false } } } }
  });

  /* 단계 퍼널 */
  const maxA = Math.max(1, ...OPEN_STAGES.map(s => openD.filter(d => d.stage === s).reduce((t, d) => t + num(d.amount), 0)));
  $('db-funnel').innerHTML = OPEN_STAGES.map(s => {
    const ds = openD.filter(d => d.stage === s), amt = ds.reduce((t, d) => t + num(d.amount), 0);
    return `<div class="funnel-row">
      <div class="funnel-label">${esc(s)}</div>
      <div class="funnel-bar-wrap"><div class="funnel-bar" style="width:${amt / maxA * 100}%;background:${stageOf(s).color}">${ds.length ? ds.length + '건' : ''}</div></div>
      <div class="funnel-amt">${money(amt)}</div></div>`;
  }).join('');
  $('db-funnel-sum').innerHTML = `<div class="d-flex justify-content-between" style="font-size:12px">
    <span style="color:#64748b;font-weight:600">열린 딜 합계</span><strong>${won(openAmt)}</strong></div>`;

  /* 매출 전망 바 */
  const tot = wonAmt + wgt;
  $('db-fc-label').textContent = '· ' + label + ' 확정 + 진행 딜 확률가중';
  $('db-fc-total').textContent = money(tot) + '원';
  $('db-bar-won').style.width = tot ? (wonAmt / tot * 100) + '%' : '0%';
  $('db-bar-exp').style.width = tot ? (wgt / tot * 100) + '%' : '0%';
  $('db-bar-won-v').textContent = money(wonAmt) + '원';
  $('db-bar-exp-v').textContent = money(wgt) + '원';

  /* 다음 액션 */
  const acts = [];
  DB.deals.filter(d => OPEN_STAGES.includes(d.stage) && d.nextAction).forEach(d =>
    acts.push({ kind: 'deal', id: d.id, date: d.nextActionDate || d.expectedDate, cust: custName(d.custId), text: d.nextAction, rep: d.rep, amount: d.amount }));
  DB.schedules.filter(s => !s.done).forEach(s =>
    acts.push({ kind: 'sch', id: s.id, date: s.date, cust: s.custId ? custName(s.custId) : '내부', text: s.title, rep: s.rep, type: s.type }));
  acts.sort((x, y) => String(x.date).localeCompare(String(y.date)));
  const od = acts.filter(x => (dDays(x.date) ?? 99) < 0).length;
  const td = acts.filter(x => dDays(x.date) === 0).length;
  const wk = acts.filter(x => { const n = dDays(x.date); return n > 0 && n <= 7; }).length;
  $('db-act-od').textContent = '지연 ' + od;
  $('db-act-td').textContent = '오늘 ' + td;
  $('db-act-wk').textContent = '7일 내 ' + wk;
  $('db-action-board').innerHTML = acts.length ? acts.slice(0, 40).map(x => {
    const n = dDays(x.date);
    const flag = n == null ? '' : n < 0 ? `<span class="dc-flag od">${-n}일 지연</span>` : n === 0 ? `<span class="dc-flag td">오늘</span>` : `<span style="font-size:10px;color:#94a3b8">D+${n}</span>`;
    const click = x.kind === 'deal' ? `openDrawer('${x.id}')` : `openSchModal('${x.id}')`;
    return `<div onclick="${click}" style="display:flex;align-items:center;gap:10px;padding:9px 14px;border-bottom:1px solid #f3f4f6;cursor:pointer;font-size:12.5px">
      <i class="bi ${x.kind === 'deal' ? 'bi-kanban' : 'bi-calendar-event'}" style="color:${x.kind === 'deal' ? '#0e7490' : (SCH_TYPES[x.type] || '#94a3b8')}"></i>
      <div style="width:88px;flex-shrink:0;color:#64748b">${fmtDate(x.date)}</div>
      <div style="width:130px;flex-shrink:0;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(x.cust)}</div>
      <div style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(x.text)}</div>
      <div style="width:52px;flex-shrink:0;color:#94a3b8;font-size:11px">${esc(x.rep || '')}</div>
      <div style="width:60px;flex-shrink:0;text-align:right">${flag}</div></div>`;
  }).join('') : `<div class="text-center" style="padding:36px;color:#94a3b8;font-size:13px">예정된 액션이 없습니다</div>`;

  /* 관리 필요 */
  const alerts = [];
  DB.equipments.forEach(e => {
    const n = dDays(e.warrantyEnd);
    if (n != null && n >= 0 && n <= 90) alerts.push({ ic: 'bi-shield-exclamation', c: '#ea580c', t: `${custName(e.custId)} · ${e.model}`, s: `보증만료 D-${n} (${fmtDate(e.warrantyEnd)})`, go: `showPage('equipments')` });
    if (e.status === '수리중') alerts.push({ ic: 'bi-tools', c: '#dc2626', t: `${custName(e.custId)} · ${e.model}`, s: '수리중 — 진행 확인 필요', go: `showPage('equipments')` });
  });
  DB.deals.filter(d => OPEN_STAGES.includes(d.stage)).forEach(d => {
    const n = dDays(d.expectedDate);
    if (n != null && n < 0) alerts.push({ ic: 'bi-hourglass-bottom', c: '#dc2626', t: custName(d.custId), s: `예상 수주일 ${-n}일 경과 · ${money(d.amount)}원`, go: `openDrawer('${d.id}')` });
  });
  DB.customers.forEach(c => {
    const last = DB.logs.filter(l => l.custId === c.id).map(l => l.date).sort().pop();
    const n = last ? -dDays(last) : null;
    if ((c.grade === 'A' || c.grade === 'B') && (n == null || n > 60))
      alerts.push({ ic: 'bi-person-dash', c: '#7c3aed', t: c.name, s: last ? `${n}일간 접촉 없음 (${c.grade}등급)` : `접촉 이력 없음 (${c.grade}등급)`, go: `openCustDetail('${c.id}')` });
  });
  $('db-alerts').innerHTML = alerts.length ? alerts.slice(0, 20).map(x =>
    `<div onclick="${x.go}" style="display:flex;align-items:center;gap:9px;padding:8px 10px;border-radius:8px;background:#fafbfc;border:1px solid #eef1f5;margin-bottom:6px;cursor:pointer">
      <i class="bi ${x.ic}" style="color:${x.c};font-size:15px"></i>
      <div style="flex:1;min-width:0">
        <div style="font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(x.t)}</div>
        <div style="font-size:11px;color:#64748b">${esc(x.s)}</div></div></div>`).join('')
    : `<div class="text-center" style="padding:30px;color:#94a3b8;font-size:13px">특이사항 없습니다</div>`;
}

/* ═══════════════ 6b. 종합 · 장비/소모품 매출 (원텍 한국영업 레이아웃 이식) ═══════════════ */
/* 제품 분류를 장비 / 소모품 2분할로 환원 (액세서리·서비스는 소모품에 합산) */
const CAT2 = code => ((prodByCode(code) || {}).cat === '장비' ? '장비' : '소모품');
const WON_DEALS = () => DB.deals.filter(d => d.stage === '계약완료');

function mSum(year, m, cat) {
  return WON_DEALS().reduce((t, d) => {
    const s = String(d.expectedDate || '');
    if (num(s.slice(0, 4)) !== year || num(s.slice(5, 7)) !== m) return t;
    if (cat && CAT2(d.productCode) !== cat) return t;
    return t + num(d.amount);
  }, 0);
}
function rSum(year, a, b, cat) { let t = 0; for (let m = a; m <= b; m++) t += mSum(year, m, cat); return t; }
function badgeYoy(cur, prev) {
  if (!prev) return '<span class="yoy na">전년 -</span>';
  const r = (cur / prev - 1) * 100;
  return '<span class="yoy ' + (r >= 0 ? 'up' : 'dn') + '">' + (r >= 0 ? '▲' : '▼') + Math.abs(r).toFixed(1) + '%</span>';
}
function dealYears() {
  const ys = [...new Set(DB.deals.map(d => num(String(d.expectedDate).slice(0, 4))).filter(y => y > 2000))];
  const cy = new Date().getFullYear();
  if (!ys.includes(cy)) ys.push(cy);
  return ys.sort((x, y) => y - x);
}
function initPeriodSel(pfx) {
  const ySel = $(pfx + '-year');
  if (!ySel) return;
  const years = dealYears();
  const sig = years.join(',');
  if (ySel.dataset.sig === sig) return;         // 연도 목록이 그대로면 사용자 선택 유지
  const first = !ySel.options.length;
  const cur = ySel.value;
  fillSelect(ySel, years.map(y => ({ v: y, l: y + '년' })));
  ySel.dataset.sig = sig;
  /* 서버에서 데이터를 다시 불러와 연도가 늘어난 경우에도 선택값 유지 */
  ySel.value = (!first && cur && years.includes(num(cur))) ? cur : new Date().getFullYear();
  if (!first) return;
  const months = Array.from({ length: 12 }, (_, i) => ({ v: i + 1, l: (i + 1) + '월' }));
  fillSelect($(pfx + '-from'), months); $(pfx + '-from').value = 1;
  fillSelect($(pfx + '-to'), months);   $(pfx + '-to').value = new Date().getMonth() + 1;
}
function periodOf(pfx) {
  initPeriodSel(pfx);
  const y = num($(pfx + '-year').value) || new Date().getFullYear();
  let a = num($(pfx + '-from').value) || 1, b = num($(pfx + '-to').value) || 12;
  if (a > b) { const t = a; a = b; b = t; }
  return [y, a, b];
}
const mw = v => Math.round(num(v) / 1e6);   /* 백만원 */

function renderOverview() {
  const [y, a, b] = periodOf('ov');
  $('ov-desc').textContent = y + '년 ' + a + '월 ~ ' + b + '월 · 계약완료(수주) 기준';
  const u = DB.meta.updatedAt ? new Date(DB.meta.updatedAt) : null;
  $('ov-updated').innerHTML = (u ? '최근 갱신 ' + u.getFullYear() + '.' + pad(u.getMonth() + 1) + '.' + pad(u.getDate()) + ' ' + pad(u.getHours()) + ':' + pad(u.getMinutes()) : '')
    + '<br><span style="color:#94a3b8">전체 딜 ' + DB.deals.length + '건 · 고객사 ' + DB.customers.length + '곳 · 설치 ' + DB.equipments.length + '대</span>';

  /* 당월(기간 마지막달) / 누계(기간 전체) */
  const moT = mSum(y, b), moD = mSum(y, b, '장비'), moC = mSum(y, b, '소모품');
  const moPT = mSum(y - 1, b), moPD = mSum(y - 1, b, '장비'), moPC = mSum(y - 1, b, '소모품');
  const ytT = rSum(y, a, b), ytD = rSum(y, a, b, '장비'), ytC = rSum(y, a, b, '소모품');
  const ypT = rSum(y - 1, a, b), ypD = rSum(y - 1, a, b, '장비'), ypC = rSum(y - 1, a, b, '소모품');

  const openD = DB.deals.filter(d => OPEN_STAGES.includes(d.stage));
  const openAmt = openD.reduce((s, d) => s + num(d.amount), 0);
  const wgt = openD.reduce((s, d) => s + num(d.amount) * num(d.prob) / 100, 0);

  const mini = (lab, v, pv) => '<div><div class="cdud-mini">' + lab + '</div>'
    + '<div class="cdud-mini-v">' + money(v) + '</div>'
    + '<div class="cdud-mini-s">전년 ' + money(pv) + ' ' + badgeYoy(v, pv) + '</div></div>';
  const half = (lab, v, sub, d, c, brd) => '<div class="cdud-half" style="flex:1 1 340px;display:flex;align-items:center;gap:18px;min-width:0;'
    + (brd ? 'border-left:1px solid #e4e8ef;padding-left:24px' : 'padding-right:20px') + '">'
    + '<div class="cdud-hero" style="flex:1.3;padding-right:0" onclick="showPage(\'mix\')"><span class="l">' + lab + '</span><b>' + money(v) + '</b><span class="s">' + sub + '</span></div>'
    + '<div style="display:flex;flex-direction:column;gap:11px;min-width:92px;border-left:1px solid #eef2f7;padding-left:14px">' + d + c + '</div></div>';

  $('ov-kpi').innerHTML = '<div class="cdud" style="padding:18px 22px;margin:0">'
    + '<div style="display:flex;flex-wrap:wrap;align-items:stretch;padding:2px 0 4px">'
    + half('당월 · ' + b + '월', moT, '전년 동월 ' + money(moPT) + ' ' + badgeYoy(moT, moPT), mini('장비', moD, moPD), mini('소모품', moC, moPC), false)
    + half('누계 · ' + y + '년 ' + a + '~' + b + '월', ytT, '전년 동기간 ' + money(ypT) + ' ' + badgeYoy(ytT, ypT), mini('장비', ytD, ypD), mini('소모품', ytC, ypC), true)
    + '</div>'
    + '<div style="font-size:11px;color:#64748b;padding-top:8px;border-top:1px solid #e4e8ef;margin-top:6px">'
    + '진행 파이프라인 <b style="color:#182230">' + money(openAmt) + '</b> (' + openD.length + '건) · '
    + '확률가중 예상 <b style="color:#182230">' + money(wgt) + '</b> · '
    + '기간 합계 대비 <b style="color:#0e7490">' + (ytT ? Math.round(wgt / ytT * 100) : 0) + '%</b> 규모'
    + '</div></div>';

  /* 월별 차트 — 장비/소모품 누적 막대 + 작년 합계 점선 */
  const labels = Array.from({ length: 12 }, (_, i) => (i + 1) + '월');
  const dev = [], cons = [], prev = [];
  for (let m = 1; m <= 12; m++) { dev.push(mw(mSum(y, m, '장비'))); cons.push(mw(mSum(y, m, '소모품'))); prev.push(mw(mSum(y - 1, m))); }
  chart('ov-chart-monthly', {
    data: { labels, datasets: [
      { type: 'bar', label: '장비', data: dev, backgroundColor: '#16a34a', stack: 's', borderRadius: 3 },
      { type: 'bar', label: '소모품', data: cons, backgroundColor: '#0e7490', stack: 's', borderRadius: 3 },
      { type: 'line', label: (y - 1) + '년 합계', data: prev, borderColor: '#94a3b8', borderDash: [5, 4], borderWidth: 2, pointRadius: 2, backgroundColor: '#94a3b8' }
    ] },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } },
        tooltip: { callbacks: { label: c => c.dataset.label + ' ' + comma(c.parsed.y) + '백만원' } } },
      scales: { x: { stacked: true, ticks: { font: { size: 10 } }, grid: { display: false } },
        y: { stacked: true, beginAtZero: true, ticks: { font: { size: 10 } }, grid: { color: '#f1f5f9' } } } }
  });

  /* 월별 표 */
  const rowsHtml = [
    ['장비', m => mSum(y, m, '장비'), '#16a34a'],
    ['소모품', m => mSum(y, m, '소모품'), '#0e7490'],
    ['합계', m => mSum(y, m), '#182230'],
    [(y - 1) + '년', m => mSum(y - 1, m), '#94a3b8']
  ].map(row => {
    const lab = row[0], fn = row[1], col = row[2];
    let tot = 0;
    const tds = Array.from({ length: 12 }, (_, i) => { const v = fn(i + 1); tot += v; return '<td class="text-end">' + (v ? comma(mw(v)) : '-') + '</td>'; }).join('');
    return '<tr><td class="fw-bold" style="color:' + col + '">' + esc(lab) + '</td>' + tds + '<td class="text-end fw-bold">' + comma(mw(tot)) + '</td></tr>';
  }).join('');
  $('ov-month-table').innerHTML = '<div style="overflow-x:auto"><table class="table table-sm mb-0" style="font-size:12px;min-width:760px">'
    + '<thead><tr><th>구분</th>' + labels.map(l => '<th class="text-end">' + l + '</th>').join('') + '<th class="text-end">합계</th></tr></thead>'
    + '<tbody>' + rowsHtml + '</tbody></table></div>'
    + '<div style="font-size:11px;color:#94a3b8;margin-top:6px">단위 백만원 · 계약완료 딜의 예상 수주일 기준</div>';

  /* 장비 / 소모품 상세 */
  const detail = cat => {
    const acc = {};
    WON_DEALS().forEach(d => {
      if (!inRange(d.expectedDate, y + '-' + pad(a) + '-01', ymd(new Date(y, b, 0)))) return;
      if (CAT2(d.productCode) !== cat) return;
      const k = d.productCode || d.product;
      if (!acc[k]) acc[k] = { name: d.product, cnt: 0, amt: 0 };
      acc[k].cnt++; acc[k].amt += num(d.amount);
    });
    const list = Object.keys(acc).map(k => Object.assign({ code: k }, acc[k])).sort((x, z) => z.amt - x.amt);
    const tot = list.reduce((s, x) => s + x.amt, 0);
    if (!list.length) return '<div style="color:#94a3b8;font-size:12.5px;padding:18px 0;text-align:center">해당 기간 수주 없음</div>';
    return '<table class="table table-sm mb-0" style="font-size:12px">'
      + '<thead><tr><th>제품</th><th class="text-center">건</th><th class="text-end">금액</th><th class="text-end">비중</th></tr></thead><tbody>'
      + list.map(x => '<tr><td>' + esc(x.name) + '</td><td class="text-center">' + x.cnt + '</td>'
        + '<td class="text-end fw-bold">' + comma(x.amt) + '</td>'
        + '<td class="text-end" style="color:#64748b">' + (tot ? Math.round(x.amt / tot * 100) : 0) + '%</td></tr>').join('')
      + '</tbody><tfoot><tr style="background:#fafbfc"><td class="fw-bold">합계</td>'
      + '<td class="text-center fw-bold">' + list.reduce((s, x) => s + x.cnt, 0) + '</td>'
      + '<td class="text-end fw-bold">' + comma(tot) + '</td><td class="text-end">100%</td></tr></tfoot></table>';
  };
  $('ov-dev-prods').innerHTML = detail('장비');
  $('ov-cons-prods').innerHTML = detail('소모품');
}

/* ── 장비·소모품 매출 ── */
let MIX_CAT = 'all';
function mixTab(c, el) {
  MIX_CAT = c;
  document.querySelectorAll('#page-mix .wt-tab').forEach(x => x.classList.remove('on'));
  if (el) el.classList.add('on');
  renderMix();
}
function rSumProduct(year, a, b, code) {
  const from = year + '-' + pad(a) + '-01', to = ymd(new Date(year, b, 0));
  return WON_DEALS().filter(d => (d.productCode || d.product) === code && inRange(d.expectedDate, from, to))
    .reduce((s, d) => s + num(d.amount), 0);
}
function renderMix() {
  const [y, a, b] = periodOf('mix');
  const from = y + '-' + pad(a) + '-01', to = ymd(new Date(y, b, 0));
  $('mix-desc').textContent = y + '년 ' + a + '월 ~ ' + b + '월' + (MIX_CAT === 'all' ? '' : ' · ' + MIX_CAT);
  const catF = MIX_CAT === 'all' ? null : MIX_CAT;

  const cur = rSum(y, a, b, catF), pv = rSum(y - 1, a, b, catF);
  const devA = rSum(y, a, b, '장비'), consA = rSum(y, a, b, '소모품');
  const cnt = WON_DEALS().filter(d => inRange(d.expectedDate, from, to) && (!catF || CAT2(d.productCode) === catF)).length;
  const denom = (devA + consA) || 1;

  const fact = (lab, v, sub) => '<div class="cdud-fact"><span>' + lab + '</span><b>' + v + '</b><i>' + sub + '</i></div>';
  $('mix-kpi').innerHTML = '<div class="cdud" style="padding:18px 22px;margin:0">'
    + '<div class="cdud-kpis" style="border-bottom:0;padding-bottom:6px">'
    + '<div class="cdud-hero" style="cursor:default"><span class="l">' + (MIX_CAT === 'all' ? '전체' : MIX_CAT) + ' 수주액</span>'
    + '<b>' + money(cur) + '</b><span class="s">전년 동기간 ' + money(pv) + ' ' + badgeYoy(cur, pv) + ' · ' + cnt + '건</span></div>'
    + fact('장비', money(devA), Math.round(devA / denom * 100) + '% 비중')
    + fact('소모품', money(consA), Math.round(consA / denom * 100) + '% 비중')
    + fact('건당 평균', money(cnt ? cur / cnt : 0), '평균 수주 규모')
    + fact('설치 장비', DB.equipments.length + '대', new Set(DB.equipments.map(e => e.custId)).size + '개 고객사')
    + '</div></div>';

  /* 제품별 집계 */
  const acc = {};
  WON_DEALS().forEach(d => {
    if (!inRange(d.expectedDate, from, to)) return;
    if (catF && CAT2(d.productCode) !== catF) return;
    const k = d.productCode || d.product;
    if (!acc[k]) acc[k] = { name: d.product, cat: CAT2(d.productCode), cnt: 0, amt: 0, custs: {} };
    acc[k].cnt++; acc[k].amt += num(d.amount); acc[k].custs[d.custId] = 1;
  });
  const list = Object.keys(acc).map(k => Object.assign({ code: k }, acc[k])).sort((x, z) => z.amt - x.amt);
  const tot = list.reduce((s, x) => s + x.amt, 0);
  const top = list.slice(0, 10);

  chart('mix-chart', {
    type: 'bar',
    data: { labels: top.map(x => x.name.replace(/^UL-[^\s]+\s*/, '').slice(0, 16)),
      datasets: [{ label: '수주액', data: top.map(x => mw(x.amt)),
        backgroundColor: top.map(x => x.cat === '장비' ? '#16a34a' : '#0e7490'), borderRadius: 4 }] },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => comma(c.parsed.y) + '백만원' } } },
      scales: { y: { beginAtZero: true, ticks: { font: { size: 10 } }, grid: { color: '#f1f5f9' } },
        x: { ticks: { font: { size: 10 }, maxRotation: 40 }, grid: { display: false } } } }
  });

  $('mix-table').innerHTML = list.length ? '<div style="overflow-x:auto"><table class="table table-hover mb-0">'
    + '<thead><tr><th>제품</th><th>분류</th><th class="text-center">건수</th><th class="text-center">고객사</th>'
    + '<th class="text-end">수주액</th><th class="text-end">비중</th><th class="text-end">건당 평균</th><th class="text-end">전년 동기간</th></tr></thead><tbody>'
    + list.map(x => {
        const p = rSumProduct(y - 1, a, b, x.code);
        const cc = x.cat === '장비' ? '#16a34a' : '#0e7490';
        return '<tr><td class="fw-bold">' + esc(x.name) + '</td>'
          + '<td><span class="badge" style="background:' + cc + '1a;color:' + cc + '">' + esc(x.cat) + '</span></td>'
          + '<td class="text-center">' + x.cnt + '</td><td class="text-center">' + Object.keys(x.custs).length + '</td>'
          + '<td class="text-end fw-bold">' + comma(x.amt) + '</td>'
          + '<td class="text-end" style="color:#64748b">' + (tot ? Math.round(x.amt / tot * 100) : 0) + '%</td>'
          + '<td class="text-end">' + comma(Math.round(x.amt / x.cnt)) + '</td>'
          + '<td class="text-end">' + comma(p) + ' ' + badgeYoy(x.amt, p) + '</td></tr>';
      }).join('')
    + '</tbody><tfoot><tr style="background:#fafbfc"><td class="fw-bold">합계</td><td></td>'
    + '<td class="text-center fw-bold">' + list.reduce((s, x) => s + x.cnt, 0) + '</td><td></td>'
    + '<td class="text-end fw-bold">' + comma(tot) + '</td><td class="text-end">100%</td><td></td><td></td></tr></tfoot></table></div>'
    : '<div class="table-empty">해당 기간 수주가 없습니다</div>';
}

/* ───────────────────────── 7. 수주관리 ───────────────────────── */
let PIPE_CHIP = 'all';
let SALES_TAB = 'pipeline';

function renderSales() {
  const openD = DB.deals.filter(d => OPEN_STAGES.includes(d.stage));
  const y = new Date().getFullYear();
  const wonY = DB.deals.filter(d => d.stage === '계약완료' && String(d.expectedDate).slice(0, 4) == y);
  const lostY = DB.deals.filter(d => d.stage === '실주' && String(d.expectedDate).slice(0, 4) == y);
  const kpis = [
    { l: '열린 딜', v: openD.length + '건', s: money(openD.reduce((s, d) => s + num(d.amount), 0)) + '원', i: 'bi-kanban', c: '#0e7490' },
    { l: '확률가중 예상', v: money(openD.reduce((s, d) => s + num(d.amount) * num(d.prob) / 100, 0)) + '원', s: '단계 확률 반영', i: 'bi-graph-up', c: '#6366f1' },
    { l: y + ' 수주', v: money(wonY.reduce((s, d) => s + num(d.amount), 0)) + '원', s: wonY.length + '건', i: 'bi-check-circle', c: '#16a34a' },
    { l: '성공률', v: (wonY.length + lostY.length ? Math.round(wonY.length / (wonY.length + lostY.length) * 100) : 0) + '%', s: `실주 ${lostY.length}건`, i: 'bi-percent', c: '#ea580c' }
  ];
  $('sales-kpi').innerHTML = kpis.map(k => `<div class="col-sm-6 col-lg-3"><div class="kpi-card">
    <div class="kpi-label"><i class="bi ${k.i}" style="color:${k.c}"></i>${esc(k.l)}</div>
    <div class="kpi-value">${esc(k.v)}</div><div class="kpi-sub">${esc(k.s)}</div></div></div>`).join('');
  if (SALES_TAB === 'pipeline') renderPipeline();
  else if (SALES_TAB === 'list') renderDealList();
  else renderLogs();
}
function salesTab(t, el) {
  SALES_TAB = t;
  ['pipeline','list','logs'].forEach(x => $('sales-tab-' + x).style.display = x === t ? 'block' : 'none');
  document.querySelectorAll('#page-sales .wt-tab').forEach(b => b.classList.remove('on'));
  if (el) el.classList.add('on');
  renderSales();
}
function setPipeChip(s, el) {
  PIPE_CHIP = s;
  document.querySelectorAll('#pipe-chips .pipe-chip').forEach(c => c.classList.remove('on'));
  if (el) el.classList.add('on');
  renderPipeline();
}
function pipeFiltered() {
  const q = ($('pipe-search').value || '').trim().toLowerCase();
  const rep = $('pipe-rep').value;
  return DB.deals.filter(d => {
    if (!OPEN_STAGES.includes(d.stage)) return false;
    if (rep && d.rep !== rep) return false;
    if (PIPE_CHIP !== 'all' && d.stage !== PIPE_CHIP) return false;
    if (q) {
      const hay = (custName(d.custId) + ' ' + d.product + ' ' + (d.rep || '') + ' ' + (d.nextAction || '')).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}
function renderPipeline() {
  const ds = pipeFiltered();
  const cols = PIPE_CHIP === 'all' ? OPEN_STAGES : [PIPE_CHIP];
  $('kanban-board').innerHTML = cols.map(s => {
    const list = ds.filter(d => d.stage === s).sort((a, b) => num(b.amount) - num(a.amount));
    const amt = list.reduce((t, d) => t + num(d.amount), 0);
    return `<div class="pipeline-col" ondragover="dragOver(event)" ondragleave="dragLeave(event)" ondrop="dropCard(event,'${esc(s)}')">
      <div class="pipeline-col-header" style="color:${stageOf(s).color}">
        <span>${esc(s)} <span style="color:#94a3b8">${list.length}</span></span>
        <span style="font-size:10.5px;color:#64748b">${money(amt)}</span></div>
      ${list.map(d => dealCard(d)).join('')}
      ${list.length ? '' : '<div style="text-align:center;color:#cbd5e1;font-size:11.5px;padding:14px 0">없음</div>'}
    </div>`;
  }).join('');
}
function dealCard(d) {
  const n = dDays(d.nextActionDate || d.expectedDate);
  const flag = n == null ? '' : n < 0 ? `<span class="dc-flag od">${-n}일 지연</span>` : n === 0 ? `<span class="dc-flag td">오늘</span>` : '';
  return `<div class="deal-card" draggable="true" ondragstart="dragStart(event,'${d.id}')" ondragend="dragEnd(event)" onclick="openDrawer('${d.id}')">
    <div class="dc-top"><div class="dc-name">${esc(custName(d.custId))}</div>${flag}</div>
    <div class="dc-prod">${esc(d.product)}</div>
    <div class="dc-foot"><span class="dc-amt">${money(d.amount)}원</span>
      <span class="dc-meta">${esc(d.rep || '미지정')} · ${num(d.prob)}%${flag ? '' : ' · ' + fmtDate(d.expectedDate)}</span></div>
  </div>`;
}
let DRAG_ID = null;
function dragStart(e, id) { DRAG_ID = id; e.currentTarget.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; }
function dragEnd(e) { e.currentTarget.classList.remove('dragging'); }
function dragOver(e) { e.preventDefault(); e.currentTarget.classList.add('drag-over'); }
function dragLeave(e) { e.currentTarget.classList.remove('drag-over'); }
function dropCard(e, stage) {
  e.preventDefault(); e.currentTarget.classList.remove('drag-over');
  const d = DB.deals.find(x => x.id === DRAG_ID); DRAG_ID = null;
  if (!d || d.stage === stage) return;
  d.stage = stage; d.prob = stageOf(stage).prob;
  save(); toast(custName(d.custId) + ' → ' + stage);
  renderSales();
}

function renderDealList() {
  const q = ($('dl-search').value || '').trim().toLowerCase();
  const st = $('dl-stage').value;
  const rows = DB.deals.filter(d => {
    if (st && d.stage !== st) return false;
    if (q) return (custName(d.custId) + ' ' + d.product + ' ' + (d.rep || '')).toLowerCase().includes(q);
    return true;
  }).sort((a, b) => String(b.expectedDate).localeCompare(String(a.expectedDate)));
  $('deal-list-tbody').innerHTML = rows.length ? rows.map(d => {
    const n = dDays(d.nextActionDate);
    return `<tr>
      <td><a class="cust-link" onclick="openCustDetail('${d.custId}')">${esc(custName(d.custId))}</a></td>
      <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis">${esc(d.product)}</td>
      <td class="text-end fw-bold">${comma(d.amount)}</td>
      <td><span class="badge" style="background:${stageOf(d.stage).color}1a;color:${stageOf(d.stage).color}">${esc(d.stage)}</span></td>
      <td class="text-center">${num(d.prob)}%</td>
      <td>${fmtDate(d.expectedDate)}</td>
      <td>${esc(d.rep || '-')}</td>
      <td style="font-size:12px">${d.nextAction ? esc(d.nextAction) + (n != null && n < 0 ? ` <span class="dc-flag od">${-n}일</span>` : '') : '-'}</td>
      <td class="text-end"><button class="btn btn-sm btn-outline-secondary" onclick="openDrawer('${d.id}')">상세</button></td></tr>`;
  }).join('') : `<tr><td colspan="9" class="table-empty">딜이 없습니다</td></tr>`;
}

/* ── 딜 드로어 ── */
let DRAWER_ID = null;
function openDrawer(id) {
  const d = DB.deals.find(x => x.id === id); if (!d) return;
  DRAWER_ID = id;
  const c = custById(d.custId);
  const logs = DB.logs.filter(l => l.custId === d.custId).sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 6);
  $('deal-drawer').innerHTML = `
    <div class="dw-head">
      <div style="min-width:0">
        <div style="font-size:11px;font-weight:800;letter-spacing:.1em;color:#94a3b8">DEAL</div>
        <div style="font-size:17px;font-weight:800;margin-top:2px">${esc(custName(d.custId))}</div>
        <div style="font-size:12px;color:#64748b;margin-top:2px">${esc(d.product)}</div>
      </div>
      <button class="btn-close" onclick="closeDrawer()"></button>
    </div>
    <div class="dw-body">
      <div class="wt-band" style="padding:16px 18px;margin-bottom:16px">
        <div class="wt-hero"><div class="l">금액</div><b style="font-size:26px">${money(d.amount)}원</b>
          <div class="s">확률 ${num(d.prob)}% · 가중 ${money(num(d.amount) * num(d.prob) / 100)}원</div></div>
        <div class="wt-fact"><div class="l">단계</div>
          <b style="font-size:16px;color:${stageOf(d.stage).color}">${esc(d.stage)}</b>
          <div class="s">${fmtDate(d.expectedDate)} 예상</div></div>
      </div>
      <div class="wt-st">단계 변경</div>
      <div class="d-flex gap-1 flex-wrap mb-3">
        ${STAGES.map(s => `<span class="pipe-chip ${s.name === d.stage ? 'on' : ''}" onclick="drawerStage('${esc(s.name)}')">${esc(s.name)}</span>`).join('')}
      </div>
      <div class="wt-st">정보</div>
      <div class="dw-row"><div class="k">담당자</div><div class="v">${esc(d.rep || '-')}</div></div>
      <div class="dw-row"><div class="k">예상 수주일</div><div class="v">${fmtDate(d.expectedDate)}</div></div>
      <div class="dw-row"><div class="k">다음 액션</div><div class="v">${esc(d.nextAction || '-')}${d.nextActionDate ? ` <span style="color:#94a3b8">(${fmtDate(d.nextActionDate)})</span>` : ''}</div></div>
      <div class="dw-row"><div class="k">메모</div><div class="v" style="white-space:pre-wrap">${esc(d.memo || '-')}</div></div>
      <div class="dw-row"><div class="k">고객 등급</div><div class="v">${c ? `<span class="grade-badge grade-${esc(c.grade)}">${esc(c.grade)}</span> ${esc(c.sido || '')} ${esc(c.gugun || '')}` : '-'}</div></div>
      <div class="wt-st mt-3">최근 상담 (${logs.length})</div>
      ${logs.length ? logs.map(l => `<div style="padding:8px 0;border-bottom:1px solid #f3f4f6">
        <div style="font-size:11.5px;color:#94a3b8">${fmtDate(l.date)} · ${esc(l.type)} · ${esc(l.rep || '')}</div>
        <div style="font-size:12.5px;margin-top:2px">${esc(l.content)}</div></div>`).join('')
        : '<div style="color:#94a3b8;font-size:12.5px;padding:8px 0">상담 이력이 없습니다</div>'}
    </div>
    <div class="dw-foot">
      <button class="btn btn-outline-secondary btn-sm" onclick="closeDrawer();openCustDetail('${d.custId}')"><i class="bi bi-hospital me-1"></i>고객사</button>
      <button class="btn btn-outline-primary btn-sm" onclick="closeDrawer();openLogModal(null,'${d.custId}')"><i class="bi bi-journal-plus me-1"></i>일지</button>
      <button class="btn btn-primary btn-sm" onclick="closeDrawer();openDealModal('${d.id}')"><i class="bi bi-pencil me-1"></i>수정</button>
    </div>`;
  $('deal-drawer').classList.add('open');
  $('deal-drawer-bg').style.display = 'block';
}
function closeDrawer() { $('deal-drawer').classList.remove('open'); $('deal-drawer-bg').style.display = 'none'; DRAWER_ID = null; }
function drawerStage(s) {
  const d = DB.deals.find(x => x.id === DRAWER_ID); if (!d) return;
  d.stage = s; d.prob = stageOf(s).prob;
  if (s === '계약완료' || s === '실주') d.closedAt = today();
  save(); openDrawer(d.id); renderSales();
}

/* ── 딜 모달 ── */
function openDealModal(id, custId) {
  refreshSelects();
  const d = id ? DB.deals.find(x => x.id === id) : null;
  $('deal-modal-title').textContent = d ? '딜 수정' : '딜 추가';
  $('d-del-btn').style.display = d ? 'inline-block' : 'none';
  $('d-id').value = d ? d.id : '';
  $('d-cust').value = d ? custName(d.custId) : (custId ? custName(custId) : '');
  $('d-product').value = d ? (d.product || '') : '';
  $('d-qty').value = d ? (d.qty || 1) : 1;
  $('d-amount').value = d ? comma(d.amount) : '';
  $('d-stage').value = d ? d.stage : '상담중';
  $('d-prob').value = d ? num(d.prob) : 25;
  $('d-rep').value = d ? (d.rep || '') : '';
  $('d-expected').value = d ? (d.expectedDate || '') : '';
  $('d-next').value = d ? (d.nextAction || '') : '';
  $('d-next-date').value = d ? (d.nextActionDate || '') : '';
  $('d-memo').value = d ? (d.memo || '') : '';
  new bootstrap.Modal($('dealModal')).show();
}
function dealProdChange() { dealCalc(); }
function dealCalc() {
  const p = prodByName(trimv($('d-product').value));
  if (!p) return;
  $('d-amount').value = comma(num(p.price) * Math.max(1, num($('d-qty').value)));
}
function dealStageChange() { $('d-prob').value = stageOf($('d-stage').value).prob; }
function saveDeal() {
  if (!trimv($('d-cust').value)) return alert('고객사를 입력하거나 선택해주세요.');
  if (!trimv($('d-product').value)) return alert('제품을 입력하거나 선택해주세요.');
  const amt = num($('d-amount').value);
  if (!amt) return alert('금액을 입력해주세요.');
  const custId = resolveCust($('d-cust').value);
  const code = resolveProd($('d-product').value);
  const p = prodByCode(code);
  const id = $('d-id').value;
  const row = {
    custId, productCode: code, product: p ? p.name : code, qty: num($('d-qty').value) || 1, amount: amt,
    stage: $('d-stage').value, prob: num($('d-prob').value), rep: resolveRep($('d-rep').value),
    expectedDate: $('d-expected').value, nextAction: $('d-next').value.trim(),
    nextActionDate: $('d-next-date').value, memo: $('d-memo').value.trim()
  };
  if (id) {
    const d = DB.deals.find(x => x.id === id);
    Object.assign(d, row);
    if ((row.stage === '계약완료' || row.stage === '실주') && !d.closedAt) d.closedAt = today();
  } else {
    DB.deals.push(Object.assign({ id: uid(), createdAt: today(), closedAt: '' }, row));
  }
  save();
  bootstrap.Modal.getInstance($('dealModal')).hide();
  renderSales(); if (CUR_PAGE === 'overview') renderOverview();
}
function deleteDeal() {
  if (!ensureAdmin()) return;
  const id = $('d-id').value; if (!id) return;
  if (!confirm('이 딜을 삭제할까요?')) return;
  DB.deals = DB.deals.filter(x => x.id !== id);
  save(); bootstrap.Modal.getInstance($('dealModal')).hide(); renderSales();
}

/* ── 상담일지 ── */
function renderLogs() {
  const q = ($('log-search').value || '').trim().toLowerCase();
  const rows = DB.logs.filter(l => !q || (custName(l.custId) + ' ' + l.content + ' ' + (l.rep || '') + ' ' + (l.type || '')).toLowerCase().includes(q))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  $('log-tbody').innerHTML = rows.length ? rows.map(l => `<tr>
    <td>${fmtDate(l.date)}</td>
    <td><a class="cust-link" onclick="openCustDetail('${l.custId}')">${esc(custName(l.custId))}</a></td>
    <td><span class="badge" style="background:#f1f5f9;color:#475569">${esc(l.type)}</span></td>
    <td style="max-width:340px;white-space:normal">${esc(l.content)}</td>
    <td style="font-size:12px;color:#64748b">${esc(l.interest || '-')}</td>
    <td style="font-size:12px">${esc(l.nextAction || '-')}</td>
    <td>${esc(l.rep || '-')}</td>
    <td class="text-end"><button class="btn btn-sm btn-outline-secondary" onclick="openLogModal('${l.id}')"><i class="bi bi-pencil"></i></button></td>
  </tr>`).join('') : `<tr><td colspan="8" class="table-empty">상담일지가 없습니다</td></tr>`;
}
function openLogModal(id, custId) {
  refreshSelects();
  const l = id ? DB.logs.find(x => x.id === id) : null;
  $('log-modal-title').textContent = l ? '상담일지 수정' : '상담일지 작성';
  $('l-del-btn').style.display = l ? 'inline-block' : 'none';
  $('l-id').value = l ? l.id : '';
  $('l-date').value = l ? l.date : today();
  $('l-cust').value = l ? custName(l.custId) : (custId ? custName(custId) : '');
  $('l-type').value = l ? l.type : '방문';
  $('l-interest').value = l ? (l.interest || '') : '';
  $('l-rep').value = l ? (l.rep || '') : '';
  $('l-content').value = l ? l.content : '';
  $('l-next').value = l ? (l.nextAction || '') : '';
  $('l-next-date').value = l ? (l.nextActionDate || '') : '';
  new bootstrap.Modal($('logModal')).show();
}
function saveLog() {
  if (!trimv($('l-cust').value)) return alert('고객사를 입력하거나 선택해주세요.');
  if (!$('l-content').value.trim()) return alert('상담 내용을 입력해주세요.');
  const p = prodByCode(resolveProd($('l-interest').value));
  const row = { custId: resolveCust($('l-cust').value), date: $('l-date').value || today(), type: $('l-type').value,
    interest: p ? p.name : '', rep: resolveRep($('l-rep').value), content: $('l-content').value.trim(),
    nextAction: $('l-next').value.trim(), nextActionDate: $('l-next-date').value };
  const id = $('l-id').value;
  if (id) Object.assign(DB.logs.find(x => x.id === id), row);
  else DB.logs.push(Object.assign({ id: uid() }, row));
  save();
  bootstrap.Modal.getInstance($('logModal')).hide();
  if (CUR_PAGE === 'sales') renderLogs(); else RENDER[CUR_PAGE]();
}
function deleteLog() {
  if (!ensureAdmin()) return;
  const id = $('l-id').value; if (!id || !confirm('이 일지를 삭제할까요?')) return;
  DB.logs = DB.logs.filter(x => x.id !== id);
  save(); bootstrap.Modal.getInstance($('logModal')).hide(); renderLogs();
}

/* ═══════════════ 8. 일정 (원텍 한국영업 3뷰 구조 이식) ═══════════════ */
const SCH_COL = { '방문':'#0e7490', '전화':'#0891b2', '데모/시연':'#7c3aed', '설치':'#16a34a',
                  'A/S':'#ea580c', '학회':'#a21caf', '내부':'#64748b' };
const schCol = t => SCH_COL[t] || '#64748b';
let SCH_VIEW = 'week';   /* today | week | month */
let SCH_REF = null;      /* 기준일(null = 오늘) */

function schToday() { return today(); }
function schWeekRange(ref) {
  const base = parseD(ref || today()) || new Date();
  const dow = (base.getDay() + 6) % 7;              /* 월요일 시작 */
  const mon = new Date(base); mon.setDate(base.getDate() - dow);
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  return { start: ymd(mon), end: ymd(sun) };
}
function setSchView(v, btn) {
  SCH_VIEW = v; SCH_REF = null;
  document.querySelectorAll('#page-schedule .btn-group .btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderSchedule();
}
function schSyncViewBtn() {
  const m = { today: 'sch-v-today', week: 'sch-v-week', month: 'sch-v-month' };
  document.querySelectorAll('#page-schedule .btn-group .btn').forEach(b => b.classList.remove('active'));
  const b = $(m[SCH_VIEW]); if (b) b.classList.add('active');
}
function schShift(d) {
  const step = SCH_VIEW === 'week' ? 7 : SCH_VIEW === 'month' ? 0 : 1;
  const base = parseD(SCH_REF || today());
  if (SCH_VIEW === 'month') base.setMonth(base.getMonth() + d);
  else base.setDate(base.getDate() + d * step);
  SCH_REF = ymd(base);
  renderSchedule();
}
function schNavBtns() {
  return '<button class="btn btn-sm btn-outline-secondary" onclick="schShift(-1)"><i class="bi bi-chevron-left"></i></button> '
    + '<button class="btn btn-sm btn-outline-secondary" onclick="SCH_REF=null;renderSchedule()">오늘</button> '
    + '<button class="btn btn-sm btn-outline-secondary" onclick="schShift(1)"><i class="bi bi-chevron-right"></i></button>';
}
function schMine() {
  const me = (ME && (ME.display_name || String(ME.email || '').split('@')[0])) || '';
  const sel = $('sch-rep');
  const hit = [...sel.options].find(o => o.value && (o.value === me || me.indexOf(o.value) >= 0 || o.value.indexOf(me) >= 0));
  if (!hit) { toast('내 이름과 일치하는 담당자가 없습니다 (설정에서 담당자 등록)'); return; }
  sel.value = hit.value;
  renderSchedule();
}
function schItems() {
  const rep = $('sch-rep').value;
  return DB.schedules.filter(s => !rep || s.rep === rep);
}

/* ── 통계바 (.cdud) ── */
function schStatsBar(all) {
  const td = today();
  const dayRef = (SCH_VIEW === 'today' && SCH_REF) ? SCH_REF : td;
  const navWk = !!SCH_REF && (SCH_VIEW === 'week' || SCH_VIEW === 'today');
  const wk = schWeekRange(navWk ? SCH_REF : null);
  const wkLbl = navWk ? (fmtDate(wk.start).slice(5) + '~' + fmtDate(wk.end).slice(5) + ' 일정') : '이번주 일정';

  const tArr = all.filter(i => i.date === dayRef);
  const t = tArr.length, tDone = tArr.filter(i => i.done).length, tVisit = tArr.filter(i => i.type === '방문').length;
  const wArr = all.filter(i => i.date >= wk.start && i.date <= wk.end);
  const w = wArr.length, wDone = wArr.filter(i => i.done).length, wVisit = wArr.filter(i => i.type === '방문').length;
  const pendArr = all.filter(i => !i.done && i.date >= td);
  const nextUp = pendArr.filter(i => i.date > td).map(i => i.date).sort()[0] || '';
  const overdue = all.filter(i => !i.done && i.date < td).length;
  const doneWk = wArr.filter(i => i.done);
  const noRes = all.filter(i => i.done && !String(i.result || '').trim()).length;

  const byType = {};
  all.forEach(i => { byType[i.type] = (byType[i.type] || 0) + 1; });
  const legend = Object.keys(SCH_COL).map(x =>
    '<span style="font-size:10.5px;color:#64748b;font-weight:600"><span style="display:inline-block;width:9px;height:9px;border-radius:3px;background:'
    + SCH_COL[x] + ';margin-right:4px;vertical-align:middle"></span>' + x
    + (byType[x] ? ' <span style="color:#94a3b8">' + byType[x] + '</span>' : '') + '</span>').join('');

  const sf = (lbl, n, sub, cl, click) => '<div class="cdud-fact' + (click ? ' clk" onclick="' + click + '"' : '"') + '>'
    + '<span>' + lbl + '</span><b' + (cl ? ' class="' + cl + '"' : '') + '>' + n + '</b>' + (sub ? '<i>' + sub + '</i>' : '') + '</div>';

  return '<div class="cdud" style="padding:16px 20px;margin:0 0 12px">'
    + '<div class="cdud-kpis" style="border-bottom:0;padding:2px 0 4px">'
    + '<div class="cdud-hero" style="flex:1.4" onclick="setSchView(\'week\',document.getElementById(\'sch-v-week\'))">'
    + '<span class="l">' + wkLbl + '</span><b>' + w + '건</b>'
    + '<span class="s">방문 ' + wVisit + ' · 완료 ' + wDone + '/' + w + (nextUp ? ' · 다음 예정 ' + fmtDate(nextUp).slice(5) : '') + '</span></div>'
    + sf(dayRef === td ? '오늘' : fmtDate(dayRef).slice(5), t + '건', '방문 ' + tVisit + ' · 완료 ' + tDone, '', "setSchView('today',document.getElementById('sch-v-today'))")
    + sf('놓친 일정', overdue + '건', overdue ? '눌러서 결과 입력' : '없음 👍', overdue ? 'rd' : '', overdue ? 'schOverdue()' : '')
    + sf('예정', pendArr.length + '건', nextUp ? '다음 ' + fmtDate(nextUp).slice(5) : '오늘 이후', '', "setSchView('week',document.getElementById('sch-v-week'))")
    + sf('완료', doneWk.length + '건', (navWk ? '선택 주' : '이번주') + (noRes ? ' · 결과누락 ' + noRes : ''), noRes ? '' : 'gr', '')
    + '</div>'
    + '<div style="display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;padding-top:10px;margin-top:6px;border-top:1px solid #e4e8ef">'
    + '<span style="font-size:10.5px;color:#64748b;font-weight:700">유형</span>' + legend + '</div></div>';
}

/* ── 미니 카드 (주간/월간 셀) ── */
function schMiniCard(s) {
  return '<div class="sc-mini' + (s.done ? ' done' : '') + '" style="border-left-color:' + schCol(s.type) + '"'
    + ' onclick="event.stopPropagation();openSchModal(\'' + s.id + '\')">'
    + '<div class="m-c">' + esc(s.custId ? custName(s.custId) : '내부') + '</div>'
    + '<div class="m-s">' + (s.time ? esc(s.time) + ' · ' : '') + esc(s.type) + (s.rep ? ' · ' + esc(s.rep) : '') + '</div></div>';
}
/* ── 주간 7열 그리드 ── */
function schWeekGrid(items, wref) {
  const wk = schWeekRange(wref || SCH_REF);
  const mon = parseD(wk.start);
  const WD = ['월','화','수','목','금','토','일'];
  const byd = {};
  items.forEach(i => { if (i.date >= wk.start && i.date <= wk.end) (byd[i.date] = byd[i.date] || []).push(i); });
  const td = today();
  let cols = '';
  for (let idx = 0; idx < 7; idx++) {
    const dt = new Date(mon); dt.setDate(mon.getDate() + idx);
    const ds = ymd(dt), isT = ds === td;
    const its = (byd[ds] || []).sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));
    const col = isT ? '#0e7490' : idx === 5 ? '#2563eb' : idx === 6 ? '#dc2626' : '#475569';
    cols += '<div class="sw-col' + (isT ? ' today' : '') + '" title="이 날짜에 일정 추가" onclick="openSchModal(null,\'' + ds + '\')">'
      + '<div class="sw-hd" style="color:' + col + '">' + WD[idx] + ' <span class="d">' + dt.getDate() + '일</span>'
      + (isT ? ' <span style="font-size:9px">●오늘</span>' : '') + '</div>'
      + '<div class="sw-body">' + (its.length ? its.map(schMiniCard).join('')
        : '<div class="sw-empty"><i class="bi bi-plus-circle" style="opacity:.4"></i></div>') + '</div></div>';
  }
  return '<div class="sw-wrap"><div class="sw-grid">' + cols + '</div></div>';
}
/* ── 목록 뷰 (날짜별 카드) ── */
function schListView(list) {
  if (!list.length) return '<div class="text-center text-muted py-5" style="font-size:13px">'
    + '<i class="bi bi-calendar-x" style="font-size:24px;color:#cbd5e1"></i>'
    + '<div class="mt-2">일정이 없습니다. <b>일정 추가</b>로 방문·콜을 등록하세요.</div></div>';
  const byd = {};
  list.forEach(i => { (byd[i.date] = byd[i.date] || []).push(i); });
  const WD = ['일','월','화','수','목','금','토'];
  return Object.keys(byd).sort().map(d => {
    const its = byd[d].sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));
    const wd = WD[(parseD(d) || new Date()).getDay()];
    return '<div class="card mb-2"><div class="card-body p-0">'
      + '<div class="sc-daybar">' + fmtDate(d).slice(5) + ' (' + wd + ') <span style="color:#64748b;font-weight:400">' + its.length + '건</span></div>'
      + its.map(schItemRow).join('') + '</div></div>';
  }).join('');
}
function schItemRow(s) {
  const c = schCol(s.type);
  const od = !s.done && s.date < today();
  return '<div class="sc-row" onclick="openSchModal(\'' + s.id + '\')">'
    + '<span style="width:44px;flex-shrink:0;color:#64748b;font-weight:600">' + esc(s.time || '-') + '</span>'
    + '<span class="sc-type" style="background:' + c + '1a;color:' + c + '">' + esc(s.type) + '</span>'
    + '<span style="width:140px;flex-shrink:0;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'
    + esc(s.custId ? custName(s.custId) : '내부') + '</span>'
    + '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(s.title)
    + (s.result ? ' <span style="color:#15803d">→ ' + esc(s.result) + '</span>' : '') + '</span>'
    + '<span style="width:50px;flex-shrink:0;color:#94a3b8;font-size:11px;text-align:right">' + esc(s.rep || '') + '</span>'
    + (s.done ? '<span class="sc-type" style="background:#f0fdf4;color:#15803d">완료</span>'
      : od ? '<span class="sc-type" style="background:#fef2f2;color:#dc2626">놓침</span>'
      : '<span class="sc-type" style="background:#fff7ed;color:#ea580c">대기</span>') + '</div>';
}
/* ── 월간 달력 ── */
function schMonthView(items) {
  const base = parseD(SCH_REF || today()) || new Date();
  const y = base.getFullYear(), m = base.getMonth() + 1;
  const startDow = (new Date(y, m - 1, 1).getDay() + 6) % 7;   /* 월요일 시작 */
  const lastDay = new Date(y, m, 0).getDate();
  const byd = {};
  items.forEach(i => { (byd[i.date] = byd[i.date] || []).push(i); });
  const WD = ['월','화','수','목','금','토','일'];
  let html = WD.map((d, i) => '<div class="cal-dow" style="color:' + (i === 5 ? '#2563eb' : i === 6 ? '#dc2626' : '#475569') + '">' + d + '</div>').join('');
  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= lastDay; d++) cells.push(d);
  while (cells.length % 7) cells.push(null);
  cells.forEach((d, i) => {
    if (d == null) { html += '<div class="cal-cell other"></div>'; return; }
    const ds = y + '-' + pad(m) + '-' + pad(d);
    const its = (byd[ds] || []).sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));
    const dow = i % 7;
    html += '<div class="cal-cell' + (ds === today() ? ' today' : '') + '" onclick="openDayModal(\'' + ds + '\')">'
      + '<div class="d ' + (dow === 6 ? 'sun' : dow === 5 ? 'sat' : '') + '">' + d + '</div>'
      + its.slice(0, 3).map(s => '<div class="cal-ev' + (s.done ? ' done' : '') + '" style="background:' + schCol(s.type)
        + '1f;color:' + schCol(s.type) + '">' + (s.time ? esc(s.time) + ' ' : '') + esc(s.custId ? custName(s.custId) : s.title) + '</div>').join('')
      + (its.length > 3 ? '<div class="cal-more">+' + (its.length - 3) + '건</div>' : '') + '</div>';
  });
  return '<div id="cal-scroll"><div class="cal-grid" id="cal-grid">' + html + '</div></div>';
}
let SCH_OVERDUE = false;
function schOverdue() { SCH_OVERDUE = true; renderSchedule(); }

function renderSchedule() {
  if (!$('sch-body')) return;
  schSyncViewBtn();
  fillSelect($('sch-rep'), repNames(), { blank: '👥 담당 전체', keep: true });
  const all = schItems();
  const repV = $('sch-rep').value;
  $('sch-stats').innerHTML = schStatsBar(all);
  const body = $('sch-body'), title = $('sch-title'), nav = $('sch-nav');
  nav.innerHTML = ''; title.textContent = '';

  if (SCH_OVERDUE) {
    const list = all.filter(i => !i.done && i.date < today()).sort((a, b) => String(b.date).localeCompare(String(a.date)));
    title.innerHTML = '<span style="color:#dc2626">놓친 일정</span> ' + list.length + '건'
      + (repV ? ' · ' + esc(repV) : '')
      + ' <button class="btn btn-sm btn-link p-0 ms-2" style="font-size:12px" onclick="SCH_OVERDUE=false;renderSchedule()">전체 보기로 돌아가기</button>';
    body.innerHTML = schListView(list);
    return;
  }
  if (SCH_VIEW === 'month') {
    const base = parseD(SCH_REF || today()) || new Date();
    title.textContent = base.getFullYear() + '년 ' + (base.getMonth() + 1) + '월 · '
      + all.filter(i => String(i.date).slice(0, 7) === base.getFullYear() + '-' + pad(base.getMonth() + 1)).length + '건'
      + (repV ? ' · ' + repV : '');
    nav.innerHTML = schNavBtns();
    body.innerHTML = schMonthView(all);
  } else if (SCH_VIEW === 'week') {
    const wk = schWeekRange(SCH_REF);
    const isCur = today() >= wk.start && today() <= wk.end;
    title.textContent = (isCur ? '이번주 ' : '') + fmtDate(wk.start).slice(5) + '~' + fmtDate(wk.end).slice(5)
      + ' · ' + all.filter(i => i.date >= wk.start && i.date <= wk.end).length + '건' + (repV ? ' · ' + repV : '');
    nav.innerHTML = schNavBtns();
    body.innerHTML = schWeekGrid(all);
  } else {
    const ref = SCH_REF || today();
    const list = all.filter(i => i.date === ref);
    const WDD = ['일','월','화','수','목','금','토'][(parseD(ref) || new Date()).getDay()];
    title.textContent = (ref === today() ? '오늘 ' : '') + fmtDate(ref).slice(5) + ' (' + WDD + ') · ' + list.length + '건' + (repV ? ' · ' + repV : '');
    nav.innerHTML = schNavBtns();
    body.innerHTML = schListView(list);
  }
}

/* ── 일 요약 ── */
function openDaySum() {
  $('daysum-date').value = SCH_REF || today();
  renderDaySum();
  new bootstrap.Modal($('daySumModal')).show();
}
function renderDaySum() {
  const d = $('daysum-date').value || today();
  const WDD = ['일','월','화','수','목','금','토'][(parseD(d) || new Date()).getDay()];
  $('daysum-title').textContent = '일 요약 · ' + fmtDate(d) + ' (' + WDD + ')';
  const sch = DB.schedules.filter(s => s.date === d);
  const logs = DB.logs.filter(l => l.date === d);
  const deals = DB.deals.filter(x => x.expectedDate === d && x.stage === '계약완료');
  const reps = [...new Set([].concat(sch.map(s => s.rep), logs.map(l => l.rep)).filter(Boolean))];
  const byRep = reps.map(r => {
    const ss = sch.filter(s => s.rep === r), ll = logs.filter(l => l.rep === r);
    return '<div style="border:1px solid var(--border);border-radius:10px;padding:11px 13px;margin-bottom:8px">'
      + '<div style="font-size:13px;font-weight:800;margin-bottom:6px">' + esc(r)
      + ' <span style="font-size:11px;font-weight:500;color:#64748b">일정 ' + ss.length + ' · 상담 ' + ll.length + '</span></div>'
      + (ss.length ? ss.map(s => '<div style="font-size:12px;padding:3px 0;color:#334155">'
          + '<span style="color:' + schCol(s.type) + ';font-weight:700">[' + esc(s.type) + ']</span> '
          + esc(s.custId ? custName(s.custId) : '내부') + ' — ' + esc(s.title)
          + (s.done ? (s.result ? ' <span style="color:#15803d">→ ' + esc(s.result) + '</span>' : ' <span style="color:#15803d">(완료)</span>')
                    : ' <span style="color:#ea580c">(대기)</span>') + '</div>').join('') : '')
      + (ll.length ? ll.map(l => '<div style="font-size:12px;padding:3px 0;color:#64748b">'
          + '<i class="bi bi-journal-text me-1"></i>' + esc(custName(l.custId)) + ' — ' + esc(l.content) + '</div>').join('') : '')
      + '</div>';
  }).join('');
  $('daysum-body').innerHTML = '<div class="cdud" style="padding:16px 20px;margin:0 0 14px">'
    + '<div class="cdud-kpis" style="border-bottom:0;padding:2px 0 4px">'
    + '<div class="cdud-hero" style="cursor:default"><span class="l">일정</span><b>' + sch.length + '건</b>'
    + '<span class="s">완료 ' + sch.filter(s => s.done).length + ' · 대기 ' + sch.filter(s => !s.done).length + '</span></div>'
    + '<div class="cdud-fact"><span>방문</span><b>' + sch.filter(s => s.type === '방문').length + '</b></div>'
    + '<div class="cdud-fact"><span>상담일지</span><b>' + logs.length + '</b></div>'
    + '<div class="cdud-fact"><span>당일 수주</span><b class="gr">' + money(deals.reduce((s, x) => s + num(x.amount), 0)) + '</b>'
    + '<i>' + deals.length + '건</i></div></div></div>'
    + (byRep || '<div class="text-center text-muted py-4" style="font-size:13px">해당 일자 기록이 없습니다</div>');
}

let DAY_SEL = null;
function openDayModal(ds) {
  DAY_SEL = ds;
  const rep = $('sch-rep').value;
  const evs = DB.schedules.filter(s => s.date === ds && (!rep || s.rep === rep)).sort((a, b) => String(a.time).localeCompare(String(b.time)));
  $('day-modal-title').textContent = fmtDate(ds) + ' 일정 (' + evs.length + ')';
  $('day-modal-body').innerHTML = evs.length ? evs.map(s => schItemRow(s)).join('')
    : `<div class="text-center" style="padding:24px;color:#94a3b8;font-size:13px">일정이 없습니다</div>`;
  new bootstrap.Modal($('dayModal')).show();
}
function addSchForDay() {
  bootstrap.Modal.getInstance($('dayModal')).hide();
  setTimeout(() => { openSchModal(); $('s-date').value = DAY_SEL || today(); }, 300);
}
function openSchModal(id, preDate) {
  refreshSelects();
  const s = id ? DB.schedules.find(x => x.id === id) : null;
  $('sch-modal-title').textContent = s ? '일정 수정' : '일정 추가';
  $('s-del-btn').style.display = s ? 'inline-block' : 'none';
  $('s-id').value = s ? s.id : '';
  $('s-date').value = s ? s.date : (preDate || today());
  $('s-time').value = s ? (s.time || '') : '';
  $('s-cust').value = s ? (s.custId ? custName(s.custId) : '') : '';
  $('s-type').value = s ? s.type : '방문';
  $('s-rep').value = s ? (s.rep || '') : '';
  $('s-title').value = s ? s.title : '';
  $('s-done').checked = s ? !!s.done : false;
  $('s-result').value = s ? (s.result || '') : '';
  $('s-result-wrap').style.display = (s && s.done) ? 'block' : 'none';
  new bootstrap.Modal($('schModal')).show();
}
function saveSch() {
  if (!$('s-title').value.trim()) return alert('내용을 입력해주세요.');
  const row = { date: $('s-date').value || today(), time: $('s-time').value, custId: resolveCust($('s-cust').value),
    type: $('s-type').value, rep: resolveRep($('s-rep').value), title: $('s-title').value.trim(),
    done: $('s-done').checked, result: $('s-result').value.trim() };
  const id = $('s-id').value;
  if (id) Object.assign(DB.schedules.find(x => x.id === id), row);
  else DB.schedules.push(Object.assign({ id: uid() }, row));
  save();
  bootstrap.Modal.getInstance($('schModal')).hide();
  RENDER[CUR_PAGE]();
}
function deleteSch() {
  if (!ensureAdmin()) return;
  const id = $('s-id').value; if (!id || !confirm('이 일정을 삭제할까요?')) return;
  DB.schedules = DB.schedules.filter(x => x.id !== id);
  save(); bootstrap.Modal.getInstance($('schModal')).hide(); RENDER[CUR_PAGE]();
}

/* ───────────────────────── 9. 견적서 ───────────────────────── */
function quoteCalc(items) {
  let sub = 0, disc = 0;
  (items || []).forEach(it => {
    const gross = num(it.qty) * num(it.price);
    const d = gross * num(it.disc) / 100;
    sub += gross - d; disc += d;
  });
  const vat = Math.round(sub * 0.1);
  return { sub: Math.round(sub), disc: Math.round(disc), vat, total: Math.round(sub) + vat };
}
function renderQuotes() {
  const q = ($('q-search').value || '').trim().toLowerCase();
  const st = $('q-status').value;
  const all = DB.quotes.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const tot = all.reduce((s, x) => s + quoteCalc(x.items).total, 0);
  const sent = all.filter(x => x.status === '발송');
  const wonQ = all.filter(x => x.status === '수주');
  $('quote-band').innerHTML = `
    <div class="wt-hero"><div class="l">견적 총액 (VAT 포함)</div><b>${money(tot)}원</b><div class="s">전체 ${all.length}건</div></div>
    <div class="wt-fact"><div class="l">발송 대기·진행</div><b>${sent.length}</b><div class="s">${money(sent.reduce((s, x) => s + quoteCalc(x.items).total, 0))}원</div></div>
    <div class="wt-fact"><div class="l">수주 전환</div><b class="gr">${wonQ.length}</b><div class="s">${money(wonQ.reduce((s, x) => s + quoteCalc(x.items).total, 0))}원</div></div>
    <div class="wt-fact"><div class="l">견적 성공률</div><b>${(wonQ.length + all.filter(x => x.status === '실주').length) ? Math.round(wonQ.length / (wonQ.length + all.filter(x => x.status === '실주').length) * 100) : 0}%</b><div class="s">수주/종결 기준</div></div>`;

  const rows = all.filter(x => {
    if (st && x.status !== st) return false;
    if (q) return (x.no + ' ' + custName(x.custId) + ' ' + (x.rep || '')).toLowerCase().includes(q);
    return true;
  });
  const stColor = { '임시저장': '#64748b', '발송': '#0e7490', '수주': '#16a34a', '실주': '#dc2626' };
  $('quote-tbody').innerHTML = rows.length ? rows.map(x => {
    const c = quoteCalc(x.items);
    const until = x.date ? (() => { const d = parseD(x.date); d.setDate(d.getDate() + num(x.validDays || 30)); return ymd(d); })() : '';
    const expired = until && until < today() && x.status === '발송';
    return `<tr>
      <td class="fw-bold">${esc(x.no)}</td>
      <td><a class="cust-link" onclick="openCustDetail('${x.custId}')">${esc(custName(x.custId))}</a></td>
      <td>${fmtDate(x.date)}</td>
      <td>${fmtDate(until)}${expired ? ' <span class="dc-flag od">만료</span>' : ''}</td>
      <td>${esc(x.rep || '-')}</td>
      <td class="text-end fw-bold">${comma(c.total)}</td>
      <td><span class="badge" style="background:${stColor[x.status]}1a;color:${stColor[x.status]}">${esc(x.status)}</span></td>
      <td class="text-end" style="white-space:nowrap">
        <button class="btn btn-sm btn-outline-secondary" onclick="printQuote('${x.id}')" title="인쇄"><i class="bi bi-printer"></i></button>
        <button class="btn btn-sm btn-outline-secondary ms-1" onclick="openQuoteModal('${x.id}')"><i class="bi bi-pencil"></i></button></td></tr>`;
  }).join('') : `<tr><td colspan="8" class="table-empty">견적서가 없습니다</td></tr>`;
}
function openQuoteModal(id) {
  refreshSelects();
  const x = id ? DB.quotes.find(v => v.id === id) : null;
  $('quote-modal-title').textContent = x ? '견적서 수정 · ' + x.no : '견적서 작성';
  $('q-del-btn').style.display = x ? 'inline-block' : 'none';
  $('q-id').value = x ? x.id : '';
  $('q-cust').value = x ? custName(x.custId) : '';
  $('q-date').value = x ? x.date : today();
  $('q-valid').value = x ? num(x.validDays || 30) : 30;
  $('q-rep').value = x ? (x.rep || '') : '';
  $('q-memo').value = x ? (x.memo || '') : '설치·기본 교육 포함 / 소모품 별도';
  $('q-status-in').value = x ? x.status : '임시저장';
  $('q-items').innerHTML = '';
  (x && x.items && x.items.length ? x.items : [{ code: '', qty: 1, price: 0, disc: 0 }]).forEach(it => addQuoteItem(it));
  quoteRecalc();
  new bootstrap.Modal($('quoteModal')).show();
}
function addQuoteItem(it) {
  it = it || { code: '', qty: 1, price: 0, disc: 0 };
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="text" class="form-control form-control-sm qi-name" list="dl-prod" autocomplete="off"
      placeholder="제품명 입력 · 선택" value="${esc(it.name || (prodByCode(it.code) || {}).name || '')}" oninput="qiProd(this)"></td>
    <td><input type="number" class="form-control form-control-sm qi-qty" min="1" value="${num(it.qty) || 1}" oninput="quoteRecalc()"></td>
    <td><input type="text" class="form-control form-control-sm qi-price" inputmode="numeric" value="${comma(it.price)}" oninput="commaInput(this);quoteRecalc()"></td>
    <td><input type="number" class="form-control form-control-sm qi-disc" min="0" max="100" value="${num(it.disc)}" oninput="quoteRecalc()"></td>
    <td class="text-end fw-bold qi-amt" style="font-variant-numeric:tabular-nums">0</td>
    <td class="text-end"><button class="btn btn-sm btn-outline-secondary" onclick="this.closest('tr').remove();quoteRecalc()"><i class="bi bi-x"></i></button></td>`;
  $('q-items').appendChild(tr);
  quoteRecalc();
}
function qiProd(el) {
  const p = prodByName(trimv(el.value));
  const tr = el.closest('tr');
  if (p) tr.querySelector('.qi-price').value = comma(p.price);
  quoteRecalc();
}
function readQuoteItems() {
  return [...$('q-items').querySelectorAll('tr')].map(tr => {
    const nm = trimv(tr.querySelector('.qi-name').value);
    const p = prodByName(nm);
    return { code: p ? p.code : '', name: nm, qty: num(tr.querySelector('.qi-qty').value) || 1,
      price: num(tr.querySelector('.qi-price').value), disc: num(tr.querySelector('.qi-disc').value) };
  }).filter(it => it.name);
}
function quoteRecalc() {
  [...$('q-items').querySelectorAll('tr')].forEach(tr => {
    const qty = num(tr.querySelector('.qi-qty').value) || 1;
    const price = num(tr.querySelector('.qi-price').value);
    const disc = num(tr.querySelector('.qi-disc').value);
    tr.querySelector('.qi-amt').textContent = comma(Math.round(qty * price * (1 - disc / 100)));
  });
  const c = quoteCalc(readQuoteItems());
  $('q-subtotal').textContent = won(c.sub);
  $('q-discount').textContent = '-' + won(c.disc);
  $('q-vat').textContent = won(c.vat);
  $('q-total').textContent = won(c.total);
}
function nextQuoteNo() {
  const yy = String(new Date().getFullYear()).slice(2);
  const seq = DB.quotes.filter(q => String(q.no).startsWith('UL' + yy)).length + 1;
  return 'UL' + yy + '-' + pad(seq);
}
function saveQuote(doPrint) {
  const items = readQuoteItems();
  if (!trimv($('q-cust').value)) return alert('고객사를 입력하거나 선택해주세요.');
  if (!items.length) return alert('품목을 1개 이상 추가해주세요.');
  items.forEach(it => { if (!it.code) it.code = resolveProd(it.name); });
  const row = { custId: resolveCust($('q-cust').value), date: $('q-date').value || today(), validDays: num($('q-valid').value) || 30,
    rep: resolveRep($('q-rep').value), items, memo: $('q-memo').value.trim(), status: $('q-status-in').value };
  const id = $('q-id').value;
  let qid = id;
  if (id) Object.assign(DB.quotes.find(x => x.id === id), row);
  else { qid = uid(); DB.quotes.push(Object.assign({ id: qid, no: nextQuoteNo() }, row)); }
  save();
  bootstrap.Modal.getInstance($('quoteModal')).hide();
  renderQuotes();
  if (doPrint) setTimeout(() => printQuote(qid), 350);
}
function deleteQuote() {
  if (!ensureAdmin()) return;
  const id = $('q-id').value; if (!id || !confirm('이 견적서를 삭제할까요?')) return;
  DB.quotes = DB.quotes.filter(x => x.id !== id);
  save(); bootstrap.Modal.getInstance($('quoteModal')).hide(); renderQuotes();
}
/* 금액 한글 표기 (견적서 상용) */
function hangulMoney(v) {
  let x = Math.round(num(v));
  if (!x) return '영';
  const D = ['','일','이','삼','사','오','육','칠','팔','구'];
  const S = ['','십','백','천'];
  const B = ['','만','억','조'];
  let out = '', bi = 0;
  while (x > 0) {
    let grp = x % 10000; x = Math.floor(x / 10000);
    if (grp) {
      let g = '', si = 0;
      while (grp > 0) { const d = grp % 10; if (d) g = D[d] + S[si] + g; grp = Math.floor(grp / 10); si++; }
      out = g + B[bi] + out;
    }
    bi++;
  }
  return out;
}
function quoteHTML(x) {
  const c = quoteCalc(x.items), cu = custById(x.custId) || {};
  const until = (() => { const d = parseD(x.date) || new Date(); d.setDate(d.getDate() + num(x.validDays || 30)); return ymd(d); })();
  const row = (k, v) => '<tr><th>' + esc(k) + '</th><td>' + esc(v || '') + '</td></tr>';
  return '<div class="qp">'
    + '<div class="qp-brand"><div class="qp-mark">U</div><div>'
      + '<div class="qp-co">주식회사 유로링크</div>'
      + '<div class="qp-co-sub">UroLink Co., Ltd. · 비뇨의학과 의료기기</div></div>'
      + '<div class="qp-meta"><div>견적번호 <b>' + esc(x.no) + '</b></div>'
      + '<div>견적일 ' + fmtDate(x.date) + '</div>'
      + '<div>유효기한 ' + fmtDate(until) + '</div></div></div>'
    + '<div class="qp-title">견 적 서</div>'
    + '<div class="qp-parties">'
      + '<table><caption>수신</caption>'
        + row('상 호', custName(x.custId)) + row('담 당', ((cu.doctor || '') + ' ' + (cu.dept || '')).trim())
        + row('연 락', cu.phone) + row('주 소', cu.addr) + '</table>'
      + '<table><caption>공급자</caption>'
        + row('상 호', '주식회사 유로링크') + row('담 당', x.rep)
        + row('연 락', '02-000-0000') + row('비 고', '부가세 별도 표기') + '</table>'
    + '</div>'
    + '<div class="qp-sum"><span class="l">합계 금액</span>'
      + '<b>' + comma(c.total) + '<em>원</em></b>'
      + '<span class="h">일금 ' + hangulMoney(c.total) + '원정 (VAT 포함)</span></div>'
    + '<table class="qp-items"><thead><tr>'
      + '<th style="width:38px">No</th><th>품 목</th><th style="width:52px">수량</th>'
      + '<th style="width:100px">단 가</th><th style="width:52px">할인</th><th style="width:112px">금 액</th></tr></thead><tbody>'
    + x.items.map((it, i) => '<tr><td class="c">' + (i + 1) + '</td><td>' + esc(it.name || it.code) + '</td>'
        + '<td class="c">' + comma(it.qty) + '</td><td class="r">' + comma(it.price) + '</td>'
        + '<td class="c">' + num(it.disc) + '%</td>'
        + '<td class="r">' + comma(Math.round(num(it.qty) * num(it.price) * (1 - num(it.disc) / 100))) + '</td></tr>').join('')
    + (x.items.length < 5 ? Array.from({ length: 5 - x.items.length }, () => '<tr class="pad"><td class="c">&nbsp;</td><td></td><td></td><td></td><td></td><td></td></tr>').join('') : '')
    + '</tbody><tfoot>'
      + '<tr><td colspan="5" class="r lbl">공급가액</td><td class="r">' + comma(c.sub) + '</td></tr>'
      + (c.disc ? '<tr><td colspan="5" class="r lbl">할인 합계</td><td class="r">-' + comma(c.disc) + '</td></tr>' : '')
      + '<tr><td colspan="5" class="r lbl">부가세 (10%)</td><td class="r">' + comma(c.vat) + '</td></tr>'
      + '<tr class="tot"><td colspan="5" class="r">합 계</td><td class="r">' + comma(c.total) + '</td></tr>'
    + '</tfoot></table>'
    + (x.memo ? '<div class="qp-memo"><div class="t">특기사항</div><div class="b">' + esc(x.memo) + '</div></div>' : '')
    + '<div class="qp-sign"><div>위와 같이 견적서를 제출합니다.</div>'
      + '<div class="s">주식회사 유로링크 <span class="stamp">(인)</span></div></div>'
    + '<div class="qp-foot">주식회사 유로링크 · UroLink Co., Ltd. &nbsp;|&nbsp; 본 견적서는 발행일로부터 '
      + num(x.validDays || 30) + '일간 유효합니다.</div>'
    + '</div>';
}
const QUOTE_CSS = `
  *{box-sizing:border-box}
  body{font-family:'Noto Sans KR',sans-serif;margin:0;background:#fff;color:#182230;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  /* 여백 0 → 브라우저가 머리글·바닥글(날짜·제목·about:blank·페이지수)을 그릴 자리가 없어져 사라진다.
     실제 인쇄 여백은 아래 .qp 의 padding 으로 준다. */
  @page{size:A4;margin:0}
  .qp{padding:14mm 13mm;font-size:12px;letter-spacing:-.01em}
  .qp-brand{display:flex;align-items:center;gap:11px;padding-bottom:12px;border-bottom:2px solid #16324f}
  .qp-mark{width:34px;height:34px;border-radius:9px;background:#0e7490;color:#fff;font-weight:800;font-size:19px;
    display:flex;align-items:center;justify-content:center;flex-shrink:0}
  .qp-co{font-size:15px;font-weight:800}
  .qp-co-sub{font-size:10px;color:#94a3b8;margin-top:1px;letter-spacing:.02em}
  .qp-meta{margin-left:auto;text-align:right;font-size:10.5px;color:#64748b;line-height:1.6}
  .qp-meta b{color:#182230}
  .qp-title{font-size:27px;font-weight:800;letter-spacing:.34em;text-align:center;margin:26px 0 22px;color:#16324f}
  .qp-parties{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-bottom:18px}
  .qp-parties table{width:100%;border-collapse:collapse}
  .qp-parties caption{caption-side:top;text-align:left;font-size:10px;font-weight:800;letter-spacing:.1em;
    color:#0e7490;padding-bottom:4px;text-transform:uppercase}
  .qp-parties th{width:54px;background:#f5f8fa;border:1px solid #dbe3ec;padding:6px 8px;font-size:10.5px;
    font-weight:700;color:#475569;text-align:center;white-space:nowrap}
  .qp-parties td{border:1px solid #dbe3ec;padding:6px 9px;font-size:11.5px}
  .qp-sum{display:flex;align-items:baseline;gap:12px;background:#f0fbfd;border:1px solid #a5d8e4;
    border-left:4px solid #0e7490;border-radius:6px;padding:13px 18px;margin-bottom:16px}
  .qp-sum .l{font-size:11.5px;font-weight:800;color:#0e7490;letter-spacing:.04em}
  .qp-sum b{font-size:25px;font-weight:800;color:#16324f;font-variant-numeric:tabular-nums}
  .qp-sum b em{font-size:14px;font-weight:700;font-style:normal;margin-left:2px}
  .qp-sum .h{margin-left:auto;font-size:11px;color:#64748b}
  .qp-items{width:100%;border-collapse:collapse}
  .qp-items th{background:#16324f;color:#fff;border:1px solid #16324f;padding:8px 8px;font-size:11px;font-weight:700}
  .qp-items td{border:1px solid #dbe3ec;padding:7px 9px;font-size:11.5px;font-variant-numeric:tabular-nums}
  .qp-items tbody tr:nth-child(even) td{background:#fafbfc}
  .qp-items tr.pad td{height:26px}
  .qp-items td.c{text-align:center}
  .qp-items td.r{text-align:right}
  .qp-items tfoot td{background:#f5f8fa;font-weight:700}
  .qp-items tfoot td.lbl{color:#475569;font-weight:600}
  .qp-items tfoot tr.tot td{background:#e6f4f8;color:#16324f;font-size:13px;font-weight:800}
  .qp-memo{margin-top:16px;border:1px solid #dbe3ec;border-radius:6px;overflow:hidden}
  .qp-memo .t{background:#f5f8fa;border-bottom:1px solid #dbe3ec;padding:6px 10px;font-size:10.5px;font-weight:800;color:#475569}
  .qp-memo .b{padding:9px 11px;font-size:11.5px;color:#334155;white-space:pre-wrap;line-height:1.6}
  .qp-sign{margin-top:30px;text-align:right;font-size:11.5px;color:#475569}
  .qp-sign .s{margin-top:8px;font-size:14px;font-weight:800;color:#182230}
  .qp-sign .stamp{display:inline-block;margin-left:8px;width:44px;height:44px;line-height:42px;text-align:center;
    border:1.5px dashed #cbd5e1;border-radius:50%;color:#cbd5e1;font-size:11px;font-weight:600;vertical-align:middle}
  .qp-foot{margin-top:26px;padding-top:9px;border-top:1px solid #e4e8ef;font-size:10px;color:#94a3b8;text-align:center}
`;
function printQuote(id) {
  const x = DB.quotes.find(v => v.id === id);
  if (!x) return;
  const html = quoteHTML(x);
  $('quote-print').innerHTML = html;
  const win = window.open('', '_blank');
  if (!win) { alert('팝업이 차단되었습니다. 팝업 허용 후 다시 시도해주세요.'); return; }
  win.document.write('<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>견적서 ' + esc(x.no) + '</title>'
    + '<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700;800&display=swap" rel="stylesheet">'
    + '<style>' + QUOTE_CSS + '</style></head><body>' + html + '</body></html>');
  win.document.close();
  setTimeout(() => { win.focus(); win.print(); }, 500);
}
/* ───────────────────────── 10. 고객사 ───────────────────────── */
let C_TAG = '';
function renderCustomers() {
  const q = ($('c-search').value || '').trim().toLowerCase();
  const g = $('c-grade').value, rep = $('c-rep').value, rg = $('c-region').value;
  const all = DB.customers;
  const gradeCnt = ['A','B','C','D'].map(x => all.filter(c => c.grade === x).length);
  const totalWon = DB.deals.filter(d => d.stage === '계약완료').reduce((s, d) => s + num(d.amount), 0);
  $('cust-band').innerHTML = `
    <div class="wt-hero"><div class="l">전체 고객사</div><b>${all.length}곳</b>
      <div class="s">누적 수주 ${money(totalWon)}원</div></div>
    <div class="wt-fact"><div class="l">A등급</div><b>${gradeCnt[0]}</b><div class="s">핵심 관리</div></div>
    <div class="wt-fact"><div class="l">B / C등급</div><b>${gradeCnt[1]} / ${gradeCnt[2]}</b><div class="s">성장·유지</div></div>
    <div class="wt-fact"><div class="l">장비 보유</div><b>${new Set(DB.equipments.map(e => e.custId)).size}곳</b><div class="s">설치 ${DB.equipments.length}대</div></div>
    <div class="wt-fact"><div class="l">30일 내 접촉</div><b>${all.filter(c => DB.logs.some(l => l.custId === c.id && (-dDays(l.date)) <= 30)).length}곳</b><div class="s">상담일지 기준</div></div>`;

  const tags = [...new Set(all.flatMap(c => (c.tags || []).map(t => String(t).trim()).filter(Boolean)))];
  $('c-tagbar').innerHTML = tags.length ? `<span class="pipe-chip ${C_TAG ? '' : 'on'}" onclick="setCTag('')">전체</span>`
    + tags.map(t => `<span class="pipe-chip ${C_TAG === t ? 'on' : ''}" onclick="setCTag('${esc(t)}')">${esc(t)}</span>`).join('') : '';

  const rows = all.filter(c => {
    if (g && c.grade !== g) return false;
    if (rep && c.rep !== rep) return false;
    if (rg && c.sido !== rg) return false;
    if (C_TAG && !(c.tags || []).map(t => String(t).trim()).includes(C_TAG)) return false;
    if (q) return (c.name + ' ' + (c.doctor || '') + ' ' + (c.sido || '') + (c.gugun || '') + ' ' + (c.rep || '') + ' ' + (c.tags || []).join(' ')).toLowerCase().includes(q);
    return true;
  }).sort((a, b) => custWonAmount(b.id) - custWonAmount(a.id));

  $('cust-tbody').innerHTML = rows.length ? rows.map(c => `<tr>
    <td><a class="cust-link" onclick="openCustDetail('${c.id}')">${esc(c.name)}</a></td>
    <td style="font-size:12px;color:#64748b">${esc(c.type || '-')}</td>
    <td>${esc(c.doctor || '-')}</td>
    <td style="font-size:12px">${esc((c.sido || '') + ' ' + (c.gugun || '')) || '-'}</td>
    <td style="font-size:12px">${esc(c.phone || '-')}</td>
    <td>${esc(c.rep || '-')}</td>
    <td class="text-center"><span class="grade-badge grade-${esc(c.grade)}">${esc(c.grade)}</span></td>
    <td class="text-end fw-bold">${comma(custWonAmount(c.id))}</td>
    <td>${(c.tags || []).slice(0, 3).map(t => `<span class="tag-chip">${esc(String(t).trim())}</span>`).join('')}</td>
    <td class="text-end"><button class="btn btn-sm btn-outline-secondary" onclick="openCustModal('${c.id}')"><i class="bi bi-pencil"></i></button></td>
  </tr>`).join('') : `<tr><td colspan="10" class="table-empty">고객사가 없습니다</td></tr>`;
}
function setCTag(t) { C_TAG = t; renderCustomers(); }
function openCustModal(id) {
  refreshSelects();
  const c = id ? custById(id) : null;
  $('cust-modal-title').textContent = c ? '고객사 수정' : '고객사 추가';
  $('c-del-btn').style.display = c ? 'inline-block' : 'none';
  $('c-id').value = c ? c.id : '';
  $('c-name').value = c ? c.name : '';
  $('c-type').value = c ? (c.type || '의원') : '의원';
  $('c-doctor').value = c ? (c.doctor || '') : '';
  $('c-dept').value = c ? (c.dept || '') : '비뇨의학과';
  $('c-grade-in').value = c ? (c.grade || 'B') : 'B';
  $('c-sido').value = c ? (c.sido || '') : '';
  $('c-gugun').value = c ? (c.gugun || '') : '';
  $('c-rep-in').value = c ? (c.rep || '') : '';
  $('c-phone').value = c ? (c.phone || '') : '';
  $('c-addr').value = c ? (c.addr || '') : '';
  $('c-tags').value = c ? (c.tags || []).join(', ') : '';
  $('c-memo').value = c ? (c.memo || '') : '';
  new bootstrap.Modal($('custModal')).show();
}
function saveCust() {
  const name = $('c-name').value.trim();
  if (!name) return alert('고객사명을 입력해주세요.');
  const row = { name, type: $('c-type').value, doctor: $('c-doctor').value.trim(), dept: $('c-dept').value.trim(),
    grade: $('c-grade-in').value, sido: $('c-sido').value.trim(), gugun: $('c-gugun').value.trim(),
    rep: resolveRep($('c-rep-in').value), phone: $('c-phone').value.trim(), addr: $('c-addr').value.trim(),
    tags: $('c-tags').value.split(',').map(t => t.trim()).filter(Boolean), memo: $('c-memo').value.trim() };
  const id = $('c-id').value;
  if (id) Object.assign(custById(id), row);
  else DB.customers.push(Object.assign({ id: uid(), createdAt: today() }, row));
  save();
  bootstrap.Modal.getInstance($('custModal')).hide();
  renderCustomers();
}
function deleteCust() {
  if (!ensureAdmin()) return;
  const id = $('c-id').value; if (!id) return;
  const n = DB.deals.filter(d => d.custId === id).length + DB.equipments.filter(e => e.custId === id).length;
  if (!confirm(`이 고객사를 삭제할까요?${n ? `\n연결된 딜·장비 ${n}건은 남습니다.` : ''}`)) return;
  DB.customers = DB.customers.filter(c => c.id !== id);
  save(); bootstrap.Modal.getInstance($('custModal')).hide(); renderCustomers();
}

/* ── 고객사 상세 ── */
let CD_ID = null, CD_TAB = 'info';
function openCustDetail(id) {
  const c = custById(id); if (!c) return;
  CD_ID = id; CD_TAB = 'info';
  document.querySelectorAll('#cd-tabs .wt-tab').forEach((b, i) => b.classList.toggle('on', i === 0));
  $('cd-name').innerHTML = esc(c.name) + ` <span class="grade-badge grade-${esc(c.grade)}">${esc(c.grade)}</span>`;
  $('cd-sub').textContent = [c.type, c.dept, (c.sido || '') + ' ' + (c.gugun || ''), '담당 ' + (c.rep || '미지정')].filter(x => String(x).trim()).join(' · ');
  const deals = DB.deals.filter(d => d.custId === id);
  const openD = deals.filter(d => OPEN_STAGES.includes(d.stage));
  const lastLog = DB.logs.filter(l => l.custId === id).map(l => l.date).sort().pop();
  $('cd-band').innerHTML = `
    <div class="wt-hero"><div class="l">누적 수주</div><b>${money(custWonAmount(id))}원</b>
      <div class="s">계약완료 ${deals.filter(d => d.stage === '계약완료').length}건</div></div>
    <div class="wt-fact"><div class="l">진행 딜</div><b>${openD.length}</b><div class="s">${money(openD.reduce((s, d) => s + num(d.amount), 0))}원</div></div>
    <div class="wt-fact"><div class="l">보유 장비</div><b>${DB.equipments.filter(e => e.custId === id).length}</b><div class="s">A/S ${DB.equipments.filter(e => e.custId === id).reduce((s, e) => s + (e.as || []).length, 0)}회</div></div>
    <div class="wt-fact"><div class="l">최근 접촉</div><b>${lastLog ? (-dDays(lastLog)) + '일 전' : '없음'}</b><div class="s">${lastLog ? fmtDate(lastLog) : '상담일지 없음'}</div></div>`;
  renderCdBody();
  new bootstrap.Modal($('custDetailModal')).show();
}
function cdTab(t, el) {
  CD_TAB = t;
  document.querySelectorAll('#cd-tabs .wt-tab').forEach(b => b.classList.remove('on'));
  if (el) el.classList.add('on');
  renderCdBody();
}
function renderCdBody() {
  const id = CD_ID, c = custById(id); if (!c) return;
  const box = $('cd-body');
  if (CD_TAB === 'info') {
    box.innerHTML = `<div class="row g-0" style="border:1px solid var(--border);border-radius:12px;overflow:hidden">
      ${[['구분', c.type], ['원장/담당', c.doctor], ['진료과', c.dept], ['등급', c.grade],
         ['지역', (c.sido || '') + ' ' + (c.gugun || '')], ['담당영업', c.rep], ['전화', c.phone], ['주소', c.addr],
         ['태그', (c.tags || []).join(', ')], ['등록일', fmtDate(c.createdAt)]]
        .map(([k, v]) => `<div class="col-md-6" style="display:flex;border-bottom:1px solid #f3f4f6">
          <div style="width:100px;flex-shrink:0;background:#fafbfc;padding:10px 12px;font-size:12px;font-weight:600;color:#64748b">${esc(k)}</div>
          <div style="flex:1;padding:10px 12px;font-size:13px;min-width:0;word-break:break-word">${esc(v || '-')}</div></div>`).join('')}
      <div class="col-12" style="display:flex">
        <div style="width:100px;flex-shrink:0;background:#fafbfc;padding:10px 12px;font-size:12px;font-weight:600;color:#64748b">메모</div>
        <div style="flex:1;padding:10px 12px;font-size:13px;white-space:pre-wrap">${esc(c.memo || '-')}</div></div></div>`;
  } else if (CD_TAB === 'deals') {
    const ds = DB.deals.filter(d => d.custId === id).sort((a, b) => String(b.expectedDate).localeCompare(String(a.expectedDate)));
    box.innerHTML = tbl(['제품','금액','단계','확률','예상일','담당',''], ds.map(d => `
      <td>${esc(d.product)}</td><td class="text-end fw-bold">${comma(d.amount)}</td>
      <td><span class="badge" style="background:${stageOf(d.stage).color}1a;color:${stageOf(d.stage).color}">${esc(d.stage)}</span></td>
      <td class="text-center">${num(d.prob)}%</td><td>${fmtDate(d.expectedDate)}</td><td>${esc(d.rep || '-')}</td>
      <td class="text-end"><button class="btn btn-sm btn-outline-secondary" onclick="hideCd();openDrawer('${d.id}')">상세</button></td>`), '딜이 없습니다');
  } else if (CD_TAB === 'equip') {
    const es = DB.equipments.filter(e => e.custId === id);
    box.innerHTML = tbl(['모델','시리얼','설치일','보증만료','상태','계약','A/S',''], es.map(e => {
      const n = dDays(e.warrantyEnd);
      return `<td>${esc(e.model)}</td><td>${esc(e.serial || '-')}</td><td>${fmtDate(e.installDate)}</td>
        <td>${fmtDate(e.warrantyEnd)} ${n != null && n < 0 ? '<span class="dc-flag od">만료</span>' : n != null && n <= 90 ? `<span class="dc-flag td">D-${n}</span>` : ''}</td>
        <td>${esc(e.status)}</td><td>${esc(e.contract || '-')}</td><td class="text-center">${(e.as || []).length}</td>
        <td class="text-end"><button class="btn btn-sm btn-outline-secondary" onclick="hideCd();openEquipModal('${e.id}')">보기</button></td>`;
    }), '등록된 장비가 없습니다');
  } else if (CD_TAB === 'quotes') {
    const qs = DB.quotes.filter(x => x.custId === id).sort((a, b) => String(b.date).localeCompare(String(a.date)));
    box.innerHTML = tbl(['견적번호','견적일','품목','합계','상태',''], qs.map(x => {
      const cc = quoteCalc(x.items);
      return `<td class="fw-bold">${esc(x.no)}</td><td>${fmtDate(x.date)}</td>
        <td style="font-size:12px">${esc(x.items.map(i => i.name).join(', ')).slice(0, 60)}</td>
        <td class="text-end fw-bold">${comma(cc.total)}</td><td>${esc(x.status)}</td>
        <td class="text-end"><button class="btn btn-sm btn-outline-secondary" onclick="printQuote('${x.id}')"><i class="bi bi-printer"></i></button></td>`;
    }), '견적서가 없습니다');
  } else {
    /* 타임라인 */
    const ev = [];
    DB.logs.filter(l => l.custId === id).forEach(l => ev.push({ d: l.date, ic: 'bi-journal-text', c: '#0e7490', t: l.type + ' 상담', s: l.content, r: l.rep }));
    DB.deals.filter(d => d.custId === id).forEach(d => ev.push({ d: d.expectedDate, ic: 'bi-kanban', c: stageOf(d.stage).color, t: d.stage + ' · ' + money(d.amount) + '원', s: d.product, r: d.rep }));
    DB.equipments.filter(e => e.custId === id).forEach(e => {
      ev.push({ d: e.installDate, ic: 'bi-cpu', c: '#16a34a', t: '장비 설치', s: e.model + ' (' + (e.serial || '') + ')', r: e.rep });
      (e.as || []).forEach(a => ev.push({ d: a.date, ic: 'bi-tools', c: '#ea580c', t: 'A/S · ' + a.type, s: a.content, r: a.engineer }));
    });
    DB.quotes.filter(x => x.custId === id).forEach(x => ev.push({ d: x.date, ic: 'bi-file-earmark-text', c: '#7c3aed', t: '견적 ' + x.no + ' · ' + money(quoteCalc(x.items).total) + '원', s: x.status, r: x.rep }));
    DB.schedules.filter(s => s.custId === id).forEach(s => ev.push({ d: s.date, ic: 'bi-calendar-event', c: SCH_TYPES[s.type] || '#94a3b8', t: s.type + ' 일정' + (s.done ? ' (완료)' : ''), s: s.title + (s.result ? ' → ' + s.result : ''), r: s.rep }));
    ev.sort((a, b) => String(b.d).localeCompare(String(a.d)));
    box.innerHTML = ev.length ? `<div style="position:relative;padding-left:22px">
      <div style="position:absolute;left:6px;top:6px;bottom:6px;width:2px;background:#eef1f5"></div>
      ${ev.map(x => `<div style="position:relative;padding:0 0 16px 12px">
        <div style="position:absolute;left:-21px;top:3px;width:14px;height:14px;border-radius:50%;background:#fff;border:2px solid ${x.c}"></div>
        <div style="font-size:11px;color:#94a3b8;font-weight:600">${fmtDate(x.d)}${x.r ? ' · ' + esc(x.r) : ''}</div>
        <div style="font-size:13px;font-weight:700;margin-top:1px"><i class="bi ${x.ic} me-1" style="color:${x.c}"></i>${esc(x.t)}</div>
        <div style="font-size:12.5px;color:#475569;margin-top:2px;white-space:pre-wrap">${esc(x.s || '')}</div></div>`).join('')}</div>`
      : `<div class="text-center" style="padding:40px;color:#94a3b8;font-size:13px">활동 이력이 없습니다</div>`;
  }
}
function tbl(heads, rows, empty) {
  return `<div class="card"><div class="card-body p-0"><table class="table table-hover mb-0">
    <thead><tr>${heads.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.length ? rows.map(r => `<tr>${r}</tr>`).join('') : `<tr><td colspan="${heads.length}" class="table-empty">${esc(empty)}</td></tr>`}</tbody>
  </table></div></div>`;
}
function hideCd() { const m = bootstrap.Modal.getInstance($('custDetailModal')); if (m) m.hide(); }
function editCustFromDetail() { const id = CD_ID; hideCd(); setTimeout(() => openCustModal(id), 300); }
function quickLogForCust() { const id = CD_ID; hideCd(); setTimeout(() => openLogModal(null, id), 300); }
function quickDealForCust() { const id = CD_ID; hideCd(); setTimeout(() => openDealModal(null, id), 300); }

/* ───────────────────────── 11. 장비 · A/S ───────────────────────── */
function renderEquip() {
  const q = ($('e-search').value || '').trim().toLowerCase();
  const st = $('e-status').value, wf = $('e-warranty').value;
  const all = DB.equipments;
  const soon = all.filter(e => { const n = dDays(e.warrantyEnd); return n != null && n >= 0 && n <= 90; });
  const expired = all.filter(e => { const n = dDays(e.warrantyEnd); return n != null && n < 0; });
  $('equip-band').innerHTML = `
    <div class="wt-hero"><div class="l">설치 장비 (Installed Base)</div><b>${all.length}대</b>
      <div class="s">${new Set(all.map(e => e.custId)).size}개 고객사</div></div>
    <div class="wt-fact"><div class="l">보증 90일 내 만료</div><b class="${soon.length ? 'rd' : ''}">${soon.length}</b><div class="s">유지보수 영업 기회</div></div>
    <div class="wt-fact"><div class="l">보증 만료</div><b>${expired.length}</b><div class="s">UL-CARE 제안 대상</div></div>
    <div class="wt-fact"><div class="l">수리중</div><b class="${all.filter(e => e.status === '수리중').length ? 'rd' : ''}">${all.filter(e => e.status === '수리중').length}</b><div class="s">A/S 진행</div></div>
    <div class="wt-fact"><div class="l">A/S 누적</div><b>${all.reduce((s, e) => s + (e.as || []).length, 0)}회</b><div class="s">이력 기준</div></div>`;

  const rows = all.filter(e => {
    if (st && e.status !== st) return false;
    const n = dDays(e.warrantyEnd);
    if (wf === 'soon' && !(n != null && n >= 0 && n <= 90)) return false;
    if (wf === 'expired' && !(n != null && n < 0)) return false;
    if (wf === 'valid' && !(n != null && n >= 0)) return false;
    if (q) return (custName(e.custId) + ' ' + e.model + ' ' + (e.serial || '') + ' ' + (e.rep || '')).toLowerCase().includes(q);
    return true;
  }).sort((a, b) => String(b.installDate).localeCompare(String(a.installDate)));

  const stC = { '정상': '#16a34a', '수리중': '#dc2626', '교체예정': '#ea580c', '반납': '#94a3b8' };
  $('equip-tbody').innerHTML = rows.length ? rows.map(e => {
    const n = dDays(e.warrantyEnd);
    return `<tr>
      <td><a class="cust-link" onclick="openCustDetail('${e.custId}')">${esc(custName(e.custId))}</a></td>
      <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis">${esc(e.model)}</td>
      <td style="font-size:12px">${esc(e.serial || '-')}</td>
      <td>${fmtDate(e.installDate)}</td>
      <td>${fmtDate(e.warrantyEnd)} ${n == null ? '' : n < 0 ? '<span class="dc-flag od">만료</span>' : n <= 90 ? `<span class="dc-flag td">D-${n}</span>` : ''}</td>
      <td><span class="badge" style="background:${stC[e.status] || '#94a3b8'}1a;color:${stC[e.status] || '#64748b'}">${esc(e.status)}</span></td>
      <td>${esc(e.rep || '-')}</td>
      <td class="text-center">${(e.as || []).length}</td>
      <td class="text-end"><button class="btn btn-sm btn-outline-secondary" onclick="openEquipModal('${e.id}')"><i class="bi bi-pencil"></i></button></td></tr>`;
  }).join('') : `<tr><td colspan="9" class="table-empty">장비가 없습니다</td></tr>`;
}
let EQ_ID = null;
function openEquipModal(id) {
  refreshSelects();
  const e = id ? DB.equipments.find(x => x.id === id) : null;
  EQ_ID = id || null;
  $('equip-modal-title').textContent = e ? '장비 수정' : '장비 등록';
  $('e-del-btn').style.display = e ? 'inline-block' : 'none';
  $('e-id').value = e ? e.id : '';
  $('e-cust').value = e ? custName(e.custId) : '';
  $('e-model').value = e ? (e.model || '') : '';
  $('e-serial').value = e ? (e.serial || '') : '';
  $('e-install').value = e ? (e.installDate || '') : today();
  $('e-warranty-end').value = e ? (e.warrantyEnd || '') : '';
  $('e-status-in').value = e ? e.status : '정상';
  $('e-rep').value = e ? (e.rep || '') : '';
  $('e-contract').value = e ? (e.contract || '구매') : '구매';
  $('e-memo').value = e ? (e.memo || '') : '';
  $('as-date').value = today(); $('as-content').value = ''; $('as-engineer').value = '';
  renderASList(e ? (e.as || []) : []);
  new bootstrap.Modal($('equipModal')).show();
}
function equipModelChange() { calcWarranty(); }
function calcWarranty() {
  const p = prodByName(trimv($('e-model').value)), inst = $('e-install').value;
  if (p && inst && p.warranty) $('e-warranty-end').value = addMonths(inst, p.warranty);
}
let AS_TMP = [];
function renderASList(list) {
  AS_TMP = (list || []).slice();
  $('as-list').innerHTML = AS_TMP.length ? `<table class="table table-sm mb-0"><thead><tr>
    <th>일자</th><th>유형</th><th>내용</th><th>엔지니어</th><th></th></tr></thead><tbody>
    ${AS_TMP.map((a, i) => `<tr><td>${fmtDate(a.date)}</td><td>${esc(a.type)}</td>
      <td style="white-space:normal">${esc(a.content)}</td><td>${esc(a.engineer || '-')}</td>
      <td class="text-end"><button class="btn btn-sm btn-outline-secondary" onclick="removeAS(${i})"><i class="bi bi-x"></i></button></td></tr>`).join('')}
    </tbody></table>` : `<div style="color:#94a3b8;font-size:12.5px;padding:6px 0">A/S 이력이 없습니다</div>`;
}
function addAS() {
  const content = $('as-content').value.trim();
  if (!content) return alert('A/S 내용을 입력해주세요.');
  AS_TMP.push({ id: uid(), date: $('as-date').value || today(), type: $('as-type').value, content, engineer: $('as-engineer').value.trim() });
  AS_TMP.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  renderASList(AS_TMP);
  $('as-content').value = '';
}
function removeAS(i) { AS_TMP.splice(i, 1); renderASList(AS_TMP); }
function saveEquip() {
  if (!trimv($('e-cust').value)) return alert('고객사를 입력하거나 선택해주세요.');
  if (!trimv($('e-model').value)) return alert('모델을 입력하거나 선택해주세요.');
  const code = resolveProd($('e-model').value, '장비');
  const p = prodByCode(code);
  const row = { custId: resolveCust($('e-cust').value), modelCode: code, model: p ? p.name : trimv($('e-model').value),
    serial: $('e-serial').value.trim(), installDate: $('e-install').value, warrantyEnd: $('e-warranty-end').value,
    status: $('e-status-in').value, rep: resolveRep($('e-rep').value), contract: $('e-contract').value,
    memo: $('e-memo').value.trim(), as: AS_TMP.slice() };
  const id = $('e-id').value;
  if (id) Object.assign(DB.equipments.find(x => x.id === id), row);
  else DB.equipments.push(Object.assign({ id: uid() }, row));
  save();
  bootstrap.Modal.getInstance($('equipModal')).hide();
  renderEquip();
}
function deleteEquip() {
  if (!ensureAdmin()) return;
  const id = $('e-id').value; if (!id || !confirm('이 장비를 삭제할까요?')) return;
  DB.equipments = DB.equipments.filter(x => x.id !== id);
  save(); bootstrap.Modal.getInstance($('equipModal')).hide(); renderEquip();
}

/* ───────────────────────── 12. 제품 ───────────────────────── */
function renderProducts() {
  const q = ($('p-search').value || '').trim().toLowerCase();
  const cat = $('p-cat').value;
  const rows = DB.products.filter(p => {
    if (cat && p.cat !== cat) return false;
    if (q) return (p.code + ' ' + p.name).toLowerCase().includes(q);
    return true;
  });
  const catC = { '장비': '#0e7490', '소모품': '#16a34a', '액세서리': '#7c3aed', '서비스': '#ea580c' };
  $('prod-tbody').innerHTML = rows.length ? rows.map(p => {
    const cnt = DB.deals.filter(d => d.productCode === p.code).length;
    return `<tr>
      <td class="fw-bold" style="font-size:12px">${esc(p.code)}</td>
      <td>${esc(p.name)}</td>
      <td><span class="badge" style="background:${catC[p.cat] || '#94a3b8'}1a;color:${catC[p.cat] || '#64748b'}">${esc(p.cat)}</span></td>
      <td class="text-end fw-bold">${comma(p.price)}</td>
      <td class="text-center" style="font-size:12px">${esc(p.unit || '-')}</td>
      <td class="text-center">${num(p.warranty) || '-'}</td>
      <td class="text-end">${cnt || '-'}</td>
      <td class="text-end"><button class="btn btn-sm btn-outline-secondary" onclick="openProdModal('${esc(p.code)}')"><i class="bi bi-pencil"></i></button></td></tr>`;
  }).join('') : `<tr><td colspan="8" class="table-empty">제품이 없습니다</td></tr>`;
}
function openProdModal(code) {
  const p = code ? prodByCode(code) : null;
  $('prod-modal-title').textContent = p ? '제품 수정' : '제품 추가';
  $('p-del-btn').style.display = p ? 'inline-block' : 'none';
  $('p-orig-code').value = p ? p.code : '';
  $('p-code').value = p ? p.code : '';
  $('p-name').value = p ? p.name : '';
  $('p-cat-in').value = p ? p.cat : '장비';
  $('p-unit').value = p ? (p.unit || 'EA') : 'EA';
  $('p-price').value = p ? comma(p.price) : '';
  $('p-warranty').value = p ? num(p.warranty) : 12;
  $('p-memo').value = p ? (p.memo || '') : '';
  new bootstrap.Modal($('prodModal')).show();
}
function saveProd() {
  const code = $('p-code').value.trim(), name = $('p-name').value.trim();
  if (!code) return alert('제품코드를 입력해주세요.');
  if (!name) return alert('제품명을 입력해주세요.');
  const orig = $('p-orig-code').value;
  if (code !== orig && prodByCode(code)) return alert('이미 존재하는 제품코드입니다.');
  const row = { code, name, cat: $('p-cat-in').value, unit: $('p-unit').value.trim() || 'EA',
    price: num($('p-price').value), warranty: num($('p-warranty').value), memo: $('p-memo').value.trim() };
  if (orig) {
    const p = prodByCode(orig);
    Object.assign(p, row);
    if (code !== orig) {  // 참조 갱신
      DB.deals.forEach(d => { if (d.productCode === orig) { d.productCode = code; d.product = name; } });
      DB.equipments.forEach(e => { if (e.modelCode === orig) { e.modelCode = code; e.model = name; } });
      DB.quotes.forEach(q => (q.items || []).forEach(it => { if (it.code === orig) { it.code = code; it.name = name; } }));
    }
  } else DB.products.push(row);
  save();
  bootstrap.Modal.getInstance($('prodModal')).hide();
  renderProducts();
}
function deleteProd() {
  if (!ensureAdmin()) return;
  const code = $('p-orig-code').value; if (!code) return;
  const used = DB.deals.filter(d => d.productCode === code).length + DB.equipments.filter(e => e.modelCode === code).length;
  if (!confirm(`이 제품을 삭제할까요?${used ? `\n연결된 딜·장비 ${used}건의 제품명은 그대로 남습니다.` : ''}`)) return;
  DB.products = DB.products.filter(p => p.code !== code);
  save(); bootstrap.Modal.getInstance($('prodModal')).hide(); renderProducts();
}

/* ───────────────────────── 13. 영업 분석 ───────────────────────── */
let ANA_TAB = 'rep';
function anaTab(t, el) {
  ANA_TAB = t;
  document.querySelectorAll('#page-analysis .wt-tab').forEach(b => b.classList.remove('on'));
  if (el) el.classList.add('on');
  renderAnalysis();
}
function renderAnalysis() {
  const y = num($('ana-year').value) || new Date().getFullYear();
  const pt = $('ana-period').value || 'year';
  const [a, b] = periodRange(y, pt);
  const ptLabel = pt === 'year' ? '연간' : /^Q/.test(pt) ? pt[1] + '분기' : pt + '월';
  $('ana-desc').textContent = `${y}년 ${ptLabel} · ${fmtDate(a)} ~ ${fmtDate(b)}`;
  const inP = DB.deals.filter(d => inRange(d.expectedDate, a, b));
  const wonD = inP.filter(d => d.stage === '계약완료');
  const lostD = inP.filter(d => d.stage === '실주');

  if (ANA_TAB === 'rep') {
    const reps = [...new Set([...repNames(), ...inP.map(d => d.rep).filter(Boolean)])];
    const stats = reps.map(r => {
      const w = wonD.filter(d => d.rep === r), l = lostD.filter(d => d.rep === r);
      const o = DB.deals.filter(d => d.rep === r && OPEN_STAGES.includes(d.stage));
      return { r, wonAmt: w.reduce((s, d) => s + num(d.amount), 0), wonCnt: w.length, lost: l.length,
        openAmt: o.reduce((s, d) => s + num(d.amount), 0), openCnt: o.length,
        logs: DB.logs.filter(x => x.rep === r && inRange(x.date, a, b)).length,
        win: (w.length + l.length) ? Math.round(w.length / (w.length + l.length) * 100) : 0 };
    }).sort((x, y2) => y2.wonAmt - x.wonAmt);
    const maxW = Math.max(1, ...stats.map(s => s.wonAmt));
    $('ana-body').innerHTML = `
      <div class="card p-3 mb-3"><div class="wt-st">담당자별 수주액</div>
        <div style="position:relative;height:${Math.max(180, stats.length * 34)}px"><canvas id="chart-ana"></canvas></div></div>
      ${tbl(['담당자','수주액','수주건','실주건','성공률','진행 딜','진행액','상담일지'],
        stats.map(s => `<td class="fw-bold">${esc(s.r)}</td>
          <td class="text-end fw-bold">${comma(s.wonAmt)}<div style="height:4px;background:#eef1f5;border-radius:2px;margin-top:4px"><div style="height:100%;width:${s.wonAmt / maxW * 100}%;background:#0e7490;border-radius:2px"></div></div></td>
          <td class="text-center">${s.wonCnt}</td><td class="text-center">${s.lost}</td>
          <td class="text-center ${s.win >= 50 ? 'text-success fw-bold' : ''}">${s.win}%</td>
          <td class="text-center">${s.openCnt}</td><td class="text-end">${comma(s.openAmt)}</td>
          <td class="text-center">${s.logs}</td>`), '데이터가 없습니다')}`;
    chart('chart-ana', {
      type: 'bar',
      data: { labels: stats.map(s => s.r), datasets: [{ label: '수주액', data: stats.map(s => s.wonAmt), backgroundColor: '#0e7490', borderRadius: 5 }] },
      options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => won(c.parsed.x) } } },
        scales: { x: { beginAtZero: true, ticks: { font: { size: 10 }, callback: v => money(v) }, grid: { color: '#f1f5f9' } }, y: { ticks: { font: { size: 11 } }, grid: { display: false } } } }
    });
  } else if (ANA_TAB === 'product') {
    const codes = [...new Set(inP.map(d => d.productCode).filter(Boolean))];
    const stats = codes.map(code => {
      const p = prodByCode(code);
      const w = wonD.filter(d => d.productCode === code);
      const o = DB.deals.filter(d => d.productCode === code && OPEN_STAGES.includes(d.stage));
      return { code, name: p ? p.name : code, cat: p ? p.cat : '-',
        wonAmt: w.reduce((s, d) => s + num(d.amount), 0), wonCnt: w.length,
        openCnt: o.length, openAmt: o.reduce((s, d) => s + num(d.amount), 0),
        installed: DB.equipments.filter(e => e.modelCode === code).length };
    }).sort((x, y2) => y2.wonAmt - x.wonAmt);
    const total = stats.reduce((s, x) => s + x.wonAmt, 0);
    $('ana-body').innerHTML = `
      <div class="row g-3 mb-3">
        <div class="col-lg-5"><div class="card p-3 h-100"><div class="wt-st">제품 믹스 (수주액)</div>
          <div style="position:relative;height:250px"><canvas id="chart-ana"></canvas></div></div></div>
        <div class="col-lg-7"><div class="card p-3 h-100"><div class="wt-st">분류별 요약</div>
          ${['장비','소모품','액세서리','서비스'].map(c => {
            const amt = stats.filter(s => s.cat === c).reduce((s2, x) => s2 + x.wonAmt, 0);
            return `<div class="funnel-row"><div class="funnel-label">${esc(c)}</div>
              <div class="funnel-bar-wrap"><div class="funnel-bar" style="width:${total ? amt / total * 100 : 0}%;background:${{'장비':'#0e7490','소모품':'#16a34a','액세서리':'#7c3aed','서비스':'#ea580c'}[c]}">${total ? Math.round(amt / total * 100) + '%' : ''}</div></div>
              <div class="funnel-amt">${money(amt)}</div></div>`;
          }).join('')}
        </div></div>
      </div>
      ${tbl(['제품','분류','수주액','수주건','진행 딜','진행액','설치대수'],
        stats.map(s => `<td>${esc(s.name)}</td><td style="font-size:12px">${esc(s.cat)}</td>
          <td class="text-end fw-bold">${comma(s.wonAmt)}</td><td class="text-center">${s.wonCnt}</td>
          <td class="text-center">${s.openCnt}</td><td class="text-end">${comma(s.openAmt)}</td>
          <td class="text-center">${s.installed}</td>`), '데이터가 없습니다')}`;
    const top = stats.slice(0, 7);
    chart('chart-ana', {
      type: 'doughnut',
      data: { labels: top.map(s => s.name.replace(/^UL-\S+\s*/, '')), datasets: [{ data: top.map(s => s.wonAmt),
        backgroundColor: ['#0e7490','#16a34a','#6366f1','#ea580c','#7c3aed','#0ea5e9','#94a3b8'], borderWidth: 0 }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: '58%',
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 9, font: { size: 10 } } },
          tooltip: { callbacks: { label: c => c.label + ' ' + won(c.parsed) } } } }
    });
  } else if (ANA_TAB === 'region') {
    const sidos = [...new Set(DB.customers.map(c => c.sido).filter(Boolean))];
    const stats = sidos.map(s => {
      const ids = DB.customers.filter(c => c.sido === s).map(c => c.id);
      const w = wonD.filter(d => ids.includes(d.custId));
      const o = DB.deals.filter(d => ids.includes(d.custId) && OPEN_STAGES.includes(d.stage));
      return { s, cust: ids.length, wonAmt: w.reduce((t, d) => t + num(d.amount), 0), wonCnt: w.length,
        openAmt: o.reduce((t, d) => t + num(d.amount), 0), equip: DB.equipments.filter(e => ids.includes(e.custId)).length };
    }).sort((x, y2) => y2.wonAmt - x.wonAmt);
    $('ana-body').innerHTML = `
      <div class="card p-3 mb-3"><div class="wt-st">지역별 수주액</div>
        <div style="position:relative;height:240px"><canvas id="chart-ana"></canvas></div></div>
      ${tbl(['지역','고객사','수주액','수주건','진행액','설치장비','고객사당 평균'],
        stats.map(s => `<td class="fw-bold">${esc(s.s)}</td><td class="text-center">${s.cust}</td>
          <td class="text-end fw-bold">${comma(s.wonAmt)}</td><td class="text-center">${s.wonCnt}</td>
          <td class="text-end">${comma(s.openAmt)}</td><td class="text-center">${s.equip}</td>
          <td class="text-end">${comma(Math.round(s.wonAmt / Math.max(1, s.cust)))}</td>`), '데이터가 없습니다')}`;
    chart('chart-ana', {
      type: 'bar',
      data: { labels: stats.map(s => s.s), datasets: [
        { label: '수주액', data: stats.map(s => s.wonAmt), backgroundColor: '#0e7490', borderRadius: 5 },
        { label: '진행액', data: stats.map(s => s.openAmt), backgroundColor: '#a5d8e4', borderRadius: 5 }] },
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } },
          tooltip: { callbacks: { label: c => c.dataset.label + ' ' + won(c.parsed.y) } } },
        scales: { y: { beginAtZero: true, ticks: { font: { size: 10 }, callback: v => money(v) }, grid: { color: '#f1f5f9' } },
          x: { ticks: { font: { size: 10 } }, grid: { display: false } } } }
    });
  } else {
    /* 전환율 */
    const all = DB.deals;
    const reached = STAGES.filter(s => s.name !== '실주').map(s => {
      const idx = STAGES.findIndex(x => x.name === s.name);
      const cnt = all.filter(d => {
        const di = STAGES.findIndex(x => x.name === d.stage);
        return d.stage !== '실주' ? di >= idx : false;
      }).length;
      return { name: s.name, cnt, color: s.color };
    });
    const maxC = Math.max(1, ...reached.map(r => r.cnt));
    $('ana-body').innerHTML = `
      <div class="row g-3">
        <div class="col-lg-6"><div class="card p-3 h-100"><div class="wt-st">단계 도달 · 전환율</div>
          ${reached.map((r, i) => {
            const prev = i > 0 ? reached[i - 1].cnt : r.cnt;
            const conv = prev ? Math.round(r.cnt / prev * 100) : 0;
            return `<div class="funnel-row"><div class="funnel-label">${esc(r.name)}</div>
              <div class="funnel-bar-wrap"><div class="funnel-bar" style="width:${r.cnt / maxC * 100}%;background:${r.color}">${r.cnt}건</div></div>
              <div class="funnel-amt">${i === 0 ? '-' : conv + '%'}</div></div>`;
          }).join('')}
          <div style="font-size:11.5px;color:#94a3b8;margin-top:8px">오른쪽 수치 = 직전 단계 대비 전환율(실주 제외, 전체 딜 기준)</div>
        </div></div>
        <div class="col-lg-6"><div class="card p-3 h-100"><div class="wt-st">실주 분석</div>
          ${(() => {
            const lost = all.filter(d => d.stage === '실주');
            if (!lost.length) return '<div style="color:#94a3b8;font-size:13px;padding:20px 0;text-align:center">실주 딜이 없습니다</div>';
            const byRep = {};
            lost.forEach(d => { byRep[d.rep || '미지정'] = (byRep[d.rep || '미지정'] || 0) + num(d.amount); });
            return `<div class="mb-2" style="font-size:13px">실주 <b>${lost.length}건</b> · <b>${money(lost.reduce((s, d) => s + num(d.amount), 0))}원</b></div>`
              + Object.entries(byRep).sort((x, y2) => y2[1] - x[1]).map(([k, v]) =>
                `<div class="d-flex justify-content-between" style="padding:6px 0;border-bottom:1px solid #f3f4f6;font-size:12.5px">
                  <span>${esc(k)}</span><strong>${won(v)}</strong></div>`).join('');
          })()}
        </div></div>
        <div class="col-12">${tbl(['기간 요약','값'], [
          `<td>기간 내 예상 수주일 딜</td><td class="text-end fw-bold">${inP.length}건 · ${won(inP.reduce((s, d) => s + num(d.amount), 0))}</td>`,
          `<td>계약완료</td><td class="text-end fw-bold text-success">${wonD.length}건 · ${won(wonD.reduce((s, d) => s + num(d.amount), 0))}</td>`,
          `<td>실주</td><td class="text-end fw-bold text-danger">${lostD.length}건 · ${won(lostD.reduce((s, d) => s + num(d.amount), 0))}</td>`,
          `<td>성공률(건수 기준)</td><td class="text-end fw-bold">${(wonD.length + lostD.length) ? Math.round(wonD.length / (wonD.length + lostD.length) * 100) : 0}%</td>`,
          `<td>평균 수주 규모</td><td class="text-end fw-bold">${won(wonD.length ? wonD.reduce((s, d) => s + num(d.amount), 0) / wonD.length : 0)}</td>`
        ], '')}</div>
      </div>`;
  }
}

/* ───────────────────────── 14. 설정 · 데이터 ───────────────────────── */
function renderSettings() {
  /* 상단 요약 */
  const kpi = $('user-kpi');
  if (kpi) {
    const fact = (l, v, sub) => '<div class="cdud-fact"><span>' + l + '</span><b>' + v + '</b>' + (sub ? '<i>' + sub + '</i>' : '') + '</div>';
    kpi.innerHTML = '<div class="cdud" style="padding:18px 22px;margin:0"><div class="cdud-kpis" style="border-bottom:0;padding:2px 0 4px">'
      + '<div class="cdud-hero" style="cursor:default"><span class="l">' + (isRemote() ? '접속 방식' : '저장 방식') + '</span>'
      + '<b style="font-size:26px">' + (isRemote() ? '서버 공유' : '단독 저장') + '</b>'
      + '<span class="s">' + (isRemote() ? '로그인한 사람이 같은 데이터를 함께 사용' : 'config.js 에 키를 넣으면 공유 모드가 됩니다') + '</span></div>'
      + fact('내 계정', esc(ME ? (ME.display_name || ME.email) : '-'), ME ? (ME.role === 'admin' ? '관리자' : '일반') : '')
      + fact('영업 담당자', DB.reps.length + '명', '딜·일정 배정 대상')
      + fact('데이터', DB.customers.length + '고객사', DB.deals.length + '딜 · ' + DB.equipments.length + '장비')
      + '</div></div>';
  }

  /* 영업 담당자 */
  $('rep-list').innerHTML = DB.reps.length ? DB.reps.map((r, i) => {
    const deals = DB.deals.filter(d => d.rep === r.name).length;
    const sch = DB.schedules.filter(x => x.rep === r.name).length;
    const linked = isRemote() && ME && (ME.display_name === r.name);
    return '<div class="d-flex align-items-center gap-2" style="padding:9px 0;border-bottom:1px solid #f3f4f6">'
      + '<i class="bi bi-person-circle" style="color:#94a3b8;font-size:16px"></i>'
      + '<div style="flex:1;min-width:0"><b style="font-size:13px">' + esc(r.name) + '</b>'
      + (linked ? ' <span style="font-size:9.5px;font-weight:800;background:#e6f4f8;color:#0e7490;border-radius:4px;padding:1px 5px">내 계정</span>' : '')
      + '<input type="text" class="form-control form-control-sm mt-1" style="max-width:220px;font-size:11.5px" value="' + esc(r.role || '') + '"'
      + ' placeholder="직책 / 파트" onchange="setRepRole(' + i + ',this.value)"></div>'
      + '<span style="font-size:11px;color:#94a3b8;white-space:nowrap">딜 ' + deals + ' · 일정 ' + sch + '</span>'
      + '<button class="btn btn-sm btn-outline-secondary" onclick="removeRep(' + i + ')" title="삭제"><i class="bi bi-x"></i></button></div>';
  }).join('') : '<div style="color:#94a3b8;font-size:12.5px;padding:8px 0">등록된 담당자가 없습니다. 위에서 추가해주세요.</div>';

  /* 파이프라인 단계 */
  $('stage-config').innerHTML = STAGES.map(st =>
    '<div style="border:1px solid var(--border);border-radius:10px;padding:10px 14px;min-width:120px">'
    + '<div style="font-size:12px;font-weight:700;color:' + st.color + '">' + esc(st.name) + '</div>'
    + '<div style="font-size:19px;font-weight:800;margin-top:2px">' + st.prob + '%</div>'
    + '<div style="font-size:11px;color:#94a3b8">' + DB.deals.filter(d => d.stage === st.name).length + '건</div></div>').join('');

  /* 백업 안내 + 저장 현황 */
  let bytes = 0;
  try { bytes = new Blob([localStorage.getItem(cacheKey()) || '']).size; } catch (e) {}
  const cnt = { 고객사: DB.customers.length, 딜: DB.deals.length, 상담일지: DB.logs.length,
    견적서: DB.quotes.length, 장비: DB.equipments.length, 제품: DB.products.length, 일정: DB.schedules.length };
  const counts = Object.entries(cnt).map(([k, v]) => k + ' ' + v).join(' · ');
  const note = $('backup-note');
  if (note) note.innerHTML = isRemote()
    ? '데이터는 Supabase 서버에 저장되어 팀원과 공유됩니다. 다만 <b>무료 플랜은 자동 백업이 없습니다</b> — 실수로 지우면 복구할 수 없으니 주기적으로 JSON 을 내려받아 두세요.'
    : '현재 데이터는 <b>이 브라우저에만</b> 저장됩니다. 브라우저 데이터를 지우면 함께 사라지니 JSON 으로 백업해두세요.';
  $('storage-info').innerHTML = (isRemote()
      ? '<span style="color:#15803d;font-weight:700"><i class="bi bi-cloud-check me-1"></i>서버 공유 모드</span> — '
        + esc(String(CFG.SUPABASE_URL).replace(/^https?:\/\//, ''))
      : '<span style="color:#b45309;font-weight:700"><i class="bi bi-hdd me-1"></i>이 브라우저에만 저장</span>')
    + '<br>' + counts
    + '<br><span style="color:#94a3b8">로컬 캐시 ' + (bytes / 1024).toFixed(1) + ' KB</span>';

  renderUsers();
}
function setRepRole(i, v) {
  if (!DB.reps[i]) return;
  DB.reps[i].role = trimv(v);
  save(true);
  toast('직책을 수정했습니다');
}
function addRep() {
  const name = $('rep-name').value.trim();
  if (!name) return alert('이름을 입력해주세요.');
  if (DB.reps.some(r => r.name === name)) return alert('이미 등록된 담당자입니다.');
  DB.reps.push({ name, role: $('rep-role').value.trim() });
  $('rep-name').value = ''; $('rep-role').value = '';
  save(); refreshSelects(); renderSettings();
}
function removeRep(i) {
  if (!ensureAdmin()) return;
  const r = DB.reps[i]; if (!r) return;
  const n = DB.deals.filter(d => d.rep === r.name).length;
  if (!confirm(`${r.name} 담당자를 삭제할까요?${n ? `\n연결된 딜 ${n}건의 담당자명은 그대로 남습니다.` : ''}`)) return;
  DB.reps.splice(i, 1); save(); refreshSelects(); renderSettings();
}
function download(name, content, type) {
  const blob = new Blob([content], { type: type || 'application/json;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
function exportJSON() {
  download(`urolink-crm-${today()}.json`, JSON.stringify(DB, null, 2));
  toast('JSON 파일을 내려받았습니다');
}
function importJSON(input) {
  const f = input.files && input.files[0]; if (!f) return;
  const fr = new FileReader();
  fr.onload = () => {
    try {
      const d = JSON.parse(fr.result);
      if (!d || !Array.isArray(d.customers)) throw new Error('형식 오류');
      if (!isEmptyDB() && !ensureAdmin()) return;   // 기존 데이터를 지워야 하므로 관리자만
      if (!confirm((isRemote() ? '서버의 현재 데이터를' : '현재 데이터를')
        + ' 파일 내용으로 완전히 교체합니다. 계속할까요?\n(먼저 JSON 내보내기로 백업하는 것을 권장합니다)')) return;
      DB = d; fixShape();
      save(); refreshSelects(); RENDER[CUR_PAGE](); toast('데이터를 불러왔습니다');
    } catch (e) { alert('불러오기 실패: 올바른 UroLink CRM JSON 파일이 아닙니다.'); }
    input.value = '';
  };
  fr.readAsText(f);
}
function sheetFrom(rows) { return XLSX.utils.json_to_sheet(rows); }
function exportAllExcel() {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheetFrom(DB.customers.map(c => ({
    고객사명: c.name, 구분: c.type, 원장: c.doctor, 진료과: c.dept, 등급: c.grade,
    시도: c.sido, 시군구: c.gugun, 전화: c.phone, 담당영업: c.rep,
    태그: (c.tags || []).join(','), 누적수주: custWonAmount(c.id), 메모: c.memo }))), '고객사');
  XLSX.utils.book_append_sheet(wb, sheetFrom(DB.deals.map(d => ({
    고객사: custName(d.custId), 제품: d.product, 금액: num(d.amount), 단계: d.stage, 확률: num(d.prob),
    예상수주일: d.expectedDate, 담당: d.rep, 다음액션: d.nextAction, 액션예정일: d.nextActionDate, 메모: d.memo }))), '딜');
  XLSX.utils.book_append_sheet(wb, sheetFrom(DB.logs.map(l => ({
    일자: l.date, 고객사: custName(l.custId), 유형: l.type, 내용: l.content,
    관심제품: l.interest, 다음액션: l.nextAction, 담당: l.rep }))), '상담일지');
  XLSX.utils.book_append_sheet(wb, sheetFrom(DB.quotes.map(q => ({
    견적번호: q.no, 고객사: custName(q.custId), 견적일: q.date, 담당: q.rep,
    품목수: (q.items || []).length, 합계VAT포함: quoteCalc(q.items).total, 상태: q.status }))), '견적서');
  XLSX.utils.book_append_sheet(wb, sheetFrom(DB.equipments.map(e => ({
    고객사: custName(e.custId), 모델: e.model, 시리얼: e.serial, 설치일: e.installDate,
    보증만료: e.warrantyEnd, 상태: e.status, 계약: e.contract, 담당: e.rep, AS건수: (e.as || []).length }))), '장비');
  XLSX.utils.book_append_sheet(wb, sheetFrom(DB.products.map(p => ({
    제품코드: p.code, 제품명: p.name, 분류: p.cat, 정가: num(p.price), 단위: p.unit, 보증월: num(p.warranty) }))), '제품');
  XLSX.utils.book_append_sheet(wb, sheetFrom(DB.schedules.map(s => ({
    일자: s.date, 시간: s.time, 고객사: s.custId ? custName(s.custId) : '', 유형: s.type,
    내용: s.title, 담당: s.rep, 완료: s.done ? 'Y' : 'N', 결과: s.result }))), '일정');
  XLSX.writeFile(wb, `urolink-crm-${today()}.xlsx`);
  toast('엑셀 파일을 내려받았습니다');
}
function exportDeals() {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheetFrom(DB.deals.map(d => ({
    고객사: custName(d.custId), 제품: d.product, 금액: num(d.amount), 단계: d.stage, 확률: num(d.prob),
    예상수주일: d.expectedDate, 담당: d.rep, 다음액션: d.nextAction }))), '딜');
  XLSX.writeFile(wb, `urolink-deals-${today()}.xlsx`);
}
function exportCustomers() {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheetFrom(DB.customers.map(c => ({
    고객사명: c.name, 구분: c.type, 원장: c.doctor, 등급: c.grade, 시도: c.sido, 시군구: c.gugun,
    전화: c.phone, 담당영업: c.rep, 태그: (c.tags || []).join(','), 누적수주: custWonAmount(c.id) }))), '고객사');
  XLSX.writeFile(wb, `urolink-customers-${today()}.xlsx`);
}
function exportEquip() {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheetFrom(DB.equipments.map(e => ({
    고객사: custName(e.custId), 모델: e.model, 시리얼: e.serial, 설치일: e.installDate,
    보증만료: e.warrantyEnd, 상태: e.status, 계약: e.contract, 담당: e.rep }))), '장비');
  XLSX.writeFile(wb, `urolink-equipments-${today()}.xlsx`);
}
function loadSample() {
  const empty = isEmptyDB();
  if (!empty && !ensureAdmin()) return;   // 기존 데이터를 지워야 하므로 관리자만
  if (!confirm(empty ? '샘플(가상) 데이터를 넣을까요?'
    : '현재 데이터를 모두 지우고 샘플(가상) 데이터를 다시 넣을까요?')) return;
  DB = blankDB(); seed(); fixShape();
  save(); refreshSelects(); RENDER[CUR_PAGE](); toast('샘플 데이터를 넣었습니다');
}
function clearSample() {
  if (!ensureAdmin()) return;
  if (!confirm('샘플 데이터를 모두 삭제하고 빈 상태로 시작할까요?\n(담당자·제품 목록은 남겨둘 수 있습니다 — 다음 확인창에서 선택)')) return;
  const keep = confirm('담당자와 제품 카탈로그는 남길까요?\n확인=남김 / 취소=전부 삭제');
  const reps = DB.reps, prods = DB.products;
  DB = blankDB();
  if (keep) { DB.reps = reps; DB.products = prods; }
  save(); refreshSelects(); RENDER[CUR_PAGE](); toast('샘플 데이터를 삭제했습니다');
}
function resetAll() {
  if (!ensureAdmin()) return;
  if (!confirm('모든 데이터를 삭제합니다. 되돌릴 수 없습니다. 계속할까요?')) return;
  if (!confirm('정말 삭제할까요? 먼저 JSON 내보내기로 백업하는 것을 권장합니다.')) return;
  DB = blankDB(); save(); refreshSelects(); RENDER[CUR_PAGE](); toast('전체 삭제했습니다');
}

/* ───────────────────────── 15. 통합 검색 ───────────────────────── */
let SEARCH_IDX = -1, SEARCH_ITEMS = [];
function openSearch() { $('search-overlay').classList.add('open'); $('search-input').value = ''; $('search-input').focus(); doSearch(); }
function closeSearch() { $('search-overlay').classList.remove('open'); }
function doSearch() {
  const q = ($('search-input').value || '').trim().toLowerCase();
  SEARCH_IDX = -1; SEARCH_ITEMS = [];
  if (!q) {
    $('search-results').innerHTML = `<div class="search-empty">고객사 · 딜 · 견적 · 장비 · 제품을 검색하세요</div>`;
    return;
  }
  const groups = [
    { label: '고객사', ic: 'bi-hospital', c: '#0e7490',
      items: DB.customers.filter(x => (x.name + ' ' + (x.doctor || '') + ' ' + (x.sido || '') + ' ' + (x.rep || '')).toLowerCase().includes(q))
        .slice(0, 6).map(x => ({ t: x.name, s: [x.type, (x.sido || '') + ' ' + (x.gugun || ''), '담당 ' + (x.rep || '-')].join(' · '), go: () => { closeSearch(); openCustDetail(x.id); } })) },
    { label: '딜', ic: 'bi-kanban', c: '#6366f1',
      items: DB.deals.filter(x => (custName(x.custId) + ' ' + x.product + ' ' + (x.rep || '')).toLowerCase().includes(q))
        .slice(0, 6).map(x => ({ t: custName(x.custId) + ' · ' + money(x.amount) + '원', s: x.product + ' · ' + x.stage, go: () => { closeSearch(); openDrawer(x.id); } })) },
    { label: '견적서', ic: 'bi-file-earmark-text', c: '#7c3aed',
      items: DB.quotes.filter(x => (x.no + ' ' + custName(x.custId)).toLowerCase().includes(q))
        .slice(0, 5).map(x => ({ t: x.no + ' · ' + custName(x.custId), s: fmtDate(x.date) + ' · ' + x.status, go: () => { closeSearch(); showPage('quotes'); setTimeout(() => openQuoteModal(x.id), 200); } })) },
    { label: '장비', ic: 'bi-cpu', c: '#16a34a',
      items: DB.equipments.filter(x => (custName(x.custId) + ' ' + x.model + ' ' + (x.serial || '')).toLowerCase().includes(q))
        .slice(0, 5).map(x => ({ t: x.model, s: custName(x.custId) + ' · ' + (x.serial || '') + ' · ' + x.status, go: () => { closeSearch(); showPage('equipments'); setTimeout(() => openEquipModal(x.id), 200); } })) },
    { label: '제품', ic: 'bi-box-seam', c: '#ea580c',
      items: DB.products.filter(x => (x.code + ' ' + x.name).toLowerCase().includes(q))
        .slice(0, 5).map(x => ({ t: x.name, s: x.code + ' · ' + x.cat + ' · ' + won(x.price), go: () => { closeSearch(); showPage('products'); setTimeout(() => openProdModal(x.code), 200); } })) }
  ].filter(g => g.items.length);

  if (!groups.length) { $('search-results').innerHTML = `<div class="search-empty">검색 결과가 없습니다</div>`; return; }
  let html = '', n = 0;
  groups.forEach(g => {
    html += `<div class="search-group-label">${esc(g.label)}</div>`;
    g.items.forEach(it => {
      SEARCH_ITEMS.push(it);
      html += `<div class="search-item" data-i="${n++}" onclick="pickSearch(${n - 1})">
        <div class="search-item-icon" style="background:${g.c}1a;color:${g.c}"><i class="bi ${g.ic}"></i></div>
        <div style="flex:1;min-width:0">
          <div style="font-size:13.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(it.t)}</div>
          <div style="font-size:11.5px;color:#64748b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(it.s)}</div></div></div>`;
    });
  });
  $('search-results').innerHTML = html;
}
function pickSearch(i) { const it = SEARCH_ITEMS[i]; if (it) it.go(); }
function searchKey(e) {
  if (e.key === 'Escape') return closeSearch();
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    SEARCH_IDX += e.key === 'ArrowDown' ? 1 : -1;
    SEARCH_IDX = Math.max(0, Math.min(SEARCH_ITEMS.length - 1, SEARCH_IDX));
    document.querySelectorAll('.search-item').forEach(el => el.classList.toggle('focused', num(el.dataset.i) === SEARCH_IDX));
    const el = document.querySelector('.search-item.focused'); if (el) el.scrollIntoView({ block: 'nearest' });
  }
  if (e.key === 'Enter') { e.preventDefault(); pickSearch(SEARCH_IDX >= 0 ? SEARCH_IDX : 0); }
}

/* ───────────────────────── 16. 로그인 · 계정 ───────────────────────── */
function lgMsg(msg, kind) {
  const el = $('lg-msg');
  el.textContent = msg || '';
  el.className = msg ? (kind || 'err') : '';
}
function showLogin() {
  document.body.classList.add('locked');
  $('login-screen').classList.add('on');
  setTimeout(() => $('lg-email').focus(), 100);
}
function hideLogin() {
  document.body.classList.remove('locked');
  $('login-screen').classList.remove('on');
}
const LG_FAIL_KEY = 'ul_login_fail';
const LG_FAIL_MAX = 5;
function lgFailCount() { try { return num(sessionStorage.getItem(LG_FAIL_KEY)); } catch (e) { return 0; } }
function lgFailSet(v) { try { sessionStorage.setItem(LG_FAIL_KEY, String(v)); } catch (e) {} }
function openLgLock() {
  /* 실제 시도 횟수와 무관하게 '5번'으로 고정 표시 */
  const el = $('ll-n');
  if (el) el.textContent = LG_FAIL_MAX;
  $('lg-lock').classList.add('on');
}
function closeLgLock() { $('lg-lock').classList.remove('on'); }

async function doLogin() {
  const email = $('lg-email').value.trim(), pw = $('lg-pw').value;
  if (!email || !pw) return lgMsg('이메일과 비밀번호를 입력해주세요.');
  $('lg-btn').disabled = true;
  lgMsg('로그인 중...', 'ok');
  const { data, error } = await SB.auth.signInWithPassword({ email, password: pw });
  $('lg-btn').disabled = false;
  if (error) {
    const m = String(error.message || '');
    const wrong = /invalid login|invalid credentials/i.test(m);
    if (wrong) {
      const c = lgFailCount() + 1;
      lgFailSet(c);
      if (c >= LG_FAIL_MAX) { lgMsg(''); openLgLock(); return; }
      return lgMsg('이메일 또는 비밀번호가 올바르지 않습니다. (' + c + '/' + LG_FAIL_MAX + ')');
    }
    return lgMsg(/invalid login|invalid credentials/i.test(m) ? '이메일 또는 비밀번호가 올바르지 않습니다.'
      : /not confirmed/i.test(m) ? '이메일 확인이 완료되지 않은 계정입니다. 관리자에게 문의하세요.'
      : m);
  }
  lgMsg('');
  lgFailSet(0);
  await afterLogin(data.session);
}
async function doLogout() {
  if (!confirm('로그아웃할까요?')) return;
  try { await SB.auth.signOut(); } catch (e) {}
  location.reload();
}
async function afterLogin(session) {
  const { data: p } = await SB.from('ul_profiles')
    .select('id,email,display_name,role').eq('id', session.user.id).maybeSingle();
  ME = p || { id: session.user.id, email: session.user.email,
              display_name: String(session.user.email || '').split('@')[0], role: 'user' };
  if (p && p.active === false) {
    await SB.auth.signOut();
    ME = null;
    showLogin();
    lgMsg('접속이 차단된 계정입니다. 관리자에게 문의해주세요.');
    return;
  }
  hideLogin();
  await pullRemote(false);
  startApp();
}
function renderAccountBox() {
  const box = $('account-box'), card = $('sidebar-user');
  if (!box || !card) return;
  if (!isRemote()) {
    card.style.display = 'none';
    box.innerHTML = '<div class="mode-chip local" title="config.js 에 anon key 를 넣으면 서버 공유 모드가 됩니다">'
      + '<i class="bi bi-hdd"></i>이 보라우자에만 저장</div>';
    return;
  }
  const nm = (ME && (ME.display_name || String(ME.email || '').split('@')[0])) || '-';
  box.innerHTML = '<div class="mode-chip remote"><i class="bi bi-cloud-check"></i>서버 공유</div>';
  card.style.display = 'block';
  $('su-avatar').textContent = nm.slice(0, 1);
  $('su-name').textContent = nm;
  $('su-id').textContent = (ME && ME.email) || '';
  $('su-role').innerHTML = (ME && ME.role === 'admin')
    ? '<span style="color:#0e7490;font-weight:700">관리자</span> · 삭제 가능'
    : '일반 · 삭제 불가';
}
/* 보안: 버밀번호 변경 */
function openPwModal() {
  $('pw-new').value = ''; $('pw-new2').value = '';
  $('pw-msg').style.display = 'none';
  new bootstrap.Modal($('pwModal')).show();
}
function pwMsg(m, ok) {
  const el = $('pw-msg');
  el.textContent = m;
  el.style.display = m ? 'block' : 'none';
  el.style.background = ok ? '#f0fdf4' : '#fef2f2';
  el.style.color = ok ? '#15803d' : '#b91c1c';
  el.style.border = '1px solid ' + (ok ? '#bbf7d0' : '#fecaca');
}
async function doChangePw() {
  const a = $('pw-new').value, b = $('pw-new2').value;
  if (a.length < 8) return pwMsg('8자 이상으로 정해주세요.');
  if (a !== b) return pwMsg('다시 입력한 버밀번호가 달릅니다.');
  $('pw-btn').disabled = true;
  const { error } = await SB.auth.updateUser({ password: a });
  $('pw-btn').disabled = false;
  if (error) return pwMsg(error.message);
  pwMsg('변경되었습니다.', true);
  setTimeout(function () { const m = bootstrap.Modal.getInstance($('pwModal')); if (m) m.hide(); }, 1200);
}
/* 사용자 관리 (관리자 전용) */
let U_ACTIVE = true;          /* 사용자 목록 탭: 활성 / 비활성 */
let U_ROWS = [];
function userTab(on, el) {
  U_ACTIVE = on;
  document.querySelectorAll('#usermgmt-card .wt-tab').forEach(b => b.classList.remove('on'));
  if (el) el.classList.add('on');
  paintUsers();
}
async function renderUsers() {
  const card = $('usermgmt-card');
  if (!card) return;
  const addBtn = $('add-user-btn');
  if (!isRemote() || !isAdmin()) {
    card.style.display = 'none';
    if (addBtn) addBtn.style.display = 'none';
    return;
  }
  if (addBtn) addBtn.style.display = 'inline-block';
  card.style.display = 'block';
  const { data, error } = await SB.from('ul_profiles').select('*').order('dept').order('created_at');
  if (error) {
    $('user-list').innerHTML = '<div class="p-3" style="color:#dc2626;font-size:12.5px">목록을 불러오지 못했습니다: ' + esc(error.message) + '</div>';
    return;
  }
  U_ROWS = data || [];
  /* 부서·직급 자동완성 */
  fillDatalist('dl-dept', [...new Set(U_ROWS.map(u => u.dept).filter(Boolean))]);
  fillDatalist('dl-pos', [...new Set(U_ROWS.map(u => u.position).filter(Boolean))]);
  paintUsers();
}
function paintUsers() {
  const q = trimv(($('u-search') || {}).value).toLowerCase();
  let rows = U_ROWS.filter(u => (u.active !== false) === U_ACTIVE);
  if (q) rows = rows.filter(u => ((u.display_name || '') + ' ' + (u.email || '') + ' '
    + (u.dept || '') + ' ' + (u.position || '')).toLowerCase().includes(q));
  const onCnt = U_ROWS.filter(u => u.active !== false).length;
  const offCnt = U_ROWS.length - onCnt;
  if ($('u-tab-on')) $('u-tab-on').textContent = '활성 ' + onCnt;
  if ($('u-tab-off')) $('u-tab-off').textContent = '비활성 ' + offCnt;

  if (!rows.length) {
    $('user-list').innerHTML = '<div class="p-4 text-center" style="color:#94a3b8;font-size:13px">'
      + (q ? '검색 결과가 없습니다' : U_ACTIVE ? '활성 계정이 없습니다' : '비활성 계정이 없습니다') + '</div>';
    return;
  }
  /* 부서별 그룹 */
  const grps = [];
  rows.forEach(u => { const d = u.dept || '미지정'; if (!grps.includes(d)) grps.push(d); });
  const body = grps.map(g => {
    const list = rows.filter(u => (u.dept || '미지정') === g);
    return '<tr class="u-grp"><td colspan="6"><i class="bi bi-building me-1"></i>' + esc(g)
      + '<span class="cnt">' + list.length + '명</span></td></tr>'
      + list.map(u => {
        const me = u.id === (ME && ME.id);
        const off = u.active === false;
        return '<tr>'
          + '<td><div style="font-weight:700;font-size:13px">' + esc(u.display_name || '-')
            + (me ? ' <span class="u-badge usr">나</span>' : '')
            + (off ? ' <span class="u-badge off">비활성</span>' : '') + '</div>'
            + '<div style="font-size:11.5px;color:#64748b">' + esc(u.email || '') + '</div></td>'
          + '<td><input type="text" class="form-control form-control-sm" style="max-width:130px" value="' + esc(u.dept || '')
            + '" placeholder="부서" onchange="setUserField(\'' + esc(u.id) + '\',\'dept\',this.value)"></td>'
          + '<td><input type="text" class="form-control form-control-sm" style="max-width:110px" value="' + esc(u.position || '')
            + '" placeholder="직급" onchange="setUserField(\'' + esc(u.id) + '\',\'position\',this.value)"></td>'
          + '<td><select class="form-select form-select-sm" style="max-width:150px"'
            + (me ? ' disabled title="본인 역할은 바꿀 수 없습니다"' : '')
            + ' onchange="setUserRole(\'' + esc(u.id) + '\',this.value)">'
            + '<option value="user"' + (u.role === 'user' ? ' selected' : '') + '>일반</option>'
            + '<option value="admin"' + (u.role === 'admin' ? ' selected' : '') + '>관리자</option></select></td>'
          + '<td style="font-size:11.5px;color:#64748b">' + fmtDate(u.created_at) + '</td>'
          + '<td class="text-end" style="white-space:nowrap">'
            + '<button class="btn btn-sm btn-outline-secondary" onclick="sendReset(\'' + esc(u.email) + '\')" title="비밀번호 재설정 메일 발송"><i class="bi bi-envelope"></i> 비번</button>'
            + (me ? '' : ' <button class="btn btn-sm ' + (off ? 'btn-outline-success' : 'btn-outline-danger')
                + '" onclick="setUserActive(\'' + esc(u.id) + '\',' + (off ? 'true' : 'false') + ')">'
                + (off ? '<i class="bi bi-arrow-counterclockwise"></i> 복구' : '<i class="bi bi-slash-circle"></i> 차단') + '</button>')
          + '</td></tr>';
      }).join('');
  }).join('');
  $('user-list').innerHTML = '<div style="overflow-x:auto"><table class="table table-hover mb-0">'
    + '<thead><tr><th>이름 · 이메일</th><th>부서</th><th>직급</th><th>역할</th><th>가입일</th><th></th></tr></thead>'
    + '<tbody>' + body + '</tbody></table></div>';
}
async function setUserField(id, field, v) {
  const upd = {}; upd[field] = trimv(v) || null;
  const { error } = await SB.from('ul_profiles').update(upd).eq('id', id);
  if (error) { alert('수정 실패: ' + error.message); renderUsers(); return; }
  toast('수정했습니다');
  renderUsers();
}
async function setUserRole(id, role) {
  const { error } = await SB.from('ul_profiles').update({ role }).eq('id', id);
  if (error) { alert('역할 변경 실패: ' + error.message); renderUsers(); return; }
  toast('역할을 ' + (role === 'admin' ? '관리자' : '일반') + '로 변경했습니다');
  renderUsers();
}
async function setUserActive(id, on) {
  const u = U_ROWS.find(x => x.id === id) || {};
  if (!on && !confirm((u.display_name || u.email) + ' 계정의 접속을 차단할까요?\n\n로그인해도 데이터를 조회·수정할 수 없게 됩니다.\n(계정 자체는 남아 있어 언제든 복구 가능합니다)')) return;
  const { error } = await SB.from('ul_profiles').update({ active: on }).eq('id', id);
  if (error) { alert('변경 실패: ' + error.message); return; }
  toast(on ? '접속을 복구했습니다' : '접속을 차단했습니다');
  renderUsers();
}
async function sendReset(email) {
  if (!email) return;
  if (!confirm(email + ' 로 비밀번호 재설정 메일을 보낼까요?')) return;
  const { error } = await SB.auth.resetPasswordForEmail(email, { redirectTo: location.href.split('#')[0] });
  if (error) { alert('발송 실패: ' + error.message); return; }
  toast('재설정 메일을 보냈습니다');
}

/* ══ 사용자 추가 (앱 안에서 계정 발급) ══
   1) ul_invites 에 이메일 등록 — 허용목록 트리거가 이 이메일만 가입을 통과시킨다
   2) 세션을 저장하지 않는 별도 클라이언트로 signUp — 관리자 로그인이 풀리지 않게
   3) 트리거가 만든 ul_profiles 행에 이름·부서·직급·역할을 채운다 */
let U_ROLE = 'user';
function pickRole(r, el) {
  U_ROLE = r;
  document.querySelectorAll('#u-role-cards .role-card').forEach(c => c.classList.remove('on'));
  if (el) el.classList.add('on');
}
function genTempPw() {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ', b = 'abcdefghijkmnpqrstuvwxyz', c = '23456789', d = '!@#$%';
  const pick = (set, k) => Array.from({ length: k }, (_, i) => set[(Date.now() + i * 7919 + Math.floor(performance.now() * 1000)) % set.length]).join('');
  $('u-pw').value = pick(a, 2) + pick(b, 5) + pick(c, 3) + pick(d, 1);
}
function uMsg(m, ok) {
  const el = $('u-msg');
  el.innerHTML = m || '';
  el.style.display = m ? 'block' : 'none';
  el.style.background = ok ? '#f0fdf4' : '#fef2f2';
  el.style.color = ok ? '#15803d' : '#b91c1c';
  el.style.border = '1px solid ' + (ok ? '#bbf7d0' : '#fecaca');
}
function openUserModal() {
  if (!isRemote() || !isAdmin()) return;
  ['u-email','u-pw','u-name','u-dept','u-position'].forEach(id => { $(id).value = ''; });
  $('u-as-rep').checked = true;
  pickRole('user', document.querySelector('#u-role-cards .role-card[data-role="user"]'));
  genTempPw();
  uMsg('');
  new bootstrap.Modal($('userModal')).show();
}
async function createUser() {
  const email = trimv($('u-email').value).toLowerCase();
  const pw = trimv($('u-pw').value);
  const name = trimv($('u-name').value);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return uMsg('이메일 형식을 확인해주세요.');
  if (pw.length < 8) return uMsg('임시 비밀번호는 8자 이상이어야 합니다.');
  if (!name) return uMsg('이름을 입력해주세요.');
  if (U_ROWS.some(u => String(u.email || '').toLowerCase() === email)) return uMsg('이미 등록된 이메일입니다.');

  $('u-btn').disabled = true;
  uMsg('계정을 만들고 있습니다...', true);

  /* 1) 허용목록 등록 */
  const inv = await SB.from('ul_invites').upsert({ email, invited_by: ME ? ME.id : null });
  if (inv.error) {
    $('u-btn').disabled = false;
    return uMsg(/relation .*ul_invites/i.test(inv.error.message)
      ? 'migration_v2.sql 을 먼저 실행해주세요 (허용목록 테이블이 없습니다).'
      : '허용목록 등록 실패: ' + esc(inv.error.message));
  }

  /* 2) 관리자 세션을 건드리지 않는 임시 클라이언트로 가입 */
  let uid = null;
  try {
    const tmp = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY,
      { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    const { data, error } = await tmp.auth.signUp({ email, password: pw });
    if (error) throw error;
    uid = data && data.user && data.user.id;
    if (!uid) throw new Error('계정 id 를 받지 못했습니다');
  } catch (e) {
    $('u-btn').disabled = false;
    const m = String(e.message || '');
    if (/signup.*disabled|not allowed/i.test(m)) {
      return uMsg('Supabase 설정에서 <b>Allow new users to sign up</b> 을 켜주세요.<br>'
        + '(허용목록 트리거가 등록되지 않은 이메일을 막으므로 안전합니다)');
    }
    if (/already registered|already exists/i.test(m)) return uMsg('이미 가입된 이메일입니다.');
    return uMsg('가입 실패: ' + esc(m));
  }

  /* 3) 프로필 보강 (트리거가 만든 행을 갱신) */
  const prof = { display_name: name, dept: trimv($('u-dept').value) || null,
    position: trimv($('u-position').value) || null, role: U_ROLE, active: true };
  const up = await SB.from('ul_profiles').update(prof).eq('id', uid);
  if (up.error) console.error('[createUser/profile]', up.error);

  /* 4) 영업 담당자 명단에도 추가 */
  if ($('u-as-rep').checked && !DB.reps.some(r => r.name === name)) {
    DB.reps.push({ name, role: trimv($('u-position').value) || trimv($('u-dept').value) || '' });
    save(true);
    refreshDatalists();
  }

  $('u-btn').disabled = false;
  uMsg('<b>' + esc(name) + '</b> 계정을 만들었습니다.<br>이메일 <b>' + esc(email)
    + '</b> / 임시 비밀번호 <b>' + esc(pw) + '</b><br>본인에게 전달하고 첫 로그인 후 변경하도록 안내해주세요.', true);
  $('u-email').value = ''; $('u-name').value = '';
  renderUsers();
  if (CUR_PAGE === 'settings') renderSettings();
}

/* ───────────────────────── 17. 초기화 ───────────────────────── */
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openSearch(); }
  if (e.key === 'Escape') { closeSearch(); closeDrawer(); closeBell(); }
});
window.addEventListener('hashchange', () => {
  const p = location.hash.replace('#', '');
  if (p && PAGES.includes(p) && p !== CUR_PAGE) showPage(p);
});
/* 다른 탭·다른 사람의 변경을 반영: 탭으로 돌아올 때 다시 불러오기 */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (isRemote() && !SYNCING) pullRemote(false);
  checkVersion();
});

/* ── 자동 최신화: Ctrl+Shift+R 없이 새 배포를 감지해 반영 ──
   version.json 을 캐시 없이 조회해 APP_VERSION 과 다르면 알림 바를 띄운다.
   에셋은 index.html 에서 ?v=<버전> 으로 불러오므로 새로고침만으로 최신 파일이 적용된다. */
async function checkVersion() {
  if (location.protocol === 'file:') return;
  try {
    const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return;
    const j = await r.json();
    if (!j || !j.version || j.version === APP_VERSION) return;
    const openModal = document.querySelector('.modal.show');
    const drawerOpen = $('deal-drawer') && $('deal-drawer').classList.contains('open');
    if (openModal || drawerOpen) { $('update-bar').classList.add('on'); return; }  // 입력 중이면 알림만
    $('update-bar').classList.add('on');
  } catch (e) { /* 오프라인 등 — 조용히 무시 */ }
}
function applyUpdate() { location.reload(); }
setInterval(checkVersion, 10 * 60 * 1000);   /* 10분마다 확인 */

document.addEventListener('click', e => {
  const p = $('bell-panel');
  if (!p || !p.classList.contains('on')) return;
  if (p.contains(e.target) || (e.target.closest && e.target.closest('#bell-btn'))) return;
  p.classList.remove('on');
});
function startApp() {
  const ns = $('nav-settings');
  if (ns) ns.style.display = isAdmin() ? '' : 'none';   /* 관리자에게만 메뉴 노출 */
  renderAccountBox();
  refreshSelects();
  refreshCounts();
  const p = location.hash.replace('#', '');
  showPage(PAGES.includes(p) ? p : 'overview');
  checkVersion();
}

(async function boot() {
  const hasCfg = CFG.SUPABASE_URL && CFG.SUPABASE_KEY;
  if (hasCfg && window.supabase) {
    MODE = 'remote';
    SB = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY);
    let session = null;
    try { session = (await SB.auth.getSession()).data.session; } catch (e) {}
    if (!session) { showLogin(); return; }
    await afterLogin(session);
    return;
  }
  if (hasCfg && !window.supabase) {
    alert('Supabase 라이브러리를 불러오지 못했습니다. 인터넷 연결을 확인해주세요.\n우선 이 브라우저 저장 모드로 실행합니다.');
  }
  MODE = 'local';
  loadLocal();
  startApp();
})();
