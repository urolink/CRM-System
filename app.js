/* ══════════════════════════════════════════════════════════════
   UroLink CRM — 애플리케이션 로직
   저장소: localStorage (키 urolink_crm_v1). 백엔드 없이 단독 동작.
   ══════════════════════════════════════════════════════════════ */

/* ───────────────────────── 1. 상수 ───────────────────────── */
const LS_KEY = 'urolink_crm_v1';
/* 배포 버전 — index.html 의 ?v= 값과 version.json 과 반드시 동일하게 유지 */
const APP_VERSION = '20260731q';

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
  if (n >= 1000000000000) return s + (n / 1000000000000).toFixed(1).replace(/\.0$/, '') + '조';
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
                 equipments: 'ul_equipments', products: 'ul_products', schedules: 'ul_schedules', reps: 'ul_reps',
                 targets: 'ul_targets', audits: 'ul_audits', prospects: 'ul_prospects' };
const KEY_FIELD = { products: 'code', reps: 'name' };   // 그 외 컬렉션은 'id'
/* 나중에 추가된 테이블 — migration_v3.sql / migration_v4.sql 을 아직 실행하지 않은 환경도 있다.
   이 테이블이 없다고 해서 앱 전체 로딩이 막히면 안 되므로 선택적으로 취급한다. */
const OPTIONAL_TABLES = ['targets', 'audits', 'prospects'];
const MISSING_TABLES = new Set();
const isMissingRelation = m => /relation .* does not exist|could not find the table|schema cache/i.test(String(m || ''));
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
           reps: [], targets: [], audits: [], prospects: [], meta: { ver: 1, updatedAt: null, sample: false } };
}
function fixShape() {
  const b = blankDB();
  Object.keys(b).forEach(k => { if (DB[k] == null) DB[k] = b[k]; });
  if (!DB.meta) DB.meta = b.meta;
  /* 단계 개편(리드발굴 폐지) 이전 데이터 이관 — 없는 단계면 칸반에서 사라지므로.
     ⚠ 조건은 반드시 '리드발굴' 이어야 한다. '상담중' 으로 두면 매 로드마다
        상담중 딜의 확률이 25 로 되돌아가 사용자가 조정한 값이 사라진다. */
  (DB.deals || []).forEach(d => { if (d.stage === '리드발굴') { d.stage = '상담중'; d.prob = 25; } });
  /* 분류(cat) 미기록 딜 보정 — 제품이 나중에 삭제돼도 장비/소모품 구분이 유지되도록 */
  (DB.deals || []).forEach(d => {
    if (!d.cat) { const p = prodByCode(d.productCode); if (p) d.cat = p.cat; }
  });
  /* 담당자의 영업부서 여부 — 기존 담당자는 전부 영업으로 간주(관리자가 사용자 관리에서 끌 수 있음) */
  (DB.reps || []).forEach(r => { if (r.salesDept == null) r.salesDept = true; });
}
/* 선택적 테이블(목표·이력)만 있는 상태를 '데이터 있음' 으로 오판하지 않게 제외한다 */
const isEmptyDB = () => Object.keys(TABLES)
  .filter(k => OPTIONAL_TABLES.indexOf(k) < 0)
  .every(k => !(DB[k] || []).length);
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
    /* 서버에 아직 없는 테이블은 건너뛴다. 값은 localStorage 캐시에 남아 있으므로
       SQL 을 실행하면 그때부터 자동으로 올라간다. */
    if (MISSING_TABLES.has(coll)) return;
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
    /* 목표·변경이력 테이블이 없어서 실패한 것이면, 해당 테이블만 빼고 계속 쓴다 */
    if (isMissingRelation(m)) {
      OPTIONAL_TABLES.forEach(t => {
        if (String(TABLES[t]) && m.indexOf(TABLES[t]) >= 0) MISSING_TABLES.add(t);
      });
      if (MISSING_TABLES.size) {
        console.warn('[pushDiff] 미생성 테이블 — 로컬에만 보관:', [...MISSING_TABLES].join(', '));
        toast('목표·변경이력은 이 브라우저에만 저장됩니다 (migration_v3.sql 미실행)');
        return;
      }
    }
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

  /* 선택적 테이블이 아직 없는 경우는 오류로 보지 않고 빈 값으로 넘긴다 */
  names.forEach((nm, i) => {
    const r = res[i];
    if (r && r.error && OPTIONAL_TABLES.indexOf(nm) >= 0 && isMissingRelation(r.error.message)) {
      MISSING_TABLES.add(nm);
      res[i] = { data: [], error: null };
    }
  });
  if (MISSING_TABLES.size) console.warn('[pullRemote] 미생성 테이블(로컬로만 보관):', [...MISSING_TABLES].join(', '));

  const bad = res.find(r => r && r.error);
  if (bad) {
    console.error('[pullRemote]', bad.error);
    const m = String(bad.error.message || '');
    if (isMissingRelation(m)) {
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
  /* 아직 서버에 테이블이 없는 선택적 컬렉션(목표·이력·타겟병원)은 서버의 빈 결과로
     로컬 데이터를 지우면 안 된다 — 이 브라우저(캐시)에 있던 값을 그대로 이어간다.
     ⚠ 여기서 덮어써버리면 migration_v*.sql 실행 전까지 새로고침할 때마다
        타겟병원 등이 통째로 사라진다(실제로 있었던 버그).
     ⚠ F5로 완전히 새로 로드하면 이 시점의 DB는 아직 null 이다(remote 모드는
        loadLocal() 을 안 거친다) — 그럴 땐 localStorage 캐시에서 이어받아야
        한다. 안 그러면 '메모리상 DB'만 비어있다고 착각해 캐시까지 무시하고
        빈 값으로 지워버린다(F5 할 때마다 사라지던 원인). */
  let prevLocal = DB;
  if (!prevLocal) {
    try { prevLocal = JSON.parse(localStorage.getItem(cacheKey()) || 'null'); } catch (e) { prevLocal = null; }
  }
  prevLocal = prevLocal || blankDB();
  DB = blankDB();
  names.forEach((n, i) => {
    DB[n] = MISSING_TABLES.has(n) ? (prevLocal[n] || []) : (res[i].data || []).map(r => r.data).filter(Boolean);
  });
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
/* 영업 분석 화면 전용 — 담당자 관리에서 '영업부서'로 켜둔 사람만. 데이터 자체는 안 지운다 */
const salesRepNames = () => DB.reps.filter(r => r.salesDept !== false).map(r => r.name);

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
    return { id: 'd' + (i + 1), custId: r[0], product: p ? p.name : r[1], productCode: r[1], cat: p ? p.cat : '장비',
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
    DB.deals.push({ id: 'p' + (i + 1), custId: r[0], productCode: r[1], product: p ? p.name : r[1], cat: p ? p.cat : '장비',
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
const PAGES = ['overview','mix','dashboard','analysis','sales','schedule','quotes','prospects','customers','equipments','products','settings'];
/* 사이드바 하이라이트 귀속: 장비 페이지는 '고객사·장비' 메뉴에 속함 */
const NAV_OF = { equipments: 'customers' };
const RENDER = {
  overview: () => renderOverview(), mix: () => renderMix(), dashboard: () => renderDashboard(),
  analysis: () => renderAnalysis(), sales: () => renderSales(),
  schedule: () => renderSchedule(), quotes: () => renderQuotes(), prospects: () => renderProspects(),
  customers: () => renderCustomers(),
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
    key: 'sch-today-' + s.id, sec: '오늘 일정', ic: 'bi-calendar-event', c: '#0e7490',
    t: (schCustLabel(s)) + ' · ' + s.type,
    sub: (s.time ? s.time + ' ' : '') + s.title, go: "showPage('schedule')", urgent: true }));
  DB.schedules.filter(s => !s.done && s.date < td).forEach(s => out.push({
    key: 'sch-late-' + s.id, sec: '놓친 일정', ic: 'bi-exclamation-circle', c: '#dc2626',
    t: (schCustLabel(s)) + ' · ' + fmtDate(s.date).slice(5),
    sub: s.title + ' — 결과 미입력', go: "showPage('schedule');schOverdue()", urgent: true }));
  DB.deals.filter(d => OPEN_STAGES.includes(d.stage) && d.nextAction).forEach(d => {
    const n = dDays(d.nextActionDate || d.expectedDate);
    if (n == null || n > 0) return;
    out.push({ key: 'deal-next-' + d.id, sec: '다음 액션', ic: 'bi-flag', c: n < 0 ? '#dc2626' : '#ea580c',
      t: custName(d.custId) + ' · ' + money(d.amount) + '원',
      sub: d.nextAction + (n < 0 ? ' (' + (-n) + '일 지연)' : ' (오늘)'),
      go: "openDrawer('" + d.id + "')", urgent: true });
  });
  DB.equipments.forEach(e => {
    const n = dDays(e.warrantyEnd);
    if (n != null && n >= 0 && n <= 90) out.push({ key: 'eq-warr-' + e.id, sec: '보증 만료 임박', ic: 'bi-shield-exclamation', c: '#ea580c',
      t: custName(e.custId) + ' · ' + e.model, sub: 'D-' + n + ' (' + fmtDate(e.warrantyEnd) + ')', go: "showPage('equipments')" });
    if (e.status === '수리중') out.push({ key: 'eq-as-' + e.id, sec: 'A/S 진행', ic: 'bi-tools', c: '#dc2626',
      t: custName(e.custId) + ' · ' + e.model, sub: '수리중 — 진행 확인 필요', go: "showPage('equipments')" });
  });
  DB.customers.forEach(c => {
    if (c.grade !== 'A' && c.grade !== 'B') return;
    const last = DB.logs.filter(l => l.custId === c.id).map(l => l.date).sort().pop();
    const gap = last ? -dDays(last) : null;
    if (gap == null || gap > 60) out.push({ key: 'cust-gap-' + c.id, sec: '장기 미접촉', ic: 'bi-person-dash', c: '#7c3aed',
      t: c.name + ' (' + c.grade + '등급)', sub: last ? gap + '일간 접촉 없음' : '접촉 이력 없음',
      go: "openCustDetail('" + c.id + "')" });
  });
  return out;
}
/* 알림 확인(읽음) 상태 — 계정별로 저장한다(로그인 계정 id 기준이라 브라우저·기기를 바꿔도 동일하게 적용됨).
   알림 자체는 저장된 레코드가 아니라 매번 현재 상태로 다시 계산되므로,
   '읽음' 대신 '이 알림을 마지막으로 봤을 때 있었다' 는 키 목록을 남겨 배지에서만 뺀다. */
const bellSeenKey = () => 'urolink_bell_seen_' + ((ME && (ME.id || ME.email)) || 'local');
function getBellSeen() {
  try { return new Set(JSON.parse(localStorage.getItem(bellSeenKey()) || '[]')); } catch (e) { return new Set(); }
}
function setBellSeen(keys) {
  try { localStorage.setItem(bellSeenKey(), JSON.stringify([...keys])); } catch (e) {}
}
function renderBell() {
  if (!DB) return;
  const items = alertItems();
  const seen = getBellSeen();
  const unseen = items.filter(x => !seen.has(x.key));
  const urgent = unseen.filter(x => x.urgent).length;
  const badge = $('bell-badge');
  if (badge) {
    badge.textContent = urgent || unseen.length || '';
    badge.style.display = (urgent || unseen.length) ? 'inline-block' : 'none';
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
      '<div class="bp-item' + (seen.has(x.key) ? '' : ' new') + '" onclick="closeBell();' + x.go + '">'
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
  /* 펼쳐서 봤으면 지금 뜬 알림은 전부 확인 처리 — 배지 숫자가 사라진다.
     새로 생기는 알림(키가 다른)만 다음부터 다시 카운트된다. */
  setBellSeen(new Set(alertItems().map(x => x.key)));
  renderBell();
}
function closeBell() { const p = $('bell-panel'); if (p) p.classList.remove('on'); }

function refreshCounts() {
  if (!DB) return;   // 로그인 직후 서버 로드 이전(DB 미생성) 시점 방어
  const setCnt = (id, v) => { const el = $(id); if (el) el.textContent = v || ''; };
  setCnt('cnt-deals',  DB.deals.filter(d => OPEN_STAGES.includes(d.stage)).length);
  setCnt('cnt-sch',    DB.schedules.filter(s => !s.done && (dDays(s.date) ?? -99) >= 0).length);
  setCnt('cnt-quotes', DB.quotes.length);
  setCnt('cnt-prospects', DB.prospects.length);
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
  fillDatalist('dl-rep', repNames());
  /* 기존 값에서 태그·시도 자동완성 목록을 만든다 */
  fillDatalist('dl-tag', [...new Set(DB.customers.flatMap(c => (c.tags || []).map(t => String(t).trim())))].filter(Boolean));
  fillDatalist('dl-sido', [...new Set(DB.customers.map(c => c.sido).filter(Boolean))].sort());
}
const trimv = v => String(v == null ? '' : v).trim();
/* 전화번호 비교용 — 하이픈/공백 표기차를 무시한다 */
const digitsOnly = v => String(v == null ? '' : v).replace(/[^0-9]/g, '');
/* onclick 문자열 안에 쓰는 단일인용부호. HTML 속성은 큰따옴표로 감싸므로 그대로 유효하다.
   (백슬래시 이스케이프는 파이썬/셸을 거치며 깨지기 쉬워 상수로 둔다) */
const Q = String.fromCharCode(39);
/* 줄바꿈. 패치 스크립트를 거치며 백슬래시가 사라지는 사고가 반복돼 상수로 둔다 */
const NL = String.fromCharCode(10);
/* 인라인 핸들러(onclick 등)의 JS 문자열에 값을 넣을 때 쓴다.
   ⚠ esc() 를 쓰면 안 된다. esc() 는 ' → &#39; 로 바꾸는데 브라우저가 속성을
      파싱할 때 다시 ' 로 되돌리므로 JS 문자열이 거기서 끊긴다.
      담당자·경쟁사·태그·제품코드는 사용자가 직접 입력하는 값이라 실제 위험이다.
   먼저 JS 이스케이프(\ 와 ')를 넣고, 그 다음 HTML 속성 이스케이프를 한다. */
const jsq = v => String(v == null ? '' : v)
  .replace(/\\/g, '\\\\')
  .replace(/'/g, "\\'")
  .replace(/[\r\n]+/g, ' ')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/* 변경 기록용 사용자 표시명 (로컬 모드면 빈 문자열) */
const curUserName = () => (ME && (ME.display_name || ME.email)) || '';

/* 실주 사유 — 유로링크에서 실제로 쓰는 표현으로 자유롭게 고쳐 쓰면 된다 */
const LOST_REASONS = ['가격 열위', '경쟁사 스펙 우위', '예산 미확보 · 보류', '기존 거래처 관계',
  '납기 지연', '의사결정 지연 · 무응답', '원내 승인 실패', '기타'];
/* 경쟁사 추천 목록의 시작값. 실제 입력한 값이 자동으로 누적되므로 초기 참고용이다 */
const COMP_SEED = ['Olympus', 'KARL STORZ', 'Richard Wolf', 'Boston Scientific',
  'Cook Medical', 'Lumenis', 'Quanta System', 'Dornier', 'EMS'];
const compNames = () => [...new Set([
  ...DB.deals.map(d => trimv(d.competitor)).filter(Boolean), ...COMP_SEED
])].sort((a, b) => a.localeCompare(b));
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

/* 제품/장비 선택칸 — 등록된 제품 중에서만 고를 수 있다(자유 타이핑으로 새 제품이
   생기지 않는다). 제품이 새로 등록되면 refreshSelects() 가 다시 불릴 때 자동으로 목록에 반영된다. */
function fillProductSelect(id) {
  fillSelect($(id), DB.products.map(p => ({ v: p.code, l: p.name })), { blank: '제품 선택', keep: true });
}
function refreshSelects() {
  refreshDatalists();
  /* sch-rep 은 renderSchedule 이 '👥 담당 전체' 라벨로 직접 채운다(라벨 덮어쓰기 방지) */
  ['pipe-rep','c-rep','pr-rep'].forEach(id => fillSelect($(id), repNames(), { blank: '전체 담당자', keep: true }));
  ['d-product','sl-product','e-model','l-interest','s-interest','pr-interest'].forEach(fillProductSelect);
  fillSelect($('d-stage'), STAGES.map(s => s.name));
  fillSelect($('d-lost-reason'), LOST_REASONS, { blank: '선택하세요', keep: true });
  fillDatalist('dl-comp', compNames());
  fillSelect($('dl-stage'), STAGES.map(s => s.name), { blank: '전체 단계', keep: true });
  fillSelect($('p-cat'), [...new Set(DB.products.map(p => p.cat))], { blank: '전체 분류', keep: true });
  fillSelect($('c-region'), [...new Set(DB.customers.map(c => c.sido).filter(Boolean))].sort(), { blank: '전체 지역', keep: true });
  fillSelect($('pr-region'), [...new Set(DB.prospects.map(p => p.sido).filter(Boolean))].sort(), { blank: '전체 지역', keep: true });
  fillSelect($('pr-status'), PROSPECT_STATUS, { blank: '전체 상태', keep: true });
  // 연도 select
  const years = [...new Set([new Date().getFullYear(), ...DB.deals.map(d => num(String(d.expectedDate).slice(0, 4))).filter(y => y > 2000)])].sort((a, b) => b - a);
  /* 연도 목록이 늘어나면 다시 채운다. 사용자가 고른 값은 그대로 유지. */
  const ay = $('ana-year');
  if (ay) {
    const sig = years.join(',');
    if (ay.dataset.ysig !== sig) {
      const cur = ay.value;
      fillSelect(ay, years.map(y => ({ v: y, l: y + '년' })));
      ay.dataset.ysig = sig;
      ay.value = (cur && years.includes(num(cur))) ? cur : new Date().getFullYear();
    }
  }
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
  const ym = today().slice(0, 7);
  const dbDue = openD.filter(d => String(d.expectedDate).slice(0, 7) === ym);
  const allWon = DB.deals.filter(d => d.stage === '계약완료');
  const dbAvgWon = allWon.length ? allWon.reduce((t, d) => t + num(d.amount), 0) / allWon.length : 0;
  const dbAct = DB.schedules.filter(x => x.done && String(x.date).slice(0, 7) === ym).length;
  const dbMiss = DB.schedules.filter(x => !x.done && x.date < today()).length;

  /* 밴드 전 항목 드릴다운 — 숫자를 보면 바로 내역을 확인할 수 있어야 한다 */
  DRL.dbA = a; DRL.dbB = b; DRL.dbLabel = label;
  $('db-band').innerHTML = `
    <div class="wt-hero clickable" onclick="drillDeals('${esc(label)} 확정 수주','${esc(label)} (${fmtDate(a)}~${fmtDate(b)}) 예상 수주일 기준 계약완료',DB.deals.filter(function(d){return d.stage==='계약완료'&&inRange(d.expectedDate,DRL.dbA,DRL.dbB)}))">
      <div class="l">${esc(label)} 확정 수주 (계약완료)</div>
      <b>${money(wonAmt)}원</b>
      <div class="s">${wonD.length}건 · 평균 ${money(wonD.length ? wonAmt / wonD.length : 0)}원</div>
    </div>
    <div class="wt-fact clickable" onclick="drillDeals('진행 파이프라인','계약완료·실주를 제외한 열린 딜 전체',DB.deals.filter(function(d){return OPEN_STAGES.indexOf(d.stage)>=0}))">
      <div class="l">진행 파이프라인</div><b>${money(openAmt)}원</b><div class="s">${openD.length}건 열림</div></div>
    <div class="wt-fact clickable" onclick="drillWgt()">
      <div class="l">확률가중 예상</div><b>${money(wgt)}원</b><div class="s">단계 확률 반영</div></div>
    <div class="wt-fact clickable" onclick="drillDeals('${esc(label)} 종결 딜','계약완료 ${wonD.length}건 + 실주 ${lostD.length}건 · 성공률 ${winRate}%',DB.deals.filter(function(d){return (d.stage==='계약완료'||d.stage==='실주')&&inRange(d.expectedDate,DRL.dbA,DRL.dbB)}))">
      <div class="l">수주 성공률</div><b class="${winRate >= 50 ? 'gr' : winRate < 30 ? 'rd' : ''}">${winRate}%</b>
      <div class="s">종결 ${closed}건 중 ${wonD.length}건</div></div>
    <div class="wt-fact clickable" onclick="drillCusts('거래 고객사','등록된 고객사 전체',DB.customers)">
      <div class="l">거래 고객사</div><b>${DB.customers.length}</b>
      <div class="s">A등급 ${DB.customers.filter(c => c.grade === 'A').length}곳</div></div>
    <div class="wt-fact clickable" onclick="drillDeals('이번달 마감 예정','예상 수주일이 이번달인 열린 딜',DB.deals.filter(function(d){return OPEN_STAGES.indexOf(d.stage)>=0&&String(d.expectedDate).slice(0,7)===today().slice(0,7)}))">
      <div class="l">이번달 마감 예정</div><b>${dbDue.length}건</b>
      <div class="s">${money(dbDue.reduce((t, d) => t + num(d.amount), 0))}원</div></div>
    <div class="wt-fact clickable" onclick="drillDeals('계약완료 딜 전체','평균 규모 산정 대상',DB.deals.filter(function(d){return d.stage==='계약완료'}))">
      <div class="l">평균 수주 규모</div><b>${money(dbAvgWon)}원</b>
      <div class="s">계약완료 ${DB.deals.filter(d => d.stage === '계약완료').length}건 평균</div></div>
    <div class="wt-fact clickable" onclick="drillSch('이번달 완료 활동','방문·전화·데모 등 완료 처리된 일정',DB.schedules.filter(function(x){return x.done&&String(x.date).slice(0,7)===today().slice(0,7)}))">
      <div class="l">이번달 활동</div><b>${dbAct}건</b>
      <div class="s">${dbMiss ? '결과 미입력 ' + dbMiss + '건' : '완료 처리 기준'}</div></div>
    <div class="wt-fact clickable" onclick="drillRebuy(true)">
      <div class="l">재구매 도래</div><b class="${rebuyDue().length ? 'rd' : ''}">${rebuyDue().length}건</b>
      <div class="s">소모품 재구매 시점</div></div>`;

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
    return `<div class="funnel-row clk" onclick="drillDeals('${esc(s)} 단계 딜','진행 중인 딜',DRL.open('${esc(s)}'))">
      <div class="funnel-label">${esc(s)}</div>
      <div class="funnel-cnt">${ds.length ? ds.length + '건' : '-'}</div>
      <div class="funnel-bar-wrap"><div class="funnel-bar" style="width:${amt / maxA * 100}%;background:${stageOf(s).color}"></div></div>
      <div class="funnel-amt">${money(amt)}</div></div>`;
  }).join('');
  $('db-funnel-sum').innerHTML = `<div class="d-flex justify-content-between" style="font-size:12px">
    <span style="color:#64748b;font-weight:600">열린 딜 합계</span><strong>${won(openAmt)}</strong></div>`;

  /* 오래 머문 딜 — 카드 하단 공백을 채우면서, 파이프라인에서 실제로 봐야 할 것을 보여준다 */
  const stale = openD.slice()
    .map(d => ({ d, days: d.createdAt ? dayDiff(d.createdAt, today()) : null }))
    .filter(x => x.days != null)
    .sort((a, b) => b.days - a.days)
    .slice(0, 3);
  $('db-stale').innerHTML = stale.length
    ? '<div class="st-t">오래 머문 딜</div>'
      + stale.map(x =>
          '<div class="st-r" onclick="openDrawer(&#39;' + x.d.id + '&#39;)">'
          + '<span class="st-n">' + esc(custName(x.d.custId)) + '</span>'
          + '<span class="st-s">' + esc(x.d.stage) + '</span>'
          + '<span class="st-d">' + x.days + '일</span></div>').join('')
    : '<div class="st-t">오래 머문 딜</div><div class="st-e">진행 중인 딜이 없습니다</div>';

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
    acts.push({ kind: 'sch', id: s.id, date: s.date, cust: schCustLabel(s), text: s.title, rep: s.rep, type: s.type }));
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
  /* 소모품 재구매 도래 — 담당자 기억에만 의존하면 그대로 넘어간다 */
  rebuyDue().slice(0, 12).forEach(x => alerts.push({
    ic: 'bi-arrow-repeat', c: x.dleft < 0 ? '#dc2626' : '#0e7490', t: custName(x.custId),
    s: (x.name || x.code) + ' 재구매 ' + (x.dleft < 0 ? (-x.dleft) + '일 경과' : 'D-' + x.dleft)
       + ' · 평균 ' + money(x.avgAmt) + '원',
    go: `openCustDetail('${x.custId}')` }));
  /* 실주했지만 재도전 시점이 도래한 딜 — 놓치면 그대로 사라진다 */
  retryDueDeals().forEach(d => alerts.push({ ic: 'bi-arrow-repeat', c: '#0e7490', t: custName(d.custId),
    s: `재도전 시점 도래 (${fmtDate(d.retryDate)}) · ${esc(trimv(d.lostReason) || '실주')}`, go: `openDrawer('${d.id}')` }));
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
/* 딜의 장비/소모품 분류.
   제품이 삭제되면 prodByCode 가 비어 전부 '소모품' 으로 오분류되던 버그가 있어,
   저장 시 딜에 함께 기록한 d.cat 을 폴백으로 사용한다. */
function dealCat(d) {
  const p = prodByCode(d && d.productCode);
  const c = p ? p.cat : (d && d.cat);
  return c === '장비' ? '장비' : '소모품';
}
/* 코드만 아는 자리용 (제품이 살아있을 때만 정확) */
const CAT2 = code => ((prodByCode(code) || {}).cat === '장비' ? '장비' : '소모품');
const WON_DEALS = () => DB.deals.filter(d => d.stage === '계약완료');

function mSum(year, m, cat) {
  return WON_DEALS().reduce((t, d) => {
    const s = String(d.expectedDate || '');
    if (num(s.slice(0, 4)) !== year || num(s.slice(5, 7)) !== m) return t;
    if (cat && dealCat(d) !== cat) return t;
    return t + num(d.amount);
  }, 0);
}
function rSum(year, a, b, cat) { let t = 0; for (let m = a; m <= b; m++) t += mSum(year, m, cat); return t; }
function badgeYoy(cur, prev) {
  if (!prev) return '<span class="yoy na">비교 불가</span>';
  const r = (cur / prev - 1) * 100;
  return '<span class="yoy ' + (r >= 0 ? 'up' : 'dn') + '">' + (r >= 0 ? '▲' : '▼') + Math.abs(r).toFixed(1) + '%</span>';
}
/* 연도 목록 — 딜만 보면 다른 표에만 있는 연도가 조회에서 사라진다.
   현재 연도는 데이터가 없어도 항상 포함(연초에 선택 불가가 되는 것을 막는다). */
function dealYears() {
  const ys = new Set();
  const pick = (arr, f) => (arr || []).forEach(r => {
    const y = num(String(f(r) || '').slice(0, 4));
    if (y > 2000) ys.add(y);
  });
  pick(DB.deals, d => d.expectedDate);
  pick(DB.deals, d => d.closedAt);
  pick(DB.quotes, q => q.date);
  pick(DB.targets, t => t.ym);
  ys.add(new Date().getFullYear());
  return [...ys].sort((x, y) => y - x);
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
  const sel = $(pfx + '-year');
  /* select 에 없는 연도를 넣으면 value 가 조용히 첫 옵션으로 떨어진다.
     연말·연초에 엉뚱한 연도가 조회되는 경로라 명시적으로 잡는다. */
  let y = num(sel.value);
  if (!y || !dealYears().includes(y)) {
    y = new Date().getFullYear();
    if (sel.value !== String(y)) sel.value = y;
  }
  let a = num($(pfx + '-from').value) || 1, b = num($(pfx + '-to').value) || 12;
  if (a > b) { const t = a; a = b; b = t; }
  return [y, a, b];
}
const mw = v => Math.round(num(v) / 1e6);   /* 백만원 */

/* ═══════════════ 상세내역 조회 (드릴다운) ═══════════════
   화면의 숫자·막대·표 행을 누르면 그 숫자를 만든 원본 기록을 표로 보여준다.
   목록의 행을 다시 누르면 해당 기록의 편집 화면으로 들어간다. */
function openDrill(title, sub, html) {
  $('drill-title').textContent = title;
  $('drill-sub').innerHTML = sub || '';
  $('drill-body').innerHTML = html;
  new bootstrap.Modal($('drillModal')).show();
}
function closeDrill() { const m = bootstrap.Modal.getInstance($('drillModal')); if (m) m.hide(); }
function drillGo(fn) { closeDrill(); setTimeout(fn, 300); }
function drillEmpty(msg) {
  return '<div class="text-center" style="padding:36px;color:#94a3b8;font-size:13px">'
    + '<i class="bi bi-inbox" style="font-size:22px;color:#cbd5e1"></i><div class="mt-2">'
    + esc(msg || '해당 내역이 없습니다') + '</div></div>';
}
function drillTable(head, rows, footCells) {
  if (!rows.length) return drillEmpty();
  return '<div style="overflow-x:auto"><table class="table table-hover mb-0">'
    + '<thead><tr>' + head.map(h => '<th>' + esc(h) + '</th>').join('') + '</tr></thead>'
    + '<tbody>' + rows.join('') + '</tbody>'
    + (footCells ? '<tfoot><tr style="background:#fafbfc">' + footCells + '</tr></tfoot>' : '')
    + '</table></div>';
}

/* ── 딜(수주·매출) 목록 ── */
function drillDeals(title, sub, list) {
  list = (list || []).slice().sort((a, b) => String(b.expectedDate).localeCompare(String(a.expectedDate)));
  const tot = list.reduce((t, d) => t + num(d.amount), 0);
  const rows = list.map(d => {
    const cat = dealCat(d), cc = cat === '장비' ? '#16a34a' : '#0e7490';
    const st = stageOf(d.stage);
    return '<tr style="cursor:pointer" onclick="drillGo(function(){' +
      (d.stage === '계약완료' ? "openSaleModal('" + d.id + "')" : "openDrawer('" + d.id + "')") + '})">'
      + '<td>' + fmtDate(d.expectedDate) + '</td>'
      + '<td class="fw-bold">' + esc(custName(d.custId)) + '</td>'
      + '<td style="max-width:220px;overflow:hidden;text-overflow:ellipsis">' + esc(d.product) + '</td>'
      + '<td><span class="badge" style="background:' + cc + '1a;color:' + cc + '">' + esc(cat) + '</span></td>'
      + '<td><span class="badge" style="background:' + st.color + '1a;color:' + st.color + '">' + esc(d.stage) + '</span></td>'
      + '<td class="text-center">' + num(d.prob) + '%</td>'
      + '<td class="text-end fw-bold">' + comma(d.amount) + '</td>'
      + '<td>' + esc(d.rep || '-') + '</td></tr>';
  });
  const foot = '<td class="fw-bold">합계</td><td colspan="5">' + list.length + '건</td>'
    + '<td class="text-end fw-bold">' + comma(tot) + '</td><td></td>';
  openDrill(title, sub, drillTable(['일자','고객사','제품','분류','단계','확률','금액','담당'], rows, list.length ? foot : ''));
}
/* ── 고객사 목록 ── */
function drillCusts(title, sub, list) {
  const rows = (list || []).map(c => '<tr style="cursor:pointer" onclick="drillGo(function(){openCustDetail(\'' + c.id + '\')})">'
    + '<td class="fw-bold">' + esc(c.name) + '</td>'
    + '<td>' + esc(c.type || '-') + '</td>'
    + '<td class="text-center"><span class="grade-badge grade-' + esc(c.grade) + '">' + esc(c.grade) + '</span></td>'
    + '<td>' + esc(((c.sido || '') + ' ' + (c.gugun || '')).trim() || '-') + '</td>'
    + '<td>' + esc(c.rep || '-') + '</td>'
    + '<td class="text-end fw-bold">' + comma(custWonAmount(c.id)) + '</td>'
    + '<td class="text-center">' + DB.equipments.filter(e => e.custId === c.id).length + '</td></tr>');
  openDrill(title, sub, drillTable(['고객사','구분','등급','지역','담당','누적 수주','장비'], rows,
    rows.length ? '<td class="fw-bold">합계</td><td colspan="4">' + list.length + '곳</td><td class="text-end fw-bold">'
      + comma(list.reduce((t, c) => t + custWonAmount(c.id), 0)) + '</td><td></td>' : ''));
}
/* ── 일정 목록 ── */
function drillSch(title, sub, list) {
  list = (list || []).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const rows = list.map(x => '<tr style="cursor:pointer" onclick="drillGo(function(){openSchModal(\'' + x.id + '\')})">'
    + '<td>' + fmtDate(x.date) + '</td><td>' + esc(x.time || '-') + '</td>'
    + '<td><span class="sc-type" style="background:' + schCol(x.type) + '1a;color:' + schCol(x.type) + '">' + esc(x.type) + '</span></td>'
    + '<td class="fw-bold">' + esc(schCustLabel(x)) + '</td>'
    + '<td style="max-width:250px">' + esc(x.title) + '</td>'
    + '<td>' + esc(x.rep || '-') + '</td>'
    + '<td>' + (x.done ? '<span class="sc-type" style="background:#f0fdf4;color:#15803d">완료</span>'
        : (x.date < today() ? '<span class="sc-type" style="background:#fef2f2;color:#dc2626">놓침</span>'
        : '<span class="sc-type" style="background:#fff7ed;color:#ea580c">예정</span>')) + '</td>'
    + '<td style="font-size:11.5px;color:#64748b">' + esc(x.result || '') + '</td></tr>');
  openDrill(title, sub, drillTable(['일자','시간','유형','고객사','내용','담당','상태','결과'], rows));
}
/* ── 장비 목록 ── */
function drillEquip(title, sub, list) {
  const rows = (list || []).map(e => {
    const nd = dDays(e.warrantyEnd);
    return '<tr style="cursor:pointer" onclick="drillGo(function(){openEquipModal(\'' + e.id + '\')})">'
      + '<td class="fw-bold">' + esc(custName(e.custId)) + '</td>'
      + '<td style="max-width:210px;overflow:hidden;text-overflow:ellipsis">' + esc(e.model) + '</td>'
      + '<td>' + esc(e.serial || '-') + '</td><td>' + fmtDate(e.installDate) + '</td>'
      + '<td>' + fmtDate(e.warrantyEnd) + (nd == null ? '' : nd < 0 ? ' <span class="dc-flag od">만료</span>'
          : nd <= 90 ? ' <span class="dc-flag td">D-' + nd + '</span>' : '') + '</td>'
      + '<td>' + esc(e.status) + '</td><td>' + esc(e.contract || '-') + '</td>'
      + '<td>' + esc(e.rep || '-') + '</td>'
      + '<td class="text-center">' + (e.as || []).length + '</td></tr>';
  });
  openDrill(title, sub, drillTable(['고객사','모델','시리얼','설치일','보증만료','상태','계약','담당','A/S'], rows));
}
/* ── 상담일지 목록 ── */
function drillLogs(title, sub, list) {
  list = (list || []).slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const rows = list.map(l => '<tr style="cursor:pointer" onclick="drillGo(function(){openLogModal(\'' + l.id + '\')})">'
    + '<td>' + fmtDate(l.date) + '</td>'
    + '<td class="fw-bold">' + esc(logCustLabel(l)) + '</td>'
    + '<td><span class="badge" style="background:#f1f5f9;color:#475569">' + esc(l.type) + '</span></td>'
    + '<td style="max-width:330px;white-space:normal">' + esc(l.content) + '</td>'
    + '<td style="font-size:12px;color:#64748b">' + esc(l.interest || '-') + '</td>'
    + '<td>' + esc(l.rep || '-') + '</td></tr>');
  openDrill(title, sub, drillTable(['일자','고객사','유형','내용','관심제품','담당'], rows));
}
/* ── 견적서 목록 ── */
function drillQuotes(title, sub, list) {
  const rows = (list || []).map(q => {
    const c = quoteCalc(q.items);
    return '<tr style="cursor:pointer" onclick="drillGo(function(){openQuoteModal(\'' + q.id + '\')})">'
      + '<td class="fw-bold">' + esc(q.no) + '</td><td>' + esc(custName(q.custId)) + '</td>'
      + '<td>' + fmtDate(q.date) + '</td>'
      + '<td style="max-width:230px;overflow:hidden;text-overflow:ellipsis">' + esc((q.items || []).map(i => i.name).join(', ')) + '</td>'
      + '<td class="text-end fw-bold">' + comma(c.total) + '</td>'
      + '<td>' + esc(q.status) + '</td><td>' + esc(q.rep || '-') + '</td></tr>';
  });
  openDrill(title, sub, drillTable(['견적번호','고객사','견적일','품목','합계','상태','담당'], rows,
    rows.length ? '<td class="fw-bold">합계</td><td colspan="3">' + list.length + '건</td><td class="text-end fw-bold">'
      + comma(list.reduce((t, q) => t + quoteCalc(q.items).total, 0)) + '</td><td colspan="2"></td>' : ''));
}
/* ── 자주 쓰는 필터 조합 ── */
const DRL = {
  wonRange: function (y, a, b, cat) {
    const from = y + '-' + pad(a) + '-01', to = ymd(new Date(y, b, 0));
    return WON_DEALS().filter(d => inRange(d.expectedDate, from, to) && (!cat || dealCat(d) === cat));
  },
  wonMonth: function (y, m, cat) {
    return WON_DEALS().filter(d => String(d.expectedDate).slice(0, 7) === y + '-' + pad(m) && (!cat || dealCat(d) === cat));
  },
  open: function (stage) {
    return DB.deals.filter(d => OPEN_STAGES.includes(d.stage) && (!stage || d.stage === stage));
  }
};
const perLabel = function (y, a, b) { return y + '년 ' + a + '월~' + b + '월'; };
/* 영업분석 화면의 현재 조회기간 — 클릭 시점에 셀렉트를 다시 읽는다 */
function anaPeriod() {
  const y = num(($('ana-year') || {}).value) || new Date().getFullYear();
  const pt = ($('ana-period') || {}).value || 'year';
  const r = periodRange(y, pt);
  return { y: y, from: r[0], to: r[1] };
}
function anaWon() {
  const p = anaPeriod();
  return DB.deals.filter(d => d.stage === '계약완료' && inRange(d.expectedDate, p.from, p.to));
}
function anaOpen() { return DB.deals.filter(d => OPEN_STAGES.includes(d.stage)); }
function anaDesc() { return (($('ana-desc') || {}).textContent || ''); }

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
  DRL.ovY = y; DRL.ovA = a; DRL.ovB = b;

  /* 컬럼 하나 = 지표 하나. 그리드가 폭을 나눠 가지므로 죽은 공간이 생기지 않는다 */
  const col = (cls, lab, val, sub, go) => '<div class="ovc ' + cls + '" onclick="' + go + '">'
    + '<span class="ovc-l">' + lab + '</span>'
    + '<b class="ovc-v">' + val + '</b>'
    + '<span class="ovc-s">' + sub + '</span></div>';
  /* 전년 실적이 0이면 '전년 0 · 비교 불가' 로 두 번 말하게 되므로 한 문구로 줄인다 */
  const yoySub = (pre, v, pv) => pv ? pre + ' ' + money(pv) + ' ' + badgeYoy(v, pv)
    : pre + ' 기록 없음';
  const catCol = (lab, v, pv, cat) => col('', lab, money(v), yoySub('전년', v, pv),
    'drillMixCat(' + Q + esc(cat) + Q + ')');

  /* 예전에는 파이프라인 3항목을 밴드 아래 작은 한 줄로 눌러놨다.
     밴드 안쪽 여백은 크게 남는데 정작 선행지표는 안 읽혔으므로 같은 격으로 올린다. */
  const openGo = 'drillDeals(' + Q + '진행 파이프라인' + Q + ',' + Q + '계약완료·실주를 제외한 열린 딜'
    + Q + ',DB.deals.filter(function(d){return OPEN_STAGES.indexOf(d.stage)>=0}))';
  $('ov-kpi').innerHTML = '<div class="cdud" style="padding:18px 22px 20px;margin:0">'
    + '<div class="ov-band">'
      + col('hero', '당월 · ' + b + '월', money(moT),
          yoySub('전년 동월', moT, moPT), 'drillMixMonth()')
      + catCol('당월 장비', moD, moPD, '장비')
      + catCol('당월 소모품', moC, moPC, '소모품')
      + col('hero sep', '누계 · ' + y + '년 ' + a + '~' + b + '월', money(ytT),
          yoySub('전년 동기간', ytT, ypT), 'drillMixRange()')
      + catCol('누계 장비', ytD, ypD, '장비')
      + catCol('누계 소모품', ytC, ypC, '소모품')
    + '</div>'
    + '<div class="ov-band ov-band2">'
      + col('', '진행 파이프라인', money(openAmt), openD.length + '건 열림', openGo)
      + col('', '확률가중 예상', money(wgt), '단계 확률 반영', 'drillWgt()')
      + col('', '누계 대비 규모', (ytT ? Math.round(wgt / ytT * 100) : 0) + '%',
          '파이프라인 / 누계 수주', 'drillWgt()')
      + col('', '열린 딜 평균', money(openD.length ? openAmt / openD.length : 0),
          '딜 1건당 규모', openGo)
      + col('', '당월 비중', (ytT ? Math.round(moT / ytT * 100) : 0) + '%',
          '누계 중 당월분', 'drillMixMonth()')
      + col('', '전년 대비 누계', ypT ? ((ytT >= ypT ? '+' : '') + Math.round((ytT / ypT - 1) * 100) + '%') : '-',
          ypT ? '전년 동기간 ' + money(ypT) : '전년 기록 없음', 'drillMixRange()')
    + '</div></div>';

  /* 월별 차트 — 장비/소모품 누적 막대. 값은 막대 위에 직접 표시하므로 y축·격자를 없앤다 */
  const labels = Array.from({ length: 12 }, (_, i) => (i + 1) + '월');
  const dev = [], cons = [], prev = [];
  for (let m = 1; m <= 12; m++) { dev.push(mw(mSum(y, m, '장비'))); cons.push(mw(mSum(y, m, '소모품'))); prev.push(mw(mSum(y - 1, m))); }
  /* 작년 실적이 아예 없으면 0에 붙은 점선이 그려질 뿐이라 노이즈다 → 시리즈를 넣지 않는다 */
  const hasPrev = prev.some(v => v > 0);
  const dsets = [
    { type: 'bar', label: '장비', data: dev, backgroundColor: '#16a34a', stack: 's', borderRadius: 3,
      borderColor: '#fff', borderWidth: { top: 2, right: 0, bottom: 0, left: 0 } },
    { type: 'bar', label: '소모품', data: cons, backgroundColor: '#0e7490', stack: 's', borderRadius: 3,
      borderColor: '#fff', borderWidth: { top: 2, right: 0, bottom: 0, left: 0 } }
  ];
  if (hasPrev) dsets.push({ type: 'line', label: (y - 1) + '년 합계', data: prev, borderColor: '#94a3b8',
    borderDash: [5, 4], borderWidth: 2, pointRadius: 2, backgroundColor: '#94a3b8' });
  $('ov-chart-cap').textContent = '막대=장비·소모품'
    + (hasPrev ? ' · 점선=' + (y - 1) + '년 합계' : '') + ' · 단위 백만원';
  chart('ov-chart-monthly', {
    plugins: [BAR_TOTAL_LABELS],
    data: { labels, datasets: dsets },
    options: { responsive: true, maintainAspectRatio: false,
      layout: { padding: { top: 20 } },     // 막대 위 숫자가 잘리지 않도록
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } },
        tooltip: { callbacks: { label: c => c.dataset.label + ' ' + comma(c.parsed.y) + '백만원' } } },
      scales: { x: { stacked: true, ticks: { font: { size: 11 } }, grid: { display: false },
                     border: { color: '#e4e8ef' } },
        y: { stacked: true, beginAtZero: true, display: false, grid: { display: false } } } }
  });

  /* 월별 표 — 작년 행도 실적이 있을 때만 넣는다(전부 '-' 인 행은 읽을 게 없다) */
  const tableRows = [
    ['장비', m => mSum(y, m, '장비'), '#16a34a'],
    ['소모품', m => mSum(y, m, '소모품'), '#0e7490'],
    ['합계', m => mSum(y, m), '#182230']
  ];
  if (hasPrev) tableRows.push([(y - 1) + '년', m => mSum(y - 1, m), '#94a3b8']);
  const rowsHtml = tableRows.map(row => {
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
      if (dealCat(d) !== cat) return;
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
/* ══ 매출 직접 입력 ══
   수주 파이프라인을 거치지 않는 매출(소모품 재구매·단발 판매)을 바로 기록한다.
   내부적으로는 '계약완료' 딜로 저장되므로 종합·매출믹스·영업분석에 그대로 반영된다.
   src:'direct' 로 표시해 파이프라인에서 올라온 건과 구분한다. */
function openSaleModal(id) {
  refreshSelects();
  const d = id ? DB.deals.find(x => x.id === id) : null;
  $('sale-modal-title').innerHTML = '<i class="bi bi-cash-coin me-2" style="color:var(--blue)"></i>'
    + (d ? '매출 수정' : '매출 입력');
  $('sl-del-btn').style.display = d ? 'inline-block' : 'none';
  $('sl-id').value = d ? d.id : '';
  $('sl-date').value = d ? (d.expectedDate || today()) : today();
  $('sl-cust').value = d ? custName(d.custId) : '';
  $('sl-product').value = d ? (d.productCode || '') : '';
  $('sl-qty').value = d ? (d.qty || 1) : 1;
  $('sl-amount').value = d ? comma(d.amount) : '';
  $('sl-rep').value = d ? (d.rep || '') : ((ME && ME.display_name) || '');
  $('sl-memo').value = d ? (d.memo || '') : '';
  new bootstrap.Modal($('saleModal')).show();
}
function saleCalc() {
  const p = prodByCode($('sl-product').value);
  if (!p) return;
  $('sl-amount').value = comma(num(p.price) * Math.max(1, num($('sl-qty').value)));
}
function saveSale(keepOpen) {
  if (!trimv($('sl-cust').value)) return alert('고객사를 입력하거나 선택해주세요.');
  if (!$('sl-product').value) return alert('제품을 선택해주세요.');
  const amt = num($('sl-amount').value);
  if (!amt) return alert('금액을 입력해주세요.');
  const dt = $('sl-date').value || today();
  const custId = resolveCust($('sl-cust').value);
  const code = $('sl-product').value;
  const p = prodByCode(code);
  /* 모달에 없는 필드(nextAction 등)는 건드리지 않는다.
     수주 파이프라인에서 올라온 건을 여기서 수정해도 출처(src)와 후속 액션이 보존된다. */
  const row = {
    custId, productCode: code, product: p ? p.name : '',
    cat: p ? p.cat : '장비',
    qty: num($('sl-qty').value) || 1, amount: amt,
    stage: '계약완료', prob: 100, expectedDate: dt, closedAt: dt,
    rep: resolveRep($('sl-rep').value), memo: trimv($('sl-memo').value)
  };
  const id = $('sl-id').value;
  if (id) {
    const ex = DB.deals.find(x => x.id === id);
    const before = auditSnap(ex);
    Object.assign(ex, row);
    if (!ex.src) ex.src = 'pipeline';   // 출처 표기만 명시, direct 로 바꾸지 않음
    auditDiff('deals', id, before, ex, custName(ex.custId));
  } else {
    DB.deals.push(Object.assign({ id: uid(), createdAt: today(), nextAction: '', nextActionDate: '', src: 'direct' }, row));
  }
  save();
  if (keepOpen) {
    $('sl-id').value = ''; $('sl-del-btn').style.display = 'none';
    $('sl-product').value = ''; $('sl-amount').value = ''; $('sl-qty').value = 1; $('sl-memo').value = '';
    $('sale-modal-title').innerHTML = '<i class="bi bi-cash-coin me-2" style="color:var(--blue)"></i>매출 입력';
    $('sl-product').focus();
    toast('저장했습니다 — 이어서 입력하세요');
  } else {
    bootstrap.Modal.getInstance($('saleModal')).hide();
  }
  refreshDatalists();
  if (CUR_PAGE === 'mix') renderMix(); else if (RENDER[CUR_PAGE]) RENDER[CUR_PAGE]();
}
function deleteSale() {
  if (!ensureAdmin()) return;
  const id = $('sl-id').value;
  if (!id || !confirm('이 매출 건을 삭제할까요?')) return;
  DB.deals = DB.deals.filter(x => x.id !== id);
  save();
  bootstrap.Modal.getInstance($('saleModal')).hide();
  renderMix();
}
/* 기간 내 확정 매출 목록 */
function renderSaleList() {
  if (!$('sale-list')) return;
  const [y, a, b] = periodOf('mix');
  const from = y + '-' + pad(a) + '-01', to = ymd(new Date(y, b, 0));
  const q = trimv(($('sale-search') || {}).value).toLowerCase();
  const catF = MIX_CAT === 'all' ? null : MIX_CAT;
  let rows = WON_DEALS().filter(d => inRange(d.expectedDate, from, to) && (!catF || dealCat(d) === catF));
  if (q) rows = rows.filter(d => (custName(d.custId) + ' ' + d.product + ' ' + (d.rep || '')).toLowerCase().includes(q));
  rows.sort((x, z) => String(z.expectedDate).localeCompare(String(x.expectedDate)));
  const tot = rows.reduce((t, d) => t + num(d.amount), 0);
  $('sale-list').innerHTML = rows.length
    ? '<div style="overflow-x:auto"><table class="table table-hover mb-0">'
      + '<thead><tr><th>매출일</th><th>고객사</th><th>제품</th><th>분류</th><th class="text-center">수량</th>'
      + '<th class="text-end">금액</th><th>담당</th><th>구분</th><th></th></tr></thead><tbody>'
      + rows.map(d => {
          const cat = dealCat(d), cc = cat === '장비' ? '#16a34a' : '#0e7490';
          return '<tr><td>' + fmtDate(d.expectedDate) + '</td>'
            + '<td><a class="cust-link" onclick="openCustDetail(\'' + d.custId + '\')">' + esc(custName(d.custId)) + '</a></td>'
            + '<td style="max-width:230px;overflow:hidden;text-overflow:ellipsis">' + esc(d.product) + '</td>'
            + '<td><span class="badge" style="background:' + cc + '1a;color:' + cc + '">' + esc(cat) + '</span></td>'
            + '<td class="text-center">' + comma(d.qty || 1) + '</td>'
            + '<td class="text-end fw-bold">' + comma(d.amount) + '</td>'
            + '<td>' + esc(d.rep || '-') + '</td>'
            + '<td style="font-size:11px;color:#94a3b8">' + (d.src === 'direct' ? '직접 입력' : '수주 전환') + '</td>'
            + '<td class="text-end"><button class="btn btn-sm btn-outline-secondary" onclick="openSaleModal(\'' + d.id + '\')"><i class="bi bi-pencil"></i></button></td></tr>';
        }).join('')
      + '</tbody><tfoot><tr style="background:#fafbfc"><td class="fw-bold">합계</td><td colspan="4">' + rows.length + '건</td>'
      + '<td class="text-end fw-bold">' + comma(tot) + '</td><td colspan="3"></td></tr></tfoot></table></div>'
    : '<div class="table-empty">해당 기간 매출이 없습니다. <b>매출 입력</b>으로 추가하세요.</div>';
}

function renderMix() {
  const [y, a, b] = periodOf('mix');
  const from = y + '-' + pad(a) + '-01', to = ymd(new Date(y, b, 0));
  $('mix-desc').textContent = y + '년 ' + a + '월 ~ ' + b + '월' + (MIX_CAT === 'all' ? '' : ' · ' + MIX_CAT);
  const catF = MIX_CAT === 'all' ? null : MIX_CAT;

  const cur = rSum(y, a, b, catF), pv = rSum(y - 1, a, b, catF);
  const devA = rSum(y, a, b, '장비'), consA = rSum(y, a, b, '소모품');
  const cnt = WON_DEALS().filter(d => inRange(d.expectedDate, from, to) && (!catF || dealCat(d) === catF)).length;
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
    if (catF && dealCat(d) !== catF) return;
    const k = d.productCode || d.product;
    if (!acc[k]) acc[k] = { name: d.product, cat: dealCat(d), cnt: 0, amt: 0, custs: {} };
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
  renderSaleList();
}

/* ───────────────────────── 7. 수주관리 ───────────────────────── */
let PIPE_CHIP = 'all';
let SALES_TAB = 'pipeline';

/* 확률가중 예상 드릴다운 — 기여도(금액x확률) 큰 순 */
/* 유효기간이 지난 '발송' 견적 — 목록·밴드가 같은 기준을 쓰도록 함수로 둔다 */
function quoteExpired(q) {
  if (!q || q.status !== '발송' || !q.date) return false;
  const d = parseD(q.date);
  if (!d) return false;
  d.setDate(d.getDate() + num(q.validDays || 30));
  return ymd(d) < today();
}
function drillWgt() {
  const list = DB.deals.filter(d => OPEN_STAGES.indexOf(d.stage) >= 0);
  const tot = list.reduce((t, d) => t + num(d.amount) * num(d.prob) / 100, 0);
  const rows = list.slice()
    .sort((a, b) => (num(b.amount) * num(b.prob)) - (num(a.amount) * num(a.prob)))
    .map(d => {
      const st = stageOf(d.stage), w = num(d.amount) * num(d.prob) / 100;
      return '<tr style="cursor:pointer" onclick="drillGo(function(){openDrawer(&#39;' + d.id + '&#39;)})">'
        + '<td class="fw-bold">' + esc(custName(d.custId)) + '</td>'
        + '<td style="max-width:200px;overflow:hidden;text-overflow:ellipsis">' + esc(d.product) + '</td>'
        + '<td><span class="badge" style="background:' + st.color + '1a;color:' + st.color + '">' + esc(d.stage) + '</span></td>'
        + '<td class="text-center">' + num(d.prob) + '%</td>'
        + '<td class="text-end">' + comma(d.amount) + '</td>'
        + '<td class="text-end fw-bold">' + comma(Math.round(w)) + '</td>'
        + '<td>' + fmtDate(d.expectedDate) + '</td><td>' + esc(d.rep || '-') + '</td></tr>';
    });
  const foot = '<td class="fw-bold">합계</td><td colspan="4">' + list.length + '건</td>'
    + '<td class="text-end fw-bold">' + comma(Math.round(tot)) + '</td><td colspan="2"></td>';
  openDrill('확률가중 예상 ' + money(tot) + '원', '금액 x 단계확률 기여도 순',
    drillTable(['고객사','제품','단계','확률','딜 금액','가중 금액','예상일','담당'], rows, list.length ? foot : ''));
}

/* ── 실주 분해: 사유 / 담당자 / 경쟁사 ──
   건수는 왼쪽 열, 금액은 오른쪽 열로 각각 정렬(퍼널과 동일 규칙) */
function lostBreakdown(key, emptyLabel) {
  const lost = DB.deals.filter(d => d.stage === '실주');
  if (!lost.length) return '<div class="ana-empty">실주 딜이 없습니다</div>';
  const g = {};
  lost.forEach(d => {
    const k = trimv(d[key]) || emptyLabel;
    if (!g[k]) g[k] = { cnt: 0, amt: 0 };
    g[k].cnt++;
    g[k].amt += num(d.amount);
  });
  const rows = Object.entries(g).sort((a, b) => b[1].amt - a[1].amt);
  const maxA = Math.max(1, ...rows.map(r => r[1].amt));
  const totA = lost.reduce((t, d) => t + num(d.amount), 0);
  const unrec = lost.filter(d => !trimv(d.lostReason)).length;
  return '<div class="ana-sum">실주 <b>' + lost.length + '건</b> · <b>' + money(totA) + '원</b>'
      + (key === 'lostReason' && unrec ? ' <em>· 사유 미기록 ' + unrec + '건</em>' : '') + '</div>'
    + rows.map(([k, v]) =>
        '<div class="funnel-row clk" onclick="drillLostBy(&#39;' + jsq(key) + '&#39;,&#39;' + jsq(k)
          + '&#39;,&#39;' + jsq(emptyLabel) + '&#39;)">'
        + '<div class="funnel-label" style="width:108px">' + esc(k) + '</div>'
        + '<div class="funnel-cnt">' + v.cnt + '건</div>'
        + '<div class="funnel-bar-wrap"><div class="funnel-bar" style="width:'
          + (v.amt / maxA * 100) + '%;background:#dc2626"></div></div>'
        + '<div class="funnel-amt">' + money(v.amt) + '원</div></div>').join('');
}

/* 경쟁사별 승패 — 경쟁사는 실주 딜에만 기록되므로 패는 확정,
   승은 그 경쟁사와 맞붙은 고객사에서 우리가 계약완료한 건수로 추정한다 */
function compWinTable() {
  const lost = DB.deals.filter(d => d.stage === '실주' && trimv(d.competitor));
  if (!lost.length) return '<div class="ana-empty">경쟁사 기록이 없습니다'
    + '<span>실주 딜을 수정해 경쟁사를 입력하면 집계됩니다</span></div>';
  const g = {};
  lost.forEach(d => {
    const k = trimv(d.competitor);
    if (!g[k]) g[k] = { cnt: 0, amt: 0, gaps: [], custs: [] };
    g[k].cnt++;
    g[k].amt += num(d.amount);
    if (g[k].custs.indexOf(d.custId) < 0) g[k].custs.push(d.custId);
    if (num(d.lostPrice) && num(d.amount)) {
      g[k].gaps.push((num(d.lostPrice) - num(d.amount)) / num(d.amount) * 100);
    }
  });
  const rows = Object.entries(g).sort((a, b) => b[1].amt - a[1].amt).map(([k, v]) => {
    const wonAt = DB.deals.filter(d => d.stage === '계약완료' && v.custs.indexOf(d.custId) >= 0).length;
    const closed = wonAt + v.cnt;
    const wr = closed ? Math.round(wonAt / closed * 100) : 0;
    const gap = v.gaps.length ? Math.round(v.gaps.reduce((t, x) => t + x, 0) / v.gaps.length) : null;
    return '<tr style="cursor:pointer" onclick="drillLostBy(&#39;competitor&#39;,&#39;' + jsq(k)
        + '&#39;,&#39;미기록&#39;)">'
      + '<td class="fw-bold">' + esc(k) + '</td>'
      + '<td class="text-center fw-bold" style="color:#dc2626">' + v.cnt + '</td>'
      + '<td class="text-end">' + comma(v.amt) + '</td>'
      + '<td class="text-center">' + wonAt + '</td>'
      + '<td class="text-center fw-bold" style="color:' + (wr >= 50 ? '#15803d' : '#dc2626') + '">' + wr + '%</td>'
      + '<td class="text-end">' + (gap === null ? '-' : (gap > 0 ? '+' : '') + gap + '%') + '</td></tr>';
  });
  return '<div style="overflow-x:auto"><table class="table table-hover mb-0" style="font-size:12.5px">'
    + '<thead><tr><th>경쟁사</th><th class="text-center">패</th><th class="text-end">실주액</th>'
    + '<th class="text-center">승</th><th class="text-center">승률</th><th class="text-end">견적차</th></tr></thead>'
    + '<tbody>' + rows.join('') + '</tbody></table></div>'
    + '<div class="ana-note">승률은 해당 경쟁사와 맞붙은 고객사에서의 우리 계약완료 기준 추정치입니다. '
    + '견적차는 경쟁사가 우리보다 비쌌으면 +로 표시됩니다.</div>';
}

function drillLostBy(key, val, emptyLabel) {
  const list = DB.deals.filter(d => d.stage === '실주' && (trimv(d[key]) || emptyLabel) === val);
  const labels = { lostReason: '실주 사유', rep: '담당자', competitor: '경쟁사' };
  drillLostDetail((labels[key] || key) + ' · ' + val,
    list.length + '건 · ' + money(list.reduce((t, d) => t + num(d.amount), 0)) + '원', list);
}

/* 실주 전용 상세표 — 사유·경쟁사·경쟁 견적·재도전 시점까지 */
function drillLostDetail(title, sub, list) {
  list = (list || []).slice().sort((a, b) => String(b.expectedDate).localeCompare(String(a.expectedDate)));
  const rows = list.map(d =>
    '<tr style="cursor:pointer" onclick="drillGo(function(){openDrawer(&#39;' + d.id + '&#39;)})">'
    + '<td>' + fmtDate(d.expectedDate) + '</td>'
    + '<td class="fw-bold">' + esc(custName(d.custId)) + '</td>'
    + '<td style="max-width:170px;overflow:hidden;text-overflow:ellipsis">' + esc(d.product) + '</td>'
    + '<td class="text-end fw-bold">' + comma(d.amount) + '</td>'
    + '<td>' + esc(trimv(d.lostReason) || '-') + '</td>'
    + '<td>' + esc(trimv(d.competitor) || '-') + '</td>'
    + '<td class="text-end">' + (num(d.lostPrice) ? comma(d.lostPrice) : '-') + '</td>'
    + '<td>' + (d.retryDate ? fmtDate(d.retryDate) : '-') + '</td>'
    + '<td>' + esc(d.rep || '-') + '</td></tr>');
  const foot = '<td class="fw-bold">합계</td><td colspan="2">' + list.length + '건</td>'
    + '<td class="text-end fw-bold">' + comma(list.reduce((t, d) => t + num(d.amount), 0))
    + '</td><td colspan="5"></td>';
  openDrill(title, sub,
    drillTable(['예상일', '고객사', '제품', '딜 금액', '사유', '경쟁사', '경쟁 견적', '재도전', '담당'],
      rows, list.length ? foot : ''));
}

/* 재도전 시점이 도래한 실주 딜 — 알림/현황판에서 쓴다 */
function retryDueDeals() {
  const t = today();
  return DB.deals.filter(d => d.stage === '실주' && d.retryDate && d.retryDate <= t);
}

/* 종합 밴드용 드릴다운 — 조회기간(y/a/b)을 DRL 에 실어 클릭 시점에 다시 계산한다 */
function drillMixMonth() {
  const y = DRL.ovY, b = DRL.ovB;
  drillDeals(y + '년 ' + b + '월 수주', '계약완료 · 예상 수주일 기준', DRL.wonMonth(y, b));
}
function drillMixRange() {
  const y = DRL.ovY, a = DRL.ovA, b = DRL.ovB;
  drillDeals(y + '년 ' + a + '~' + b + '월 누계 수주', '계약완료 · 예상 수주일 기준', DRL.wonRange(y, a, b));
}
function drillMixCat(cat) {
  const y = DRL.ovY, a = DRL.ovA, b = DRL.ovB;
  drillDeals(y + '년 ' + a + '~' + b + '월 ' + cat + ' 수주', '분류 ' + cat + ' · 계약완료 기준',
    DRL.wonRange(y, a, b, cat));
}

/* ══════════════════════════════════════════════════════════════
   변경 이력 (감사 로그)
   여러 사람이 같은 딜의 금액·단계를 고치는데 지금까지는 누가 언제 무엇을
   얼마에서 얼마로 바꿨는지가 남지 않았다. 나중에 실적 다툼이 생기면
   되짚을 근거가 없으므로 추적 대상 필드만 골라 전/후를 기록한다.
   ══════════════════════════════════════════════════════════════ */

/* 추적 대상 — 다 남기면 노이즈가 되므로 돈과 진행에 직접 영향 있는 것만 */
const AUDIT_FIELDS = {
  amount:      { l: '금액',     fmt: v => comma(v) + '원' },
  stage:       { l: '단계',     fmt: v => String(v || '-') },
  qty:         { l: '수량',     fmt: v => num(v) + '개' },
  expectedDate:{ l: '예상 수주일', fmt: v => v ? fmtDate(v) : '-' },
  rep:         { l: '담당자',   fmt: v => String(v || '-') },
  product:     { l: '제품',     fmt: v => String(v || '-') },
  lostReason:  { l: '실주 사유', fmt: v => String(v || '-') },
  competitor:  { l: '경쟁사',   fmt: v => String(v || '-') }
};
const AUDIT_KEEP = 400;   // 무한히 쌓이면 동기화가 무거워진다

/* before(변경 전 스냅샷) 와 after 를 비교해 달라진 항목만 기록 */
function auditDiff(coll, id, before, after, label) {
  if (!before) return;
  const chg = [];
  Object.keys(AUDIT_FIELDS).forEach(f => {
    const a = before[f], b = after[f];
    /* 숫자 필드는 문자/숫자 표기차로 오탐이 나므로 숫자로 비교 */
    const same = (f === 'amount' || f === 'qty') ? num(a) === num(b) : trimv(a) === trimv(b);
    if (!same) chg.push({ f: f, from: a == null ? '' : a, to: b == null ? '' : b });
  });
  if (!chg.length) return;
  if (!DB.audits) DB.audits = [];
  DB.audits.push({
    id: uid(), coll: coll, refId: id, label: label || '',
    at: nowStamp(), by: curUserName() || '(로컬)', chg: chg
  });
  if (DB.audits.length > AUDIT_KEEP) DB.audits = DB.audits.slice(-AUDIT_KEEP);
}
/* 변경 전 스냅샷 — 추적 필드만 복사하면 되므로 깊은 복사가 필요 없다 */
function auditSnap(o) {
  if (!o) return null;
  const r = {};
  Object.keys(AUDIT_FIELDS).forEach(f => { r[f] = o[f]; });
  return r;
}
function nowStamp() {
  const d = new Date();
  return ymd(d) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
const auditsOf = (coll, id) => (DB.audits || [])
  .filter(x => x.coll === coll && x.refId === id)
  .sort((a, b) => String(b.at).localeCompare(String(a.at)));

/* 이력 렌더 — 딜 상세 패널과 드릴다운에서 같은 모양으로 쓴다 */
function auditHtml(coll, id, emptyMsg) {
  const list = auditsOf(coll, id);
  if (!list.length) return '<div class="au-empty">' + esc(emptyMsg || '변경 이력이 없습니다') + '</div>';
  return '<div class="au-list">' + list.map(a =>
    '<div class="au-i"><div class="au-h"><em>' + esc(a.at) + '</em><span>' + esc(a.by) + '</span></div>'
    + a.chg.map(c => {
        const def = AUDIT_FIELDS[c.f] || { l: c.f, fmt: v => String(v) };
        const up = (c.f === 'amount' || c.f === 'qty') && num(c.to) > num(c.from);
        const dn = (c.f === 'amount' || c.f === 'qty') && num(c.to) < num(c.from);
        return '<div class="au-c"><b>' + esc(def.l) + '</b>'
          + '<s>' + esc(def.fmt(c.from)) + '</s>'
          + '<i class="bi bi-arrow-right"></i>'
          + '<u class="' + (up ? 'up' : dn ? 'dn' : '') + '">' + esc(def.fmt(c.to)) + '</u></div>';
      }).join('')
    + '</div>').join('') + '</div>';
}

/* 최근 금액 변경 전체 — 임원이 "누가 숫자를 만졌나" 를 한 번에 보는 용도 */
function drillAudits() {
  const list = (DB.audits || []).slice()
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .filter(a => a.chg.some(c => c.f === 'amount' || c.f === 'stage'));
  const rows = list.slice(0, 200).map(a => {
    const d = a.coll === 'deals' ? DB.deals.find(x => x.id === a.refId) : null;
    const cells = a.chg.filter(c => c.f === 'amount' || c.f === 'stage').map(c => {
      const def = AUDIT_FIELDS[c.f];
      return def.l + ' ' + def.fmt(c.from) + ' → ' + def.fmt(c.to);
    }).join(' / ');
    return '<tr' + (d ? ' style="cursor:pointer" onclick="drillGo(function(){openDrawer(&#39;' + d.id + '&#39;)})"' : '') + '>'
      + '<td>' + esc(a.at) + '</td>'
      + '<td class="fw-bold">' + esc(a.by) + '</td>'
      + '<td>' + esc(a.label || (d ? custName(d.custId) : '(삭제됨)')) + '</td>'
      + '<td>' + esc(cells) + '</td></tr>';
  });
  openDrill('금액 · 단계 변경 이력', list.length + '건 (최근 200건 표시)',
    drillTable(['시각', '변경자', '대상', '변경 내용'], rows, ''));
}

/* ══════════════════════════════════════════════════════════════
   목표 대비 실적
   실적 숫자만 있으면 "잘한 건지" 판단이 안 된다. 목표와 월중 페이스를 붙인다.
   targets 행: { id, ym:'2026-07', rep:'김성호'|'', amount }
   rep 이 빈 문자열이면 전사 합계 목표.
   ══════════════════════════════════════════════════════════════ */

const targetOf = (ym, rep) => (DB.targets || [])
  .filter(t => t.ym === ym && trimv(t.rep) === trimv(rep))
  .reduce((s2, t) => s2 + num(t.amount), 0);

/* 기간(a~b월) 목표 합계. 담당자별 목표가 하나도 없으면 전사 목표로 대체한다 */
function targetSum(y, a, b, rep) {
  let t = 0;
  for (let m = a; m <= b; m++) t += targetOf(y + '-' + pad(m), rep || '');
  return t;
}
function hasRepTargets(y) {
  return (DB.targets || []).some(t => String(t.ym).slice(0, 4) == y && trimv(t.rep));
}

/* 월중 페이스 — 기간이 얼마나 지났는지. 오늘이 기간 밖이면 0% 또는 100% */
function periodProgress(a, b) {
  const t = today();
  if (t < a) return 0;
  if (t > b) return 1;
  const total = dayDiff(a, b) + 1;
  const done = dayDiff(a, t) + 1;
  return total > 0 ? done / total : 1;
}
function dayDiff(a, b) {
  return Math.round((parseD(b) - parseD(a)) / 86400000);
}

/* 달성률 바 한 줄 */
function targetRow(label, act, tgt, prog, go) {
  const rate = tgt ? Math.round(act / tgt * 100) : null;
  /* 기간이 60% 지났는데 달성 40% 면 뒤처진 것 — 진행률과 비교해야 의미가 있다 */
  const pace = tgt ? Math.round(prog * 100) : null;
  const behind = rate != null && pace != null && rate < pace - 5;
  const ahead = rate != null && pace != null && rate > pace + 5;
  const cls = rate == null ? 'na' : behind ? 'dn' : ahead ? 'up' : 'ok';
  return '<div class="tg-row' + (go ? ' clk' : '') + '"' + (go ? ' onclick="' + go + '"' : '') + '>'
    + '<div class="tg-l">' + esc(label) + '</div>'
    + '<div class="tg-bar"><div class="tg-fill ' + cls + '" style="width:'
      + (rate == null ? 0 : Math.min(100, rate)) + '%"></div>'
      + (pace == null ? '' : '<div class="tg-pace" style="left:' + Math.min(100, pace) + '%"></div>') + '</div>'
    + '<div class="tg-r ' + cls + '">' + (rate == null ? '목표 미설정' : rate + '%') + '</div>'
    + '<div class="tg-v">' + money(act) + (tgt ? ' / ' + money(tgt) : '') + '</div></div>';
}

/* a, b 는 renderAnalysis 가 넘기는 '2026-01-01' 형태의 날짜 문자열이다.
   목표는 월 단위로 저장되므로 월 번호로 바꿔 쓴다.
   (예전엔 날짜 문자열을 그대로 월로 써서 목표가 하나도 매칭되지 않았다) */
function renderTargetTab(y, a, b, wonD) {
  const mA = num(String(a).slice(5, 7)) || 1;
  const mB = num(String(b).slice(5, 7)) || 12;
  const prog = periodProgress(a, b);
  const useRep = hasRepTargets(y);
  const totTgt = useRep
    ? [...new Set((DB.targets || []).filter(t => String(t.ym).slice(0, 4) == y).map(t => trimv(t.rep)).filter(Boolean))]
        .reduce((s2, r) => s2 + targetSum(y, mA, mB, r), 0)
    : targetSum(y, mA, mB, '');
  const totAct = wonD.reduce((t, d) => t + num(d.amount), 0);
  const rate = totTgt ? Math.round(totAct / totTgt * 100) : null;
  const paceP = Math.round(prog * 100);
  /* 지금 속도로 기간 끝까지 가면 얼마에 착지하는지 */
  const landing = prog > 0 ? totAct / prog : 0;

  const reps = [...new Set([...repNames(), ...wonD.map(d => d.rep).filter(Boolean)])]
    .map(r => ({ r, act: wonD.filter(d => d.rep === r).reduce((t, d) => t + num(d.amount), 0), tgt: targetSum(y, mA, mB, r) }))
    .filter(x => x.act || x.tgt)
    .sort((x, z) => (z.tgt ? z.act / z.tgt : -1) - (x.tgt ? x.act / x.tgt : -1));

  const months = [];
  for (let m = mA; m <= mB; m++) {
    const ym = y + '-' + pad(m);
    const act = wonD.filter(d => String(d.expectedDate).slice(0, 7) === ym).reduce((t, d) => t + num(d.amount), 0);
    const tgt = useRep
      ? [...new Set((DB.targets || []).filter(t => t.ym === ym).map(t => trimv(t.rep)).filter(Boolean))]
          .reduce((s2, r) => s2 + targetOf(ym, r), 0)
      : targetOf(ym, '');
    months.push({ m, ym, act, tgt });
  }

  const noTarget = !totTgt;
  return '<div class="cdud mb-3" style="padding:20px 24px">'
      + '<div class="ov-band">'
        + '<div class="ovc hero"><span class="ovc-l">기간 실적</span><b class="ovc-v">' + money(totAct) + '</b>'
          + '<span class="ovc-s">' + wonD.length + '건 · 계약완료 기준</span></div>'
        + '<div class="ovc"><span class="ovc-l">기간 목표</span><b class="ovc-v">'
          + (totTgt ? money(totTgt) : '-') + '</b><span class="ovc-s">'
          + (useRep ? '담당자 목표 합계' : '전사 목표') + '</span></div>'
        + '<div class="ovc"><span class="ovc-l">달성률</span><b class="ovc-v" style="color:'
          + (rate == null ? '#94a3b8' : rate >= paceP ? '#15803d' : '#dc2626') + '">'
          + (rate == null ? '-' : rate + '%') + '</b>'
          + '<span class="ovc-s">기간 진행 ' + paceP + '%</span></div>'
        + '<div class="ovc hero sep"><span class="ovc-l">현재 속도 착지 예상</span><b class="ovc-v">'
          + (prog > 0 ? money(landing) : '-') + '</b><span class="ovc-s">'
          + (totTgt && prog > 0 ? '목표 대비 ' + Math.round(landing / totTgt * 100) + '%' : '기간 진행률 기준 환산')
          + '</span></div>'
        + '<div class="ovc"><span class="ovc-l">남은 필요액</span><b class="ovc-v" style="color:'
          + (totTgt && totAct < totTgt ? '#dc2626' : '#15803d') + '">'
          + (totTgt ? money(Math.max(0, totTgt - totAct)) : '-') + '</b>'
          + '<span class="ovc-s">' + (totTgt ? (totAct >= totTgt ? '목표 달성' : '목표까지') : '목표 미설정') + '</span></div>'
        + '<div class="ovc"><span class="ovc-l">일 평균 필요액</span><b class="ovc-v">'
          + (totTgt && today() <= b ? money(Math.max(0, totTgt - totAct) / Math.max(1, dayDiff(today(), b) + 1)) : '-')
          + '</b><span class="ovc-s">'
          + (today() <= b ? '남은 ' + Math.max(0, dayDiff(today(), b) + 1) + '일' : '기간 종료') + '</span></div>'
      + '</div></div>'
    + (noTarget ? '<div class="tg-warn"><i class="bi bi-exclamation-circle me-2"></i>'
        + y + '년 목표가 설정되지 않았습니다. 오른쪽 위 <b>목표 설정</b>에서 입력하면 달성률과 착지 예상이 계산됩니다.</div>' : '')
    + '<div class="row g-3">'
      + '<div class="col-lg-6"><div class="card p-3 h-100"><div class="wt-st">담당자별 달성률'
        + '<u style="text-decoration:none;font-size:11.5px;font-weight:600;color:#94a3b8;margin-left:6px">'
        + '세로선 = 기간 진행률 ' + paceP + '%</u></div>'
        + (reps.length ? reps.map(x => targetRow(x.r, x.act, x.tgt, prog,
            'drillDeals(' + Q + jsq(x.r) + ' 수주' + Q + ',' + Q + '기간 내 계약완료' + Q
            + ',DB.deals.filter(function(d){return d.stage===' + Q + '계약완료' + Q + '&&d.rep===' + Q + jsq(x.r) + Q
            + '&&inRange(d.expectedDate,DRL.anaA,DRL.anaB)}))')).join('')
          : '<div class="ana-empty">담당자 실적·목표가 없습니다</div>')
      + '</div></div>'
      + '<div class="col-lg-6"><div class="card p-3 h-100"><div class="wt-st">월별 달성률</div>'
        + months.map(x => targetRow(x.m + '월', x.act, x.tgt, x.ym < today().slice(0, 7) ? 1 : x.ym > today().slice(0, 7) ? 0 : prog,
            'drillDeals(' + Q + x.ym + ' 수주' + Q + ',' + Q + '계약완료 기준' + Q
            + ',DRL.wonMonth(' + y + ',' + x.m + '))')).join('')
      + '</div></div>'
    + '</div>';
}

/* ── 목표 입력 모달 ── */
function openTargetModal() {
  if (!ensureAdmin()) return;
  const ySel = $('tg-year');
  const years = [...new Set([new Date().getFullYear(), new Date().getFullYear() + 1, ...dealYears()])].sort((x, z) => z - x);
  fillSelect(ySel, years.map(v => ({ v: v, l: v + '년' })));
  ySel.value = num($('ana-year').value) || new Date().getFullYear();
  renderTargetForm();
  new bootstrap.Modal($('targetModal')).show();
}
function renderTargetForm() {
  const y = num($('tg-year').value);
  const scope = $('tg-scope').value;
  const rows = scope === 'rep' ? repNames() : [''];
  $('tg-sub').textContent = y + '년 · ' + (scope === 'rep' ? '담당자별 월 목표' : '전사 월 목표') + ' (만원)';
  const head = '<tr><th style="min-width:92px">' + (scope === 'rep' ? '담당자' : '구분') + '</th>'
    + Array.from({ length: 12 }, (_, i) => '<th class="text-center">' + (i + 1) + '</th>').join('')
    + '<th class="text-end">연간</th></tr>';
  const body = rows.map((r, ri) => {
    const cells = Array.from({ length: 12 }, (_, i) => {
      const v = targetOf(y + '-' + pad(i + 1), r);
      return '<td><input type="text" class="tg-in" inputmode="numeric" data-rep="' + esc(r) + '" data-m="' + (i + 1) + '"'
        + ' value="' + (v ? Math.round(v / 10000) : '') + '" oninput="tgSum()"></td>';
    }).join('');
    return '<tr><td class="fw-bold">' + esc(r || '전사') + '</td>' + cells
      + '<td class="text-end fw-bold tg-tot" id="tgtot' + ri + '">0</td></tr>';
  }).join('');
  $('tg-form').innerHTML = '<div style="overflow-x:auto"><table class="table table-sm tg-t mb-0">'
    + '<thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>';
  tgSum();
}
function tgSum() {
  const trs = $('tg-form').querySelectorAll('tbody tr');
  trs.forEach((tr, ri) => {
    let t = 0;
    tr.querySelectorAll('.tg-in').forEach(i => { t += num(i.value); });
    const cell = $('tgtot' + ri);
    if (cell) cell.textContent = comma(t);
  });
}
/* 연간 총액을 12개월로 균등 배분 — 매달 같은 숫자를 12번 타이핑하지 않게 */
function spreadTarget() {
  const v = prompt('연간 목표액을 만원 단위로 입력하면 12개월로 균등 배분합니다.' + NL
    + '(담당자별 단위라면 담당자 1명당 금액입니다)');
  if (v == null) return;
  const yearAmt = num(v);
  if (!yearAmt) return;
  const per = Math.round(yearAmt / 12);
  $('tg-form').querySelectorAll('.tg-in').forEach(i => { i.value = per; });
  tgSum();
  toast('월 ' + comma(per) + '만원으로 배분했습니다');
}
function saveTargets() {
  if (!ensureAdmin()) return;
  const y = num($('tg-year').value);
  const scope = $('tg-scope').value;
  const inputs = [...$('tg-form').querySelectorAll('.tg-in')];
  /* 이 연도 + 이 단위(담당자별/전사)에 해당하는 기존 목표만 지우고 다시 넣는다.
     다른 단위의 목표를 같이 날리면 안 된다. */
  const isTotal = scope === 'total';
  DB.targets = (DB.targets || []).filter(t =>
    !(String(t.ym).slice(0, 4) == y && (isTotal ? !trimv(t.rep) : !!trimv(t.rep))));
  let cnt = 0;
  inputs.forEach(i => {
    const amt = num(i.value) * 10000;      // 화면은 만원 단위
    if (!amt) return;
    DB.targets.push({ id: uid(), ym: y + '-' + pad(num(i.dataset.m)), rep: i.dataset.rep || '', amount: amt });
    cnt++;
  });
  save();
  bootstrap.Modal.getInstance($('targetModal')).hide();
  if (CUR_PAGE === 'analysis') renderAnalysis();
  toast(y + '년 목표 ' + cnt + '개월분 저장');
}

/* ══════════════════════════════════════════════════════════════
   활동량 (선행지표)
   지금 분석은 전부 결과(매출)다. 매출이 나오기 전에 관리하려면
   방문·데모·신규접촉 같은 활동량을 봐야 한다.
   ══════════════════════════════════════════════════════════════ */
function renderActivityTab(y, a, b, wonD) {
  const sch = DB.schedules.filter(x => inRange(x.date, a, b));
  const logs = DB.logs.filter(x => inRange(x.date, a, b));
  const doneSch = sch.filter(x => x.done);
  const reps = salesRepNames();

  const stats = reps.map(r => {
    const ms = sch.filter(x => x.rep === r);
    const md = ms.filter(x => x.done);
    const ml = logs.filter(x => x.rep === r);
    const visit = md.filter(x => x.type === '방문').length;
    const demo = md.filter(x => x.type === '데모/시연').length;
    const tel = md.filter(x => x.type === '전화').length;
    /* 이 담당자가 기간 중 처음 접촉한 고객사 = 이전 이력이 전혀 없는 곳 */
    const newCust = [...new Set(ml.map(x => x.custId).filter(Boolean))]
      .filter(cid => !DB.logs.some(l => l.custId === cid && l.date < a)).length;
    const won = wonD.filter(d => d.rep === r);
    /* 데모를 몇 건 하면 1건 계약되는가 */
    const demoConv = demo ? Math.round(won.length / demo * 100) : null;
    return { r, plan: ms.length, done: md.length, visit, demo, tel, logs: ml.length, newCust,
      wonCnt: won.length, demoConv,
      doneRate: ms.length ? Math.round(md.length / ms.length * 100) : null };
  }).filter(x => x.plan || x.logs).sort((x, z) => z.done - x.done);

  const totDone = doneSch.length, totPlan = sch.length;
  const demoAll = doneSch.filter(x => x.type === '데모/시연').length;
  const newAll = [...new Set(logs.map(x => x.custId).filter(Boolean))]
    .filter(cid => !DB.logs.some(l => l.custId === cid && l.date < a)).length;
  const missed = sch.filter(x => !x.done && x.date < today()).length;

  const goSch = function (type, label) {
    return 'drillSch(' + Q + label + Q + ',' + Q + '기간 내 완료 처리된 일정' + Q
      + ',DB.schedules.filter(function(x){return x.done&&inRange(x.date,DRL.anaA,DRL.anaB)'
      + (type ? '&&x.type===' + Q + type + Q : '') + '}))';
  };

  return '<div class="cdud mb-3" style="padding:20px 24px">'
      + '<div class="ov-band">'
        + '<div class="ovc hero" onclick="' + goSch('', '완료 활동 전체') + '">'
          + '<span class="ovc-l">완료 활동</span><b class="ovc-v">' + totDone + '건</b>'
          + '<span class="ovc-s">계획 ' + totPlan + '건 중 '
          + (totPlan ? Math.round(totDone / totPlan * 100) : 0) + '%</span></div>'
        + '<div class="ovc" onclick="' + goSch('방문', '방문 활동') + '"><span class="ovc-l">방문</span>'
          + '<b class="ovc-v">' + doneSch.filter(x => x.type === '방문').length + '건</b>'
          + '<span class="ovc-s">현장 접촉</span></div>'
        + '<div class="ovc" onclick="' + goSch('데모/시연', '데모 · 시연') + '"><span class="ovc-l">데모 · 시연</span>'
          + '<b class="ovc-v">' + demoAll + '건</b><span class="ovc-s">'
          + (demoAll ? '계약 ' + wonD.length + '건 / 전환 ' + Math.round(wonD.length / demoAll * 100) + '%' : '수주 직전 지표') + '</span></div>'
        + '<div class="ovc hero sep"><span class="ovc-l">상담일지</span><b class="ovc-v">' + logs.length + '건</b>'
          + '<span class="ovc-s">기록으로 남은 접촉</span></div>'
        + '<div class="ovc"><span class="ovc-l">신규 접촉 고객사</span><b class="ovc-v">' + newAll + '곳</b>'
          + '<span class="ovc-s">기간 전 이력 없음</span></div>'
        + '<div class="ovc"><span class="ovc-l">결과 미입력</span>'
          + '<b class="ovc-v" style="color:' + (missed ? '#dc2626' : '#15803d') + '">' + missed + '건</b>'
          + '<span class="ovc-s">지난 일정 중 미완료</span></div>'
      + '</div></div>'
    + '<div class="ana-note mb-2">활동량은 <b>결과가 나오기 전</b>에 관리할 수 있는 유일한 지표입니다. '
      + '완료율이 낮거나 결과 미입력이 쌓이면 실적이 나오기 전에 먼저 드러납니다.</div>'
    + tbl(['담당자', '계획', '완료', '완료율', '방문', '전화', '데모', '상담일지', '신규 접촉', '수주', '데모→수주'],
        stats.map(x => '<td class="fw-bold">' + esc(x.r) + '</td>'
          + '<td class="text-center">' + x.plan + '</td>'
          + '<td class="text-center fw-bold">' + x.done + '</td>'
          + '<td class="text-center' + (x.doneRate != null && x.doneRate < 60 ? ' text-danger fw-bold' : '') + '">'
            + (x.doneRate == null ? '-' : x.doneRate + '%') + '</td>'
          + '<td class="text-center">' + x.visit + '</td>'
          + '<td class="text-center">' + x.tel + '</td>'
          + '<td class="text-center">' + x.demo + '</td>'
          + '<td class="text-center">' + x.logs + '</td>'
          + '<td class="text-center">' + x.newCust + '</td>'
          + '<td class="text-center">' + x.wonCnt + '</td>'
          + '<td class="text-center' + (x.demoConv != null && x.demoConv >= 50 ? ' text-success fw-bold' : '') + '">'
            + (x.demoConv == null ? '-' : x.demoConv + '%') + '</td>'),
        '기간 내 활동 기록이 없습니다');
}

/* ══════════════════════════════════════════════════════════════
   소모품 재구매 도래 예측
   장비 설치 정보와 소모품 매출이 각각 있는데 연결이 없었다.
   파이버·카트리지는 시술량에 비례해 반복 구매되므로, 고객사별
   마지막 구매일 + 평균 재구매 주기로 도래 시점을 추정한다.
   ══════════════════════════════════════════════════════════════ */

const REBUY_DEFAULT_DAYS = 90;    // 이력이 1건뿐이라 주기를 못 구할 때 쓰는 기본값
const REBUY_SOON_DAYS = 21;       // 도래 임박으로 볼 여유일

/* 고객사 x 제품 단위로 구매 이력을 모아 다음 구매일을 추정 */
function rebuyForecast() {
  const cons = WON_DEALS()
    .filter(d => dealCat(d) === '소모품' && d.custId && (d.expectedDate || d.closedAt))
    .map(d => ({
      custId: d.custId,
      code: d.productCode || d.product || '',
      name: d.product || '',
      date: d.closedAt || d.expectedDate,
      amount: num(d.amount),
      qty: num(d.qty) || 1
    }))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));

  const g = {};
  cons.forEach(x => {
    const k = x.custId + '||' + x.code;
    if (!g[k]) g[k] = { custId: x.custId, code: x.code, name: x.name, buys: [] };
    g[k].buys.push(x);
    g[k].name = x.name || g[k].name;
  });

  const t = today();
  return Object.values(g).map(row => {
    const buys = row.buys;
    const last = buys[buys.length - 1];
    /* 구매 간격 평균 — 2건 이상일 때만 실제 주기를 알 수 있다 */
    const gaps = [];
    for (let i = 1; i < buys.length; i++) {
      const gp = dayDiff(buys[i - 1].date, buys[i].date);
      if (gp > 0) gaps.push(gp);
    }
    const cycle = gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : REBUY_DEFAULT_DAYS;
    const estimated = !gaps.length;      // 주기를 추정값으로 썼는지
    const due = ymd(new Date(parseD(last.date).getTime() + cycle * 86400000));
    const dleft = dayDiff(t, due);       // 음수면 이미 지났다
    const avgAmt = Math.round(buys.reduce((a, b) => a + b.amount, 0) / buys.length);
    /* 이 고객사가 장비를 갖고 있는지 — 장비 없이 소모품만 사는 곳과 구분 */
    const hasEquip = DB.equipments.some(e => e.custId === row.custId);
    return { custId: row.custId, code: row.code, name: row.name, cnt: buys.length,
      lastDate: last.date, cycle: cycle, estimated: estimated, due: due, dleft: dleft,
      avgAmt: avgAmt, totAmt: buys.reduce((a, b) => a + b.amount, 0), hasEquip: hasEquip };
  }).sort((a, b) => a.dleft - b.dleft);
}
/* 도래했거나 임박한 것만 */
const rebuyDue = () => rebuyForecast().filter(x => x.dleft <= REBUY_SOON_DAYS);

function rebuyBadge(x) {
  if (x.dleft < 0) return '<span class="rb-b over">' + (-x.dleft) + '일 경과</span>';
  if (x.dleft === 0) return '<span class="rb-b over">오늘</span>';
  if (x.dleft <= REBUY_SOON_DAYS) return '<span class="rb-b soon">D-' + x.dleft + '</span>';
  return '<span class="rb-b ok">D-' + x.dleft + '</span>';
}

function drillRebuy(onlyDue) {
  const list = onlyDue ? rebuyDue() : rebuyForecast();
  const rows = list.map(x =>
    '<tr style="cursor:pointer" onclick="drillGo(function(){openCustDetail(&#39;' + x.custId + '&#39;)})">'
    + '<td>' + rebuyBadge(x) + '</td>'
    + '<td class="fw-bold">' + esc(custName(x.custId))
      + (x.hasEquip ? '' : ' <span class="rb-noeq">장비 없음</span>') + '</td>'
    + '<td style="max-width:200px;overflow:hidden;text-overflow:ellipsis">' + esc(x.name || x.code) + '</td>'
    + '<td class="text-center">' + x.cnt + '회</td>'
    + '<td>' + fmtDate(x.lastDate) + '</td>'
    + '<td class="text-center">' + x.cycle + '일'
      + (x.estimated ? '<span class="rb-est">추정</span>' : '') + '</td>'
    + '<td class="fw-bold">' + fmtDate(x.due) + '</td>'
    + '<td class="text-end">' + comma(x.avgAmt) + '</td></tr>');
  const foot = '<td class="fw-bold">합계</td><td colspan="6">' + list.length + '건</td>'
    + '<td class="text-end fw-bold">' + comma(list.reduce((t, x) => t + x.avgAmt, 0)) + '</td>';
  openDrill(onlyDue ? '재구매 도래 · 임박' : '소모품 재구매 예측 전체',
    (onlyDue ? '이미 지났거나 ' + REBUY_SOON_DAYS + '일 내 도래' : '고객사 x 제품별 다음 구매 시점 추정')
      + ' · 주기가 1회 구매뿐이면 기본 ' + REBUY_DEFAULT_DAYS + '일로 추정합니다',
    drillTable(['상태', '고객사', '제품', '구매', '마지막 구매', '평균 주기', '다음 예상', '평균 금액'],
      rows, list.length ? foot : ''));
}

/* ══════════════════════════════════════════════════════════════
   엑셀 가져오기
   여태 내보내기만 있어서 기존 고객사·장비 대장을 옮기려면 전부 수타였다.
   헤더 이름으로 열을 찾으므로 열 순서가 달라도 되고, 커밋 전에
   신규/중복/오류를 먼저 보여준다.
   ══════════════════════════════════════════════════════════════ */

const IMPORT_SPECS = {
  customers: {
    label: '고객사',
    key: '고객사명',
    cols: [
      { f: 'name',   h: ['고객사명', '병원명', '거래처명', '이름'], req: true },
      { f: 'type',   h: ['구분', '병원구분', '유형'] },
      { f: 'doctor', h: ['원장', '원장명', '원장/담당', '대표자'] },
      { f: 'dept',   h: ['진료과', '과'] },
      { f: 'grade',  h: ['등급'] },
      { f: 'sido',   h: ['시도', '지역', '광역'] },
      { f: 'gugun',  h: ['구군', '시군구'] },
      { f: 'rep',    h: ['담당영업', '담당자', '영업담당'] },
      { f: 'phone',  h: ['전화', '대표전화', '연락처'] },
      { f: 'zip',    h: ['우편번호'] },
      { f: 'addr',   h: ['주소'] },
      { f: 'addr2',  h: ['상세주소'] },
      { f: 'tags',   h: ['태그'], list: true },
      { f: 'memo',   h: ['메모', '비고'] }
    ]
  },
  products: {
    label: '제품',
    key: '제품코드',
    cols: [
      { f: 'code',  h: ['제품코드', '코드'], req: true },
      { f: 'name',  h: ['제품명', '품명', '이름'], req: true },
      { f: 'cat',   h: ['분류', '구분'] },
      { f: 'price', h: ['단가', '가격', '판매가'], money: true },
      { f: 'maker', h: ['제조사', '메이커'] },
      { f: 'memo',  h: ['메모', '비고'] }
    ]
  },
  equipments: {
    label: '장비',
    key: '시리얼',
    cols: [
      { f: 'custName',    h: ['고객사명', '병원명', '설치처'], req: true },
      { f: 'model',       h: ['모델', '모델명', '장비명'], req: true },
      { f: 'serial',      h: ['시리얼', '시리얼번호', 'S/N'], req: true },
      { f: 'installDate', h: ['설치일', '납품일'], date: true },
      { f: 'warrantyEnd', h: ['보증만료', '보증종료일', '보증만료일'], date: true },
      { f: 'status',      h: ['상태'] },
      { f: 'memo',        h: ['메모', '비고'] }
    ]
  }
};

let IM_ROWS = null;     // 파싱·검증 결과

function openImportModal(kind) {
  if (!ensureAdmin()) return;
  IM_ROWS = null;
  $('im-kind').value = kind || 'customers';
  $('im-file').value = '';
  $('im-preview').innerHTML = '';
  $('im-foot').textContent = '';
  $('im-go').disabled = true;
  imKindChange();
  new bootstrap.Modal($('importModal')).show();
}

function imKindChange() {
  const spec = IMPORT_SPECS[$('im-kind').value];
  IM_ROWS = null;
  $('im-preview').innerHTML = '';
  $('im-go').disabled = true;
  $('im-sub').textContent = spec.label + ' 대장을 한 번에 등록합니다 · 중복 기준: ' + spec.key;
  $('im-guide').innerHTML = '<b>인식하는 열 이름</b>'
    + '<div class="im-cols">' + spec.cols.map(c =>
        '<span class="im-col' + (c.req ? ' req' : '') + '">' + esc(c.h[0])
        + (c.req ? ' *' : '')
        + (c.h.length > 1 ? '<u>' + esc(c.h.slice(1).join(' / ')) + '</u>' : '') + '</span>').join('')
    + '</div>'
    + '<div class="im-note">첫 행이 헤더여야 합니다. 열 <b>순서는 상관없고</b>, 위 이름 중 아무거나 쓰면 인식합니다. '
    + '* 표시는 필수입니다. 인식하지 못한 열은 무시됩니다.</div>';
}

/* 양식 파일 — 어떤 열이 필요한지 말로 설명하는 것보다 빈 양식을 주는 게 빠르다 */
function imTemplate() {
  const kind = $('im-kind').value, spec = IMPORT_SPECS[kind];
  const head = {};
  spec.cols.forEach(c => { head[c.h[0] + (c.req ? '*' : '')] = ''; });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([head]), spec.label);
  XLSX.writeFile(wb, 'urolink-' + kind + '-양식.xlsx');
}

function imRead(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const rd = new FileReader();
  rd.onload = e => {
    try {
      const wb = XLSX.read(e.target.result, { type: 'array', cellDates: true });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
      imParse(raw);
    } catch (err) {
      IM_ROWS = null;
      $('im-preview').innerHTML = '<div class="im-err">파일을 읽지 못했습니다: ' + esc(err.message) + '</div>';
      $('im-go').disabled = true;
    }
  };
  rd.onerror = () => { $('im-preview').innerHTML = '<div class="im-err">파일을 읽지 못했습니다.</div>'; };
  rd.readAsArrayBuffer(file);
}

/* 헤더 이름 정규화 — 공백·괄호·별표를 무시해 '고객사명 *' 도 인식 */
const imNorm = h => String(h == null ? '' : h).replace(/[\s()*]/g, '').toLowerCase();

function imParse(raw) {
  const kind = $('im-kind').value, spec = IMPORT_SPECS[kind];
  IM_ROWS = null;                 // 이전 파일 결과를 확실히 버린다
  if (!raw.length) {
    $('im-preview').innerHTML = '<div class="im-err">데이터 행이 없습니다.</div>';
    $('im-go').disabled = true;
    return;
  }
  /* 실제 헤더 → 필드 매핑 */
  const heads = Object.keys(raw[0]);
  const map = {};
  spec.cols.forEach(c => {
    const want = c.h.map(imNorm);
    const hit = heads.find(h => want.indexOf(imNorm(h)) >= 0);
    if (hit) map[c.f] = hit;
  });
  const missing = spec.cols.filter(c => c.req && !map[c.f]);
  if (missing.length) {
    $('im-preview').innerHTML = '<div class="im-err">필수 열을 찾지 못했습니다: <b>'
      + missing.map(c => esc(c.h[0])).join(', ') + '</b><br>'
      + '<span>파일의 첫 행: ' + esc(heads.join(' | ')) + '</span></div>';
    $('im-go').disabled = true;
    return;
  }

  const seen = {};
  IM_ROWS = raw.map((r, i) => {
    const o = { _row: i + 2, _st: 'new', _msg: '' };
    spec.cols.forEach(c => {
      if (!map[c.f]) return;
      let v = trimv(r[map[c.f]]);
      if (c.money) v = num(String(v).replace(/[^0-9.-]/g, ''));
      else if (c.date) v = imDate(v);
      else if (c.list) v = v ? v.split(/[,;/]/).map(x => x.trim()).filter(Boolean) : [];
      o[c.f] = v;
    });
    /* 검증 */
    const miss = spec.cols.filter(c => c.req && !(c.list ? o[c.f].length : trimv(o[c.f])));
    if (miss.length) { o._st = 'err'; o._msg = miss.map(c => c.h[0]).join(', ') + ' 없음'; return o; }

    if (kind === 'customers') {
      const dup = DB.customers.find(x => normName(x.name) === normName(o.name));
      if (dup) { o._st = 'dup'; o._msg = '기존 [' + dup.name + '] 과 동일 — 빈 항목만 채웁니다'; o._id = dup.id; }
      if (o.grade && ['A', 'B', 'C', 'D'].indexOf(String(o.grade).toUpperCase()) < 0) {
        o.grade = 'C'; o._msg = (o._msg ? o._msg + ' · ' : '') + '등급 인식 불가 → C';
      }
    } else if (kind === 'products') {
      const dup = DB.products.find(x => trimv(x.code) === trimv(o.code));
      if (dup) { o._st = 'dup'; o._msg = '기존 코드 — 값을 갱신합니다'; }
      if (o.cat !== '장비' && o.cat !== '소모품') {
        o.cat = '소모품'; o._msg = (o._msg ? o._msg + ' · ' : '') + '분류 인식 불가 → 소모품';
      }
    } else {
      const dup = DB.equipments.find(x => trimv(x.serial) && trimv(x.serial) === trimv(o.serial));
      if (dup) { o._st = 'dup'; o._msg = '기존 시리얼 — 값을 갱신합니다'; o._id = dup.id; }
      const c = findCust(o.custName);
      o._newCust = !c;
      if (!c) o._msg = (o._msg ? o._msg + ' · ' : '') + '고객사 [' + o.custName + '] 신규 등록됨';
      if (!o.status) o.status = '정상';
    }
    /* 파일 안에서의 중복 */
    const k = kind === 'products' ? trimv(o.code)
            : kind === 'equipments' ? trimv(o.serial) : normName(o.name);
    if (k && seen[k]) { o._st = 'err'; o._msg = '파일 내 ' + seen[k] + '행과 중복'; }
    else if (k) seen[k] = o._row;
    return o;
  });
  imPreview();
}

/* 엑셀 날짜는 문자열·Date·시리얼번호가 섞여 들어온다 */
function imDate(v) {
  if (!v) return '';
  if (v instanceof Date && !isNaN(v)) return ymd(v);
  const t = String(v).trim();
  let m = t.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
  if (m) return m[1] + '-' + pad(+m[2]) + '-' + pad(+m[3]);
  m = t.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  /* 엑셀 시리얼 (1900-01-01 기준) */
  if (/^\d{5}$/.test(t)) {
    const d = new Date(Date.UTC(1899, 11, 30) + num(t) * 86400000);
    return isNaN(d) ? '' : ymd(d);
  }
  return '';
}

function imPreview() {
  const kind = $('im-kind').value, spec = IMPORT_SPECS[kind];
  const rows = IM_ROWS || [];
  const nNew = rows.filter(r => r._st === 'new').length;
  const nDup = rows.filter(r => r._st === 'dup').length;
  const nErr = rows.filter(r => r._st === 'err').length;
  const show = spec.cols.filter(c => !c.list).slice(0, 6);
  const badge = { new: '<span class="im-b new">신규</span>', dup: '<span class="im-b dup">중복</span>',
                  err: '<span class="im-b err">오류</span>' };
  $('im-preview').innerHTML = '<div class="im-stat">'
      + '<span class="s-new">신규 ' + nNew + '</span>'
      + '<span class="s-dup">중복 ' + nDup + '</span>'
      + '<span class="s-err">오류 ' + nErr + '</span>'
      + '<u>총 ' + rows.length + '행</u></div>'
    + '<div style="overflow-x:auto;max-height:420px"><table class="table table-sm im-t mb-0">'
    + '<thead><tr><th>행</th><th>상태</th>'
    + show.map(c => '<th>' + esc(c.h[0]) + '</th>').join('')
    + '<th>비고</th></tr></thead><tbody>'
    + rows.map(r => '<tr class="' + r._st + '"><td>' + r._row + '</td><td>' + badge[r._st] + '</td>'
        + show.map(c => '<td>' + esc(c.money ? comma(r[c.f]) : (r[c.f] || '-')) + '</td>').join('')
        + '<td class="im-msg">' + esc(r._msg || '') + '</td></tr>').join('')
    + '</tbody></table></div>';
  $('im-foot').textContent = nErr
    ? '오류 ' + nErr + '행은 건너뜁니다. 나머지 ' + (nNew + nDup) + '행을 가져옵니다.'
    : (nNew + nDup) + '행을 가져옵니다.';
  $('im-go').disabled = !(nNew + nDup);
}

function imCommit() {
  if (!ensureAdmin()) return;
  const kind = $('im-kind').value, spec = IMPORT_SPECS[kind];
  const rows = (IM_ROWS || []).filter(r => r._st !== 'err');
  if (!rows.length) return alert('가져올 행이 없습니다. 파일을 다시 선택해주세요.');
  if (!confirm(spec.label + ' ' + rows.length + '행을 가져옵니다.' + NL
    + '중복 행은 기존 데이터를 갱신합니다. 계속할까요?')) return;

  let added = 0, updated = 0, newCusts = 0;
  rows.forEach(r => {
    if (kind === 'customers') {
      if (r._st === 'dup') {
        const c = custById(r._id);
        if (!c) return;
        /* 중복은 덮어쓰지 않는다 — 화면에 안내한 대로 빈 항목만 채운다 */
        spec.cols.forEach(col => {
          if (col.f === 'tags') { c.tags = [...new Set([...(c.tags || []), ...(r.tags || [])])]; return; }
          if (!trimv(c[col.f]) && trimv(r[col.f])) c[col.f] = r[col.f];
        });
        c.updatedAt = today(); c.updatedBy = curUserName();
        updated++;
      } else {
        DB.customers.push({ id: uid(), name: r.name, type: r.type || '의원', doctor: r.doctor || '',
          dept: r.dept || '비뇨의학과', grade: (r.grade || 'C').toUpperCase(), sido: r.sido || '',
          gugun: r.gugun || '', rep: r.rep || '', phone: r.phone || '', zip: r.zip || '',
          addr: r.addr || '', addr2: r.addr2 || '', tags: r.tags || [], memo: r.memo || '',
          contacts: [], createdAt: today(), imported: true });
        added++;
      }
    } else if (kind === 'products') {
      const ex = DB.products.find(x => trimv(x.code) === trimv(r.code));
      if (ex) {
        Object.assign(ex, { name: r.name, cat: r.cat, price: num(r.price), maker: r.maker || ex.maker || '',
          memo: r.memo || ex.memo || '' });
        updated++;
      } else {
        DB.products.push({ code: r.code, name: r.name, cat: r.cat, price: num(r.price),
          maker: r.maker || '', memo: r.memo || '', createdAt: today(), imported: true });
        added++;
      }
    } else {
      /* 장비는 고객사가 있어야 붙는다. 없으면 만들어 준다(안내는 미리보기에 표시했다) */
      let c = findCust(r.custName);
      if (!c) {
        c = { id: uid(), name: r.custName, type: '의원', doctor: '', dept: '비뇨의학과', grade: 'C',
              sido: '', gugun: '', rep: '', phone: '', addr: '', tags: [], memo: '',
              contacts: [], createdAt: today(), imported: true };
        DB.customers.push(c);
        newCusts++;
      }
      const row = { custId: c.id, model: r.model, serial: r.serial, installDate: r.installDate || '',
        warrantyEnd: r.warrantyEnd || '', status: r.status || '정상', memo: r.memo || '' };
      if (r._st === 'dup' && r._id) {
        const ex = DB.equipments.find(x => x.id === r._id);
        if (ex) { Object.assign(ex, row); updated++; }
      } else {
        DB.equipments.push(Object.assign({ id: uid(), as: [], createdAt: today(), imported: true }, row));
        added++;
      }
    }
  });
  save();
  refreshDatalists();
  bootstrap.Modal.getInstance($('importModal')).hide();
  if (RENDER[CUR_PAGE]) RENDER[CUR_PAGE]();
  toast(spec.label + ' 가져오기 완료 — 신규 ' + added + ' · 갱신 ' + updated
    + (newCusts ? ' · 고객사 신규 ' + newCusts : ''));
}

/* 누적 막대 위에 스택 합계를 직접 얹는 플러그인.
   y축 격자와 눈금을 없애는 대신 값을 막대에 붙여 읽게 한다.
   값이 0인 달은 라벨을 붙이지 않는다(0이 12개 늘어서면 그게 더 시끄럽다). */
const BAR_TOTAL_LABELS = {
  id: 'barTotalLabels',
  afterDatasetsDraw(c) {
    const ctx = c.ctx;
    const labels = (c.data.labels || []);
    for (let i = 0; i < labels.length; i++) {
      let total = 0, topY = null, x = null;
      c.data.datasets.forEach((ds, di) => {
        if (ds.type === 'line') return;              // 비교용 선은 합계에 넣지 않는다
        const meta = c.getDatasetMeta(di);
        if (meta.hidden) return;                     // 범례로 끈 시리즈는 제외
        const el = meta.data && meta.data[i];
        if (!el) return;
        const v = num(ds.data[i]);
        total += v;
        if (v > 0 && (topY === null || el.y < topY)) { topY = el.y; x = el.x; }
      });
      if (!total || topY === null) continue;
      ctx.save();
      ctx.font = '800 10.5px "Noto Sans KR", sans-serif';
      ctx.fillStyle = '#182230';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(comma(Math.round(total)), x, topY - 5);
      ctx.restore();
    }
  }
};

function renderSales() {
  const openD = DB.deals.filter(d => OPEN_STAGES.includes(d.stage));
  const y = new Date().getFullYear();
  const wonY = DB.deals.filter(d => d.stage === '계약완료' && String(d.expectedDate).slice(0, 4) == y);
  const lostY = DB.deals.filter(d => d.stage === '실주' && String(d.expectedDate).slice(0, 4) == y);
  const openAmt = openD.reduce((t, d) => t + num(d.amount), 0);
  const wgt = openD.reduce((t, d) => t + num(d.amount) * num(d.prob) / 100, 0);
  const wonAmt = wonY.reduce((t, d) => t + num(d.amount), 0);
  const closed = wonY.length + lostY.length;
  const winRate = closed ? Math.round(wonY.length / closed * 100) : 0;
  const thisMonth = today().slice(0, 7);
  const dueThis = openD.filter(d => String(d.expectedDate).slice(0, 7) === thisMonth);
  /* 딜 등록부터 계약완료까지 걸린 일수 평균 — 파이프라인 속도 */
  const cyc = DB.deals.filter(d => d.stage === '계약완료' && d.createdAt && d.closedAt)
    .map(d => dayDiff(d.createdAt, d.closedAt)).filter(v => v >= 0);
  const cycleDays = cyc.length ? Math.round(cyc.reduce((a, b) => a + b, 0) / cyc.length) : null;
  /* 카드 4장으로 나누면 카드마다 여백이 크게 남는다 → 다른 페이지와 같은 문서형 밴드로 통일 */
  $('sales-kpi').innerHTML = '<div class="col-12"><div class="wt-band mb-0">'
    + '<div class="wt-hero clickable" onclick="drillDeals(' + Q + '열린 딜 ' + openD.length + '건' + Q + ','
      + Q + '계약완료·실주를 제외한 진행 중 딜 전체' + Q + ', DB.deals.filter(function(d){return OPEN_STAGES.indexOf(d.stage)>=0}))">'
      + '<div class="l">열린 딜</div><b>' + money(openAmt) + '원</b>'
      + '<div class="s">' + openD.length + '건 · 평균 ' + money(openD.length ? openAmt / openD.length : 0) + '원</div></div>'
    + '<div class="wt-fact clickable" onclick="drillWgt()">'
      + '<div class="l">확률가중 예상</div><b>' + money(wgt) + '원</b>'
      + '<div class="s">단계 확률 반영 · ' + (openAmt ? Math.round(wgt / openAmt * 100) : 0) + '%</div></div>'
    + '<div class="wt-fact clickable" onclick="drillDeals(' + Q + y + ' 수주' + Q + ','
      + Q + y + '년 계약완료 딜' + Q + ', DB.deals.filter(function(d){return d.stage===' + Q + '계약완료' + Q
      + ' && String(d.expectedDate).slice(0,4)==' + Q + y + Q + '}))">'
      + '<div class="l">' + y + ' 수주</div><b class="gr">' + money(wonAmt) + '원</b>'
      + '<div class="s">' + wonY.length + '건</div></div>'
    + '<div class="wt-fact clickable" onclick="drillDeals(' + Q + y + ' 실주 ' + lostY.length + '건' + Q + ','
      + Q + '성공률 ' + winRate + '% · 종결 ' + closed + '건 기준' + Q + ', DB.deals.filter(function(d){return d.stage===' + Q + '실주' + Q
      + ' && String(d.expectedDate).slice(0,4)==' + Q + y + Q + '}))">'
      + '<div class="l">수주 성공률</div>'
      + '<b class="' + (winRate >= 50 ? 'gr' : winRate < 30 ? 'rd' : '') + '">' + winRate + '%</b>'
      + '<div class="s">종결 ' + closed + '건 중 실주 ' + lostY.length + '건</div></div>'
    /* 아래 두 지표는 남는 폭을 채우기도 하지만, 파이프라인을 '언제·얼마나 빨리' 관점으로 읽게 한다 */
    + '<div class="wt-fact clickable" onclick="drillDeals(' + Q + '이번달 마감 예정' + Q + ','
      + Q + '예상 수주일이 이번달인 열린 딜' + Q + ', DB.deals.filter(function(d){return OPEN_STAGES.indexOf(d.stage)>=0'
      + ' && String(d.expectedDate).slice(0,7)===' + Q + thisMonth + Q + '}))">'
      + '<div class="l">이번달 마감 예정</div>'
      + '<b class="' + (dueThis.length ? '' : 'rd') + '">' + dueThis.length + '건</b>'
      + '<div class="s">' + money(dueThis.reduce(function (t, d) { return t + num(d.amount); }, 0)) + '원</div></div>'
    + '<div class="wt-fact clickable" onclick="drillDeals(' + Q + '체결 완료 딜' + Q + ','
      + Q + '등록일부터 종결일까지 평균 ' + (cycleDays == null ? '-' : cycleDays + '일') + Q
      + ', DB.deals.filter(function(d){return d.stage===' + Q + '계약완료' + Q + ' && d.createdAt && d.closedAt}))">'
      + '<div class="l">평균 체결 소요</div>'
      + '<b>' + (cycleDays == null ? '-' : cycleDays + '일') + '</b>'
      + '<div class="s">' + (cycleDays == null ? '등록·종결일 기록 부족' : '딜 등록 → 계약완료') + '</div></div>'
    + '</div></div>';
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
  /* 실주 칸으로 끌어다 놓으면 사유 입력을 먼저 받는다 */
  if (stage === '실주' && !trimv(d.lostReason)) {
    openDealModal(d.id);
    $('d-stage').value = '실주';
    dealStageChange();
    return;
  }
  const before = auditSnap(d);
  d.stage = stage; d.prob = stageOf(stage).prob;
  if (stage === '계약완료') d.closedAt = today();
  auditDiff('deals', d.id, before, d, custName(d.custId));
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
      <div class="wt-st mt-3">변경 이력 (${auditsOf('deals', d.id).length})</div>
      ${auditHtml('deals', d.id, '변경 이력이 없습니다 — 이후 금액·단계 수정이 여기에 남습니다')}
      <div class="wt-st mt-3">최근 상담 (${logs.length})</div>
      ${logs.length ? logs.map(l => `<div style="padding:8px 0;border-bottom:1px solid #f3f4f6">
        <div style="font-size:11.5px;color:#94a3b8">${fmtDate(l.date)} · ${esc(l.type)} · ${esc(l.rep || '')}</div>
        <div style="font-size:12.5px;margin-top:2px">${esc(l.content)}</div></div>`).join('')
        : '<div style="color:#94a3b8;font-size:12.5px;padding:8px 0">상담 이력이 없습니다</div>'}
    </div>
    <div class="dw-foot">
      ${isAdmin() ? `<button class="btn btn-outline-danger btn-sm me-auto" onclick="if(deleteDealById('${d.id}'))closeDrawer()"><i class="bi bi-trash me-1"></i>삭제</button>` : ''}
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
  /* 실주로 바꿀 때는 사유를 받아야 한다 — 칩으로 넘기면 사유 없는 실주가 쌓인다 */
  if (s === '실주' && !trimv(d.lostReason)) {
    closeDrawer();
    setTimeout(() => { openDealModal(d.id); $('d-stage').value = '실주'; dealStageChange(); }, 260);
    return;
  }
  const before = auditSnap(d);
  d.stage = s; d.prob = stageOf(s).prob;
  if (s === '계약완료' || s === '실주') d.closedAt = today();
  auditDiff('deals', d.id, before, d, custName(d.custId));
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
  $('d-product').value = d ? (d.productCode || '') : '';
  $('d-qty').value = d ? (d.qty || 1) : 1;
  $('d-amount').value = d ? comma(d.amount) : '';
  $('d-stage').value = d ? d.stage : '상담중';
  $('d-prob').value = d ? num(d.prob) : 25;
  $('d-rep').value = d ? (d.rep || '') : '';
  $('d-expected').value = d ? (d.expectedDate || '') : '';
  $('d-next').value = d ? (d.nextAction || '') : '';
  $('d-next-date').value = d ? (d.nextActionDate || '') : '';
  $('d-memo').value = d ? (d.memo || '') : '';
  $('d-lost-reason').value = d ? (d.lostReason || '') : '';
  $('d-competitor').value = d ? (d.competitor || '') : '';
  $('d-lost-price').value = d && num(d.lostPrice) ? comma(d.lostPrice) : '';
  $('d-retry-date').value = d ? (d.retryDate || '') : '';
  $('d-lost-memo').value = d ? (d.lostMemo || '') : '';
  toggleLostBox();
  new bootstrap.Modal($('dealModal')).show();
}
function dealProdChange() { dealCalc(); }
function dealCalc() {
  const p = prodByCode($('d-product').value);
  if (!p) return;
  $('d-amount').value = comma(num(p.price) * Math.max(1, num($('d-qty').value)));
}
function dealStageChange() {
  $('d-prob').value = stageOf($('d-stage').value).prob;
  toggleLostBox();
}
function toggleLostBox() {
  const on = $('d-stage').value === '실주';
  $('d-lost-wrap').style.display = on ? 'block' : 'none';
}
function saveDeal() {
  if (!trimv($('d-cust').value)) return alert('고객사를 입력하거나 선택해주세요.');
  if (!$('d-product').value) return alert('제품을 선택해주세요.');
  const amt = num($('d-amount').value);
  if (!amt) return alert('금액을 입력해주세요.');
  const isLost = $('d-stage').value === '실주';
  if (isLost && !trimv($('d-lost-reason').value)) {
    $('d-lost-wrap').style.display = 'block';
    $('d-lost-reason').focus();
    return alert('실주 사유를 선택해주세요. 사유가 없으면 실주 분석을 할 수 없습니다.');
  }
  const custId = resolveCust($('d-cust').value);
  const code = $('d-product').value;
  const p = prodByCode(code);
  const id = $('d-id').value;
  const row = {
    custId, productCode: code, product: p ? p.name : code, cat: p ? p.cat : '장비',
    qty: num($('d-qty').value) || 1, amount: amt,
    stage: $('d-stage').value, prob: num($('d-prob').value), rep: resolveRep($('d-rep').value),
    expectedDate: $('d-expected').value, nextAction: $('d-next').value.trim(),
    nextActionDate: $('d-next-date').value, memo: $('d-memo').value.trim(),
    /* 실주가 아니면 이전 실주 기록을 남겨두지 않는다(단계 되돌림 시 유령 데이터 방지) */
    lostReason: isLost ? trimv($('d-lost-reason').value) : '',
    competitor: isLost ? trimv($('d-competitor').value) : '',
    lostPrice: isLost ? num($('d-lost-price').value) : 0,
    retryDate: isLost ? $('d-retry-date').value : '',
    lostMemo: isLost ? trimv($('d-lost-memo').value) : ''
  };
  if (id) {
    const d = DB.deals.find(x => x.id === id);
    const before = auditSnap(d);
    Object.assign(d, row);
    if ((row.stage === '계약완료' || row.stage === '실주') && !d.closedAt) d.closedAt = today();
    auditDiff('deals', id, before, d, custName(d.custId));
  } else {
    DB.deals.push(Object.assign({ id: uid(), createdAt: today(), closedAt: '' }, row));
  }
  save();
  bootstrap.Modal.getInstance($('dealModal')).hide();
  renderSales(); if (CUR_PAGE === 'overview') renderOverview();
}
function deleteDeal() {
  const id = $('d-id').value;
  if (!id) return;
  if (!deleteDealById(id)) return;
  bootstrap.Modal.getInstance($('dealModal')).hide();
}
/* 상세 패널(드로어)에서도 삭제할 수 있어야 한다 — 수정 모달을 거치지 않고 바로 */
function deleteDealById(id) {
  if (!ensureAdmin()) return false;
  const d = DB.deals.find(x => x.id === id);
  if (!d) return false;
  if (!confirm('[' + custName(d.custId) + ' · ' + (d.product || '') + ' · ' + comma(d.amount) + '원] 딜을 삭제할까요?'
    /* 계약완료 딜은 매출로 집계되므로 삭제하면 실적 수치가 함께 내려간다 */
    + (d.stage === '계약완료' ? NL + '⚠ 계약완료 딜입니다. 삭제하면 매출 집계에서도 빠집니다.' : '')
    + NL + '되돌릴 수 없습니다.')) return false;
  DB.deals = DB.deals.filter(x => x.id !== id);
  save();
  renderSales();
  if (CUR_PAGE === 'overview') renderOverview();
  if (CUR_PAGE === 'dashboard') renderDashboard();
  toast('딜을 삭제했습니다');
  return true;
}

/* ── 상담일지 ── */
/* 상담일지의 고객사 칸 표시 — 고객사 상담은 custId, 타겟병원 상담은 prospectId 를 쓴다 */
function logCustLabel(l) {
  if (l.custId) return custName(l.custId);
  if (l.prospectId) { const p = prospectById(l.prospectId); return p ? p.name + ' (타겟병원)' : '(삭제된 타겟병원)'; }
  return '-';
}
function renderLogs() {
  const q = ($('log-search').value || '').trim().toLowerCase();
  const rows = DB.logs.filter(l => !q || (logCustLabel(l) + ' ' + l.content + ' ' + (l.rep || '') + ' ' + (l.type || '')).toLowerCase().includes(q))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  $('log-tbody').innerHTML = rows.length ? rows.map(l => `<tr>
    <td>${fmtDate(l.date)}</td>
    <td><a class="cust-link" onclick="printLogReport('${l.id}')" title="영업 활동 보고서 보기 · PDF 저장">${esc(logCustLabel(l))}</a></td>
    <td><span class="badge" style="background:#f1f5f9;color:#475569">${esc(l.type)}</span></td>
    <td style="max-width:340px;white-space:normal">${esc(l.content)}</td>
    <td style="font-size:12px;color:#64748b">${esc(l.interest || '-')}</td>
    <td style="font-size:12px">${esc(l.nextAction || '-')}</td>
    <td>${esc(l.rep || '-')}</td>
    <td class="text-end"><button class="btn btn-sm btn-outline-secondary" onclick="openLogModal('${l.id}')"><i class="bi bi-pencil"></i></button></td>
  </tr>`).join('') : `<tr><td colspan="8" class="table-empty">상담일지가 없습니다</td></tr>`;
}
function openLogModal(id, custId, forceProspectId) {
  refreshSelects();
  const l = id ? DB.logs.find(x => x.id === id) : null;
  const prospectId = forceProspectId || (l && l.prospectId) || '';
  const pr = prospectId ? prospectById(prospectId) : null;
  $('log-modal-title').textContent = l ? '상담일지 수정' : '상담일지 작성';
  $('l-del-btn').style.display = l ? 'inline-block' : 'none';
  $('l-id').value = l ? l.id : '';
  $('l-prospect-id').value = pr ? prospectId : '';
  $('l-date').value = l ? l.date : today();
  $('l-cust').value = pr ? pr.name + ' (타겟병원)' : (l ? custName(l.custId) : (custId ? custName(custId) : ''));
  $('l-cust').readOnly = !!pr;
  $('l-type').value = l ? l.type : '방문';
  $('l-interest').value = l && l.interest ? ((prodByName(l.interest) || {}).code || '') : '';
  $('l-rep').value = l ? (l.rep || '') : '';
  $('l-content').value = l ? l.content : '';
  $('l-next').value = l ? (l.nextAction || '') : '';
  $('l-next-date').value = l ? (l.nextActionDate || '') : '';
  new bootstrap.Modal($('logModal')).show();
}
function saveLog() {
  const prospectId = $('l-prospect-id').value;
  if (!prospectId && !trimv($('l-cust').value)) return alert('고객사를 입력하거나 선택해주세요.');
  if (!$('l-content').value.trim()) return alert('상담 내용을 입력해주세요.');
  const p = prodByCode($('l-interest').value);
  const row = { custId: prospectId ? '' : resolveCust($('l-cust').value), prospectId,
    date: $('l-date').value || today(), type: $('l-type').value,
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
/* 일정의 고객사 칸 표시 — 고객사 딜은 custId, 타겟병원 방문 예정은 prospectId 를 쓴다 */
function schCustLabel(s) {
  if (s.custId) return custName(s.custId);
  if (s.prospectId) { const p = prospectById(s.prospectId); return p ? p.name + ' (타겟병원)' : '(삭제된 타겟병원)'; }
  return '내부';
}
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
  const c = schCol(s.type);
  const done = !!s.done;
  const miss = !done && s.date < today();
  const stColor = done ? '#15803d' : miss ? '#b91c1c' : c;
  const stText = done ? '완료 ✓' : miss ? '결과 미입력' : esc(s.type) + ' 예정';
  /* onclick 안의 따옴표는 &#39; 로 넣는다 (브라우저가 속성 파싱할 때 ' 로 복원) */
  return '<div class="sc-mini' + (done ? ' done' : miss ? ' miss' : '') + '"'
    + ' style="border-left-color:' + (done ? '#16a34a' : c) + '"'
    + ' onclick="event.stopPropagation();openSchModal(&#39;' + s.id + '&#39;)">'
    + '<div class="m-top"><span class="m-st" style="color:' + stColor + '">' + stText + '</span>'
      + (s.rep ? '<span class="m-rep">' + esc(s.rep) + '</span>' : '') + '</div>'
    + '<div class="m-c">' + esc(schCustLabel(s)) + '</div>'
    + '<div class="m-s">' + (s.time ? esc(s.time) + ' · ' : '') + esc(s.type)
      + (s.grade ? ' · ' + esc(gradeLabel(s.grade)) : '') + '</div>'
    + (done ? (s.result ? '<div class="m-s" style="color:#15803d;margin-top:2px">' + esc(s.result) + '</div>' : '')
            : '<div class="m-act"><i class="bi bi-pencil-square"></i>결과 입력</div>')
    + '</div>';
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
    + esc(schCustLabel(s)) + '</span>'
    + '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(s.title)
    + (s.grade ? ' <span class="sc-type" style="background:#f1f5f9;color:#475569">' + esc(gradeLabel(s.grade)) + '</span>' : '')
    + (s.result ? ' <span style="color:#15803d">→ ' + esc(s.result) + '</span>' : '') + '</span>'
    + '<span style="width:50px;flex-shrink:0;color:#94a3b8;font-size:11px;text-align:right">' + esc(s.rep || '') + '</span>'
    + (s.done ? '<span class="sc-type" style="background:#f0fdf4;color:#15803d"><i class="bi bi-check2"></i> 완료</span>'
      : '<button class="btn btn-sm ' + (od ? 'btn-outline-danger' : 'btn-outline-primary')
        + '" style="font-size:11px;padding:2px 8px" onclick="event.stopPropagation();openSchModal(\'' + s.id + '\')">'
        + (od ? '결과 입력' : '결과 입력') + '</button>') + '</div>';
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
        + '1f;color:' + schCol(s.type) + '">' + (s.done ? '\u2713 ' : '') + (s.time ? esc(s.time) + ' ' : '')
        + esc(s.custId || s.prospectId ? schCustLabel(s) : s.title) + '</div>').join('')
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
          + esc(schCustLabel(s)) + ' — ' + esc(s.title)
          + (s.done ? (s.result ? ' <span style="color:#15803d">→ ' + esc(s.result) + '</span>' : ' <span style="color:#15803d">(완료)</span>')
                    : ' <span style="color:#ea580c">(대기)</span>') + '</div>').join('') : '')
      + (ll.length ? ll.map(l => '<div style="font-size:12px;padding:3px 0;color:#64748b">'
          + '<i class="bi bi-journal-text me-1"></i>' + esc(logCustLabel(l)) + ' — ' + esc(l.content) + '</div>').join('') : '')
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
/* 고객 반응 등급 — 방문 결과의 정성 평가 */
const SCH_GRADES = [
  { v: 4, l: '매우 긍정', cls: 'g4', ic: 'bi-emoji-laughing' },
  { v: 3, l: '긍정',      cls: 'g3', ic: 'bi-emoji-smile' },
  { v: 2, l: '보통',      cls: 'g2', ic: 'bi-emoji-neutral' },
  { v: 1, l: '부정',      cls: 'g1', ic: 'bi-emoji-frown' }
];
let S_GRADE = 0;
function renderGradeChips() {
  const box = $('s-grade-chips');
  if (!box) return;
  box.innerHTML = SCH_GRADES.map(g =>
    '<span class="gr-chip ' + g.cls + (S_GRADE === g.v ? ' on' : '') + '" onclick="pickGrade(' + g.v + ')">'
    + '<i class="bi ' + g.ic + '"></i>' + g.l + '</span>').join('')
    + (S_GRADE ? '<span class="gr-chip" onclick="pickGrade(0)" title="선택 해제"><i class="bi bi-x"></i></span>' : '');
}
function pickGrade(v) { S_GRADE = (S_GRADE === v ? 0 : v); renderGradeChips(); }
/* 방문 결과 — 구매여부에 따라 관련 칸만 보여준다 (영업 활동 보고서 양식) */
function purchaseStatusChange() {
  const v = $('s-purchase-status').value;
  $('s-purchase-amount-wrap').style.display = v === '구매' ? 'block' : 'none';
  $('s-propose-amount-wrap').style.display = (v === '미구매' || v === '보류') ? 'block' : 'none';
  $('s-nonpurchase-wrap').style.display = v === '미구매' ? 'block' : 'none';
}
function gradeLabel(v) { const g = SCH_GRADES.find(x => x.v === num(v)); return g ? g.l : ''; }

/* ── 일정 모달 안의 병원(고객사) 상세 요약 ──
   resolveCust 는 없는 이름이면 새로 만들어버리므로 여기서는 절대 쓰지 않는다.
   조회 전용 findCust 로 정확히 일치하는 고객사만 찾는다. */
const findCust = v => {
  const nm = trimv(v);
  if (!nm) return null;
  return DB.customers.find(x => x.name === nm) || DB.customers.find(x => x.id === nm) || null;
};
let SCI_OPEN = true;
function toggleSchCust() { SCI_OPEN = !SCI_OPEN; schCustPeek(); }
function schCustPeek() {
  const box = $('s-cust-info'), btn = $('s-cust-toggle');
  if (!box) return;
  const c = findCust($('s-cust').value);
  if (!c) { box.style.display = 'none'; box.innerHTML = ''; if (btn) btn.style.display = 'none'; return; }
  if (btn) {
    btn.style.display = 'inline-block';
    btn.innerHTML = '<i class="bi bi-hospital me-1"></i>' + (SCI_OPEN ? '정보 접기' : '병원 정보');
  }
  if (!SCI_OPEN) { box.style.display = 'none'; return; }
  box.style.display = 'block';
  box.innerHTML = schCustInfo(c);
}
function schCustInfo(c) {
  const id = c.id;
  const deals = DB.deals.filter(d => d.custId === id);
  const openD = deals.filter(d => OPEN_STAGES.includes(d.stage));
  const eqs = DB.equipments.filter(e => e.custId === id);
  const logs = DB.logs.filter(l => l.custId === id).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const last = logs.length ? logs[0].date : '';
  const addr = ((c.addr || '') + ' ' + (c.addr2 || '')).trim();
  const cts = c.contacts || [];

  const kpi = (l, v, sub, cls) =>
    '<div class="sci-k"><span>' + l + '</span><b' + (cls ? ' class="' + cls + '"' : '') + '>' + v + '</b>'
    + (sub ? '<i>' + sub + '</i>' : '') + '</div>';
  const line = (l, v) => v ? '<div class="sci-r"><span>' + l + '</span><b>' + esc(v) + '</b></div>' : '';

  return '<div class="sci-head">'
      + '<b>' + esc(c.name) + '</b>'
      + '<span class="grade-badge grade-' + esc(c.grade) + '">' + esc(c.grade) + '</span>'
      + '<button type="button" class="btn btn-link p-0 ms-auto" onclick="schGoCustDetail()"'
      + ' style="font-size:11px;font-weight:700;text-decoration:none">전체 상세 <i class="bi bi-arrow-right-short"></i></button>'
    + '</div>'
    + '<div class="sci-kpis">'
      + kpi('누적 수주', money(custWonAmount(id)) + '원', '계약 ' + deals.filter(d => d.stage === '계약완료').length + '건')
      + kpi('진행 딜', openD.length + '건', money(openD.reduce((t, d) => t + num(d.amount), 0)) + '원')
      + kpi('보유 장비', eqs.length + '대', 'A/S ' + eqs.reduce((t, e) => t + (e.as || []).length, 0) + '회')
      + kpi('최근 접촉', last ? (-dDays(last)) + '일 전' : '없음', last ? fmtDate(last) : '상담일지 없음',
            (!last || -dDays(last) > 60) ? 'rd' : '')
    + '</div>'
    + '<div class="sci-rows">'
      + line('구분', [c.type, c.dept].filter(x => trimv(x)).join(' · '))
      + line('원장/담당', c.doctor)
      + line('담당영업', c.rep)
      + line('대표 전화', c.phone)
      + line('지역', ((c.sido || '') + ' ' + (c.gugun || '')).trim())
      + line('주소', addr)
    + '</div>'
    + (cts.length ? '<div class="sci-sub">연락처 ' + cts.length + '명</div>'
        + '<div class="sci-cts">' + cts.slice(0, 4).map(x =>
            '<div class="sci-ct"><span class="ct-role">' + esc(x.role || '기타') + '</span>'
            + '<b>' + esc(x.name || '-') + '</b>'
            + (x.phone ? '<span>' + esc(x.phone) + '</span>' : '') + '</div>').join('')
        + (cts.length > 4 ? '<div class="sci-more">외 ' + (cts.length - 4) + '명 · 전체 상세에서 확인</div>' : '')
        + '</div>' : '')
    + (openD.length ? '<div class="sci-sub">진행 중 딜 ' + openD.length + '건</div>'
        + '<div class="sci-cts">' + openD.slice(0, 3).map(d =>
            '<div class="sci-ct"><span class="badge" style="background:' + stageOf(d.stage).color + '1a;color:'
            + stageOf(d.stage).color + '">' + esc(d.stage) + '</span>'
            + '<b>' + esc(d.product) + '</b><span>' + comma(d.amount) + '원</span></div>').join('')
        + '</div>' : '')
    + (logs.length ? '<div class="sci-sub">최근 상담 ' + Math.min(3, logs.length) + '건</div>'
        + '<div class="sci-logs">' + logs.slice(0, 3).map(l =>
            '<div class="sci-log"><em>' + fmtDate(l.date) + '</em>'
            + '<span class="sci-lt">' + esc(l.type || '기타') + '</span>'
            + '<span class="sci-lc">' + esc(l.content || '') + '</span></div>').join('')
        + '</div>'
      : '<div class="sci-empty">상담 이력이 없습니다 — 이번 결과가 첫 기록이 됩니다</div>')
    + (trimv(c.memo) ? '<div class="sci-memo"><b>메모</b> ' + esc(c.memo) + '</div>' : '');
}
/* 전체 상세로 이동: 작성 중 내용이 있으면 먼저 확인 */
function schGoCustDetail() {
  const c = findCust($('s-cust').value);
  if (!c) return;
  const dirty = trimv($('s-title').value) || trimv($('s-result').value) || trimv($('s-next').value) || S_GRADE;
  if (dirty && !confirm('저장하지 않은 입력 내용이 있습니다. 고객사 상세로 이동하면 사라집니다. 이동할까요?')) return;
  const m = bootstrap.Modal.getInstance($('schModal'));
  if (m) m.hide();
  setTimeout(() => openCustDetail(c.id), 200);
}

function openSchModal(id, preDate, forceProspectId) {
  refreshSelects();
  const s = id ? DB.schedules.find(x => x.id === id) : null;
  const prospectId = forceProspectId || (s && s.prospectId) || '';
  const pr = prospectId ? prospectById(prospectId) : null;
  $('sch-modal-title').textContent = pr ? '타겟병원 일정 등록' : (s ? '일정 수정' : '일정 추가');
  $('s-del-btn').style.display = s ? 'inline-block' : 'none';
  $('s-id').value = s ? s.id : '';
  $('s-prospect-id').value = pr ? prospectId : '';
  $('s-date').value = s ? s.date : (preDate || today());
  $('s-time').value = s ? (s.time || '') : '';
  $('s-cust').value = pr ? pr.name + ' (타겟병원)' : (s ? (s.custId ? custName(s.custId) : '') : '');
  $('s-cust').readOnly = !!pr;
  $('s-type').value = s ? s.type : '방문';
  $('s-rep').value = s ? (s.rep || '') : (pr ? (pr.rep || '') : '');
  $('s-title').value = s ? s.title : (pr ? (pr.name + ' 방문') : '');
  $('s-done').checked = s ? !!s.done : false;
  $('s-result').value = s ? (s.result || '') : '';
  $('s-h-director').value = s ? (s.hospitalDirector || '') : '';
  $('s-h-contact').value = s ? (s.hospitalContact || '') : '';
  $('s-h-doctor-count').value = s && num(s.doctorCount) ? num(s.doctorCount) : '';
  $('s-h-main-procedure').value = s ? (s.mainProcedure || '') : '';
  $('s-h-competitor').value = s ? (s.hospitalCompetitor || '') : '';
  $('s-purchase-status').value = s ? (s.purchaseStatus || '') : '';
  $('s-purchase-amount').value = s && num(s.purchaseAmount) ? comma(s.purchaseAmount) : '';
  $('s-propose-amount').value = s && num(s.proposeAmount) ? comma(s.proposeAmount) : '';
  $('s-nonpurchase-reason').value = s ? (s.nonPurchaseReason || '') : '';
  purchaseStatusChange();
  $('s-interest').value = s && s.interest ? ((prodByName(s.interest) || {}).code || '') : '';
  $('s-next').value = s ? (s.nextAction || '') : '';
  $('s-next-date').value = s ? (s.nextActionDate || '') : '';
  S_GRADE = s ? num(s.grade) : 0;
  renderGradeChips();
  /* 이미 상담일지로 기록된 건은 중복 생성하지 않도록 기본 해제 */
  $('s-mklog').checked = !(s && s.logId);
  $('s-mksch').checked = false;
  /* 상태 칩 */
  const chip = $('s-status-chip');
  if (chip) {
    if (!s) chip.innerHTML = '';
    else if (s.done) chip.innerHTML = '<span class="st-chip done">완료</span>';
    else if (s.date < today()) chip.innerHTML = '<span class="st-chip miss">결과 미입력</span>';
    else chip.innerHTML = '<span class="st-chip plan">예정</span>';
  }
  SCI_OPEN = true;
  schCustPeek();
  new bootstrap.Modal($('schModal')).show();
}
/* 타겟병원 목록의 '일정 등록' 아이콘 — 고객사로 전환하지 않고, 방문 예정 일정만 잡는다.
   타겟병원은 목록에 그대로 남고, 일정이 저장되면 상태만 '일정등록완료'로 바뀐다. */
function openProspectSchModal(prospectId) {
  if (!prospectById(prospectId)) return;
  openSchModal(null, today(), prospectId);
}
function saveSch() {
  if (!$('s-title').value.trim()) return alert('방문 목적·내용을 입력해주세요.');
  const result = $('s-result').value.trim();
  const prospectId = $('s-prospect-id').value;
  /* 타겟병원 일정은 아직 고객사가 아니므로 customer 를 새로 만들지 않는다 */
  const custId = prospectId ? '' : resolveCust($('s-cust').value);
  const rep = resolveRep($('s-rep').value);
  const p = prodByCode($('s-interest').value);
  /* 결과를 적었으면 완료로 본다 (다녀와서 기록한 것이므로) */
  const done = $('s-done').checked || !!result;
  const row = {
    date: $('s-date').value || today(), time: $('s-time').value, custId, prospectId,
    type: $('s-type').value, rep, title: $('s-title').value.trim(),
    done, result, grade: S_GRADE || 0,
    interest: p ? p.name : '',
    /* 영업 활동 보고서 양식 — 병원 현황 */
    hospitalDirector: trimv($('s-h-director').value), hospitalContact: trimv($('s-h-contact').value),
    doctorCount: num($('s-h-doctor-count').value), mainProcedure: trimv($('s-h-main-procedure').value),
    hospitalCompetitor: trimv($('s-h-competitor').value),
    /* 영업 활동 보고서 양식 — 결과 및 담당자 의견 */
    purchaseStatus: $('s-purchase-status').value, purchaseAmount: num($('s-purchase-amount').value),
    proposeAmount: num($('s-propose-amount').value), nonPurchaseReason: trimv($('s-nonpurchase-reason').value),
    nextAction: trimv($('s-next').value), nextActionDate: $('s-next-date').value
  };
  const id = $('s-id').value;
  let cur;
  if (id) { cur = DB.schedules.find(x => x.id === id); Object.assign(cur, row); }
  else { cur = Object.assign({ id: uid() }, row); DB.schedules.push(cur); }
  if (prospectId) {
    const pr = prospectById(prospectId);
    if (pr) { pr.status = '일정등록완료'; pr.updatedAt = today(); }
  }

  /* 결과를 상담일지로도 남긴다 → 고객사(또는 타겟병원) 활동 타임라인에 축적 */
  if (result && (custId || prospectId) && $('s-mklog').checked) {
    const logRow = {
      custId, prospectId, date: cur.date, type: cur.type === '내부' ? '기타' : cur.type,
      content: result + (S_GRADE ? ' [고객반응: ' + gradeLabel(S_GRADE) + ']' : ''),
      grade: row.grade, visitPurpose: cur.title,
      hospitalDirector: row.hospitalDirector, hospitalContact: row.hospitalContact,
      doctorCount: row.doctorCount, mainProcedure: row.mainProcedure, hospitalCompetitor: row.hospitalCompetitor,
      purchaseStatus: row.purchaseStatus, purchaseAmount: row.purchaseAmount,
      proposeAmount: row.proposeAmount, nonPurchaseReason: row.nonPurchaseReason,
      interest: row.interest, nextAction: row.nextAction, nextActionDate: row.nextActionDate, rep
    };
    if (cur.logId && DB.logs.some(l => l.id === cur.logId)) {
      Object.assign(DB.logs.find(l => l.id === cur.logId), logRow);
    } else {
      const lid = uid();
      DB.logs.push(Object.assign({ id: lid }, logRow));
      cur.logId = lid;
    }
  }
  /* 다음 액션을 후속 일정으로 예약 */
  if ($('s-mksch').checked && row.nextAction) {
    DB.schedules.push({
      id: uid(), date: row.nextActionDate || today(), time: '', custId, prospectId,
      type: cur.type, title: row.nextAction, rep, done: false, result: '', grade: 0,
      interest: row.interest, nextAction: '', nextActionDate: ''
    });
  }
  save();
  bootstrap.Modal.getInstance($('schModal')).hide();
  const msgs = [];
  if (result) msgs.push('결과 기록');
  if (result && (custId || prospectId) && $('s-mklog').checked) msgs.push('상담일지 생성');
  if ($('s-mksch').checked && row.nextAction) msgs.push('후속 일정 등록');
  if (msgs.length) toast(msgs.join(' · ') + ' 완료');
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
  const lostQ = all.filter(x => x.status === '실주');
  const quAvg = all.length ? tot / all.length : 0;
  const quExp = all.filter(x => quoteExpired(x)).length;
  const quMonth = all.filter(x => String(x.date).slice(0, 7) === today().slice(0, 7)).length;
  $('quote-band').innerHTML = `
    <div class="wt-hero clickable" onclick="drillQuotes('견적 전체','VAT 포함 총액 ${money(tot)}원',DB.quotes)">
      <div class="l">견적 총액 (VAT 포함)</div><b>${money(tot)}원</b><div class="s">전체 ${all.length}건</div></div>
    <div class="wt-fact clickable" onclick="drillQuotes('발송 대기·진행 견적','아직 종결되지 않은 견적',DB.quotes.filter(function(x){return x.status!=='수주'&&x.status!=='실주'}))">
      <div class="l">발송 대기·진행</div><b>${sent.length}</b><div class="s">${money(sent.reduce((s, x) => s + quoteCalc(x.items).total, 0))}원</div></div>
    <div class="wt-fact clickable" onclick="drillQuotes('수주 전환 견적','상태가 수주인 견적',DB.quotes.filter(function(x){return x.status==='수주'}))">
      <div class="l">수주 전환</div><b class="gr">${wonQ.length}</b><div class="s">${money(wonQ.reduce((s, x) => s + quoteCalc(x.items).total, 0))}원</div></div>
    <div class="wt-fact clickable" onclick="drillQuotes('실주 견적','성공률 ${(wonQ.length + lostQ.length) ? Math.round(wonQ.length / (wonQ.length + lostQ.length) * 100) : 0}% · 종결 ${wonQ.length + lostQ.length}건 기준',DB.quotes.filter(function(x){return x.status==='실주'}))">
      <div class="l">견적 성공률</div><b>${(wonQ.length + lostQ.length) ? Math.round(wonQ.length / (wonQ.length + lostQ.length) * 100) : 0}%</b><div class="s">수주/종결 기준</div></div>
    <div class="wt-fact clickable" onclick="drillQuotes('견적 전체','평균 금액 산정 대상',DB.quotes)">
      <div class="l">평균 견적액</div><b>${money(quAvg)}원</b>
      <div class="s">VAT 포함 ${all.length}건 평균</div></div>
    <div class="wt-fact clickable" onclick="drillQuotes('유효기간 만료 견적','발송 상태인데 유효기간이 지난 견적',DB.quotes.filter(function(x){return quoteExpired(x)}))">
      <div class="l">유효기간 만료</div><b class="${quExp ? 'rd' : ''}">${quExp}</b>
      <div class="s">재발송·종결 처리 필요</div></div>
    <div class="wt-fact clickable" onclick="drillQuotes('이번달 발송 견적','작성일이 이번달인 견적',DB.quotes.filter(function(x){return String(x.date).slice(0,7)===today().slice(0,7)}))">
      <div class="l">이번달 발송</div><b>${quMonth}</b>
      <div class="s">견적 활동량</div></div>`;

  const rows = all.filter(x => {
    if (st && x.status !== st) return false;
    if (q) return (x.no + ' ' + custName(x.custId) + ' ' + (x.rep || '')).toLowerCase().includes(q);
    return true;
  });
  const stColor = { '임시저장': '#64748b', '발송': '#0e7490', '수주': '#16a34a', '실주': '#dc2626' };
  $('quote-tbody').innerHTML = rows.length ? rows.map(x => {
    const c = quoteCalc(x.items);
    const until = x.date ? (() => { const d = parseD(x.date); d.setDate(d.getDate() + num(x.validDays || 30)); return ymd(d); })() : '';
    const expired = quoteExpired(x);
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
  const curCode = it.code || (prodByName(it.name || '') || {}).code || '';
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><select class="form-select form-select-sm qi-name" onchange="qiProd(this)">
      <option value="">제품 선택</option>
      ${DB.products.map(p => `<option value="${esc(p.code)}"${p.code === curCode ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}
      </select></td>
    <td><input type="number" class="form-control form-control-sm qi-qty" min="1" value="${num(it.qty) || 1}" oninput="quoteRecalc()"></td>
    <td><input type="text" class="form-control form-control-sm qi-price" inputmode="numeric" value="${comma(it.price)}" oninput="commaInput(this);quoteRecalc()"></td>
    <td><input type="number" class="form-control form-control-sm qi-disc" min="0" max="100" value="${num(it.disc)}" oninput="quoteRecalc()"></td>
    <td class="text-end fw-bold qi-amt" style="font-variant-numeric:tabular-nums">0</td>
    <td class="text-end"><button class="btn btn-sm btn-outline-secondary" onclick="this.closest('tr').remove();quoteRecalc()"><i class="bi bi-x"></i></button></td>`;
  $('q-items').appendChild(tr);
  quoteRecalc();
}
function qiProd(el) {
  const p = prodByCode(el.value);
  const tr = el.closest('tr');
  if (p) tr.querySelector('.qi-price').value = comma(p.price);
  quoteRecalc();
}
function readQuoteItems() {
  return [...$('q-items').querySelectorAll('tr')].map(tr => {
    const code = tr.querySelector('.qi-name').value;
    const p = prodByCode(code);
    return { code: p ? p.code : '', name: p ? p.name : '', qty: num(tr.querySelector('.qi-qty').value) || 1,
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
  const pre = 'UL' + yy + '-';
  /* 건수 + 1 로 만들면 중간 견적을 삭제한 뒤 번호가 중복된다.
     (3건 중 2번을 지우면 건수가 2 → 다시 UL26-02 발급)
     실제 발급된 최대 번호를 기준으로 잡는다. */
  const maxSeq = DB.quotes.reduce((mx, q) => {
    const no = String(q.no || '');
    if (!no.startsWith(pre)) return mx;
    return Math.max(mx, num(no.slice(pre.length)));
  }, 0);
  return pre + pad(maxSeq + 1);
}
function saveQuote(doPrint) {
  const items = readQuoteItems();
  if (!trimv($('q-cust').value)) return alert('고객사를 입력하거나 선택해주세요.');
  if (!items.length) return alert('품목을 1개 이상 추가해주세요.');
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

/* ══ 영업 활동 보고서 (상담일지를 첨부 양식대로 보여주기 · PDF 저장) ══ */
function logReportHTML(l) {
  const row = (k, v) => '<tr><th>' + esc(k) + '</th><td>' + esc(v || '-') + '</td></tr>';
  const wideRow = (k, v) => '<tr><th>' + esc(k) + '</th><td colspan="3">' + esc(v || '-') + '</td></tr>';
  const logoUrl = new URL('logo.png', location.href).href;
  return '<div class="rp">'
    + '<div class="rp-head"><img src="' + esc(logoUrl) + '" class="rp-logo" alt="UroLink"><div class="rp-title">영업 활동 보고서</div></div>'
    + '<div class="rp-sec">1. 방문 정보</div>'
    + '<table class="rp-tbl"><tbody>'
      + '<tr><th>병원명</th><td>' + esc(logCustLabel(l)) + '</td><th>방문일</th><td>' + esc(fmtDate(l.date)) + '</td></tr>'
      + '<tr><th>장비명</th><td>' + esc(l.interest || '-') + '</td><th>담당자</th><td>' + esc(l.rep || '-') + '</td></tr>'
      + wideRow('방문 목적', l.visitPurpose || l.type)
    + '</tbody></table>'
    + '<div class="rp-sec">2. 병원 현황</div>'
    + '<table class="rp-tbl"><tbody>'
      + '<tr><th>대표원장</th><td>' + esc(l.hospitalDirector || '-') + '</td><th>병원 내 담당자</th><td>' + esc(l.hospitalContact || '-') + '</td></tr>'
      + '<tr><th>원장 수</th><td>' + esc(num(l.doctorCount) ? num(l.doctorCount) + '명' : '-') + '</td><th>고객 호응도</th><td>' + esc(l.grade ? gradeLabel(l.grade) : '-') + '</td></tr>'
      + wideRow('주력 시술', l.mainProcedure)
      + wideRow('경쟁사 (보유 타사 장비)', l.hospitalCompetitor)
    + '</tbody></table>'
    + '<div class="rp-sec">3. 결과 및 담당자 의견</div>'
    + '<table class="rp-tbl"><tbody>'
      + '<tr><th>구매여부</th><td>' + esc(l.purchaseStatus || '-') + '</td><th>구매금액</th><td>' + esc(num(l.purchaseAmount) ? won(l.purchaseAmount) : '-') + '</td></tr>'
      + '<tr><th>제안금액</th><td>' + esc(num(l.proposeAmount) ? won(l.proposeAmount) : '-') + '</td><th>미구매 사유</th><td>' + esc(l.nonPurchaseReason || '-') + '</td></tr>'
    + '</tbody></table>'
    + '<div class="rp-note"><div class="t">담당자 의견</div><div class="b">' + esc(l.content || '-') + '</div></div>'
    + '</div>';
}
const REPORT_CSS = `
  *{box-sizing:border-box}
  body{font-family:'Noto Sans KR',sans-serif;margin:0;background:#fff;color:#182230;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  @page{size:A4;margin:0}
  .rp{padding:16mm 14mm;font-size:12px;letter-spacing:-.01em}
  .rp-head{display:flex;align-items:center;gap:16px;padding-bottom:14px;margin-bottom:20px;border-bottom:2px solid #16324f}
  .rp-logo{height:32px;width:auto}
  .rp-title{font-size:22px;font-weight:800;letter-spacing:.12em;color:#16324f;margin-left:auto}
  .rp-sec{font-size:14px;font-weight:800;color:#1f1f1d;margin:18px 0 8px;padding-bottom:4px;border-bottom:2px solid #16324f}
  .rp-tbl{width:100%;border-collapse:collapse;margin-bottom:4px}
  .rp-tbl th{width:120px;background:#f5f8fa;border:1px solid #dbe3ec;padding:8px 10px;font-size:11.5px;font-weight:700;color:#475569;text-align:left;white-space:nowrap}
  .rp-tbl td{border:1px solid #dbe3ec;padding:8px 10px;font-size:12px;color:#182230}
  .rp-note{margin-top:10px;border:1px solid #dbe3ec;border-radius:6px;overflow:hidden}
  .rp-note .t{background:#f5f8fa;border-bottom:1px solid #dbe3ec;padding:7px 10px;font-size:11.5px;font-weight:800;color:#475569}
  .rp-note .b{padding:11px 12px;font-size:12.5px;color:#334155;white-space:pre-wrap;line-height:1.7;min-height:60px}
  .rp-bar{position:sticky;top:0;display:flex;align-items:center;justify-content:flex-end;gap:8px;
    padding:10px 14mm;background:#f8fafc;border-bottom:1px solid #dbe3ec}
  .rp-bar button{border:0;border-radius:6px;padding:8px 16px;font-size:13px;font-weight:700;cursor:pointer;
    background:#0e7490;color:#fff}
  .rp-bar button:hover{background:#0c5f76}
  @media print{.rp-bar{display:none}}
`;
function printLogReport(id) {
  const l = DB.logs.find(x => x.id === id);
  if (!l) return;
  const html = logReportHTML(l);
  const win = window.open('', '_blank');
  if (!win) { alert('팝업이 차단되었습니다. 팝업 허용 후 다시 시도해주세요.'); return; }
  win.document.write('<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>영업 활동 보고서 · ' + esc(logCustLabel(l)) + '</title>'
    + '<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700;800&display=swap" rel="stylesheet">'
    + '<style>' + REPORT_CSS + '</style></head><body>'
    + '<div class="rp-bar"><button onclick="window.print()">🖨 인쇄 · PDF 저장</button></div>'
    + html + '</body></html>');
  win.document.close();
  win.focus();
}
/* ───────────────────────── 10. 고객사 ───────────────────────── */
let C_TAG = '';
function renderCustomers() {
  const q = ($('c-search').value || '').trim().toLowerCase();
  const g = $('c-grade').value, rep = $('c-rep').value, rg = $('c-region').value;
  const all = DB.customers;
  const gradeCnt = ['A','B','C','D'].map(x => all.filter(c => c.grade === x).length);
  const totalWon = DB.deals.filter(d => d.stage === '계약완료').reduce((s, d) => s + num(d.amount), 0);
  const cuPayList = all.filter(c => custWonAmount(c.id) > 0);
  const cuPaying = cuPayList.length;
  const cuAvg = cuPaying ? cuPayList.reduce((t, c) => t + custWonAmount(c.id), 0) / cuPaying : 0;
  const cuCold = all.filter(c => {
    const last = DB.logs.filter(l => l.custId === c.id).map(l => l.date).sort().pop();
    return !last || (-dDays(last)) > 60;
  }).length;
  const cuNew = all.filter(c => String(c.createdAt).slice(0, 7) === today().slice(0, 7)).length;
  $('cust-band').innerHTML = `
    <div class="wt-hero clickable" onclick="drillCusts('전체 고객사','누적 수주 ${money(totalWon)}원',DB.customers)">
      <div class="l">전체 고객사</div><b>${all.length}곳</b>
      <div class="s">누적 수주 ${money(totalWon)}원</div></div>
    <div class="wt-fact clickable" onclick="drillCusts('A등급 고객사','핵심 관리 대상',DB.customers.filter(function(c){return c.grade==='A'}))">
      <div class="l">A등급</div><b>${gradeCnt[0]}</b><div class="s">핵심 관리</div></div>
    <div class="wt-fact clickable" onclick="drillCusts('B · C등급 고객사','성장·유지 대상',DB.customers.filter(function(c){return c.grade==='B'||c.grade==='C'}))">
      <div class="l">B / C등급</div><b>${gradeCnt[1]} / ${gradeCnt[2]}</b><div class="s">성장·유지</div></div>
    <div class="wt-fact clickable" onclick="drillCusts('장비 보유 고객사','설치 장비가 1대 이상인 고객사',DB.customers.filter(function(c){return DB.equipments.some(function(e){return e.custId===c.id})}))">
      <div class="l">장비 보유</div><b>${new Set(DB.equipments.map(e => e.custId)).size}곳</b><div class="s">설치 ${DB.equipments.length}대</div></div>
    <div class="wt-fact clickable" onclick="drillCusts('30일 내 접촉 고객사','최근 30일 상담일지가 있는 고객사',DB.customers.filter(function(c){return DB.logs.some(function(l){return l.custId===c.id&&(-dDays(l.date))<=30})}))">
      <div class="l">30일 내 접촉</div><b>${all.filter(c => DB.logs.some(l => l.custId === c.id && (-dDays(l.date)) <= 30)).length}곳</b><div class="s">상담일지 기준</div></div>
    <div class="wt-fact clickable" onclick="drillCusts('누적 수주가 있는 고객사','평균 산정 대상',DB.customers.filter(function(c){return custWonAmount(c.id)>0}))">
      <div class="l">고객사당 평균</div><b>${money(cuAvg)}원</b>
      <div class="s">거래 있는 ${cuPaying}곳 평균</div></div>
    <div class="wt-fact clickable" onclick="drillCusts('60일 이상 미접촉','상담일지가 60일 이상 없는 고객사',DB.customers.filter(function(c){var L=DB.logs.filter(function(l){return l.custId===c.id}).map(function(l){return l.date}).sort().pop();return !L||(-dDays(L))>60}))">
      <div class="l">60일+ 미접촉</div><b class="${cuCold ? 'rd' : ''}">${cuCold}곳</b>
      <div class="s">이탈 위험 관리 대상</div></div>
    <div class="wt-fact clickable" onclick="drillCusts('이번달 신규 등록','createdAt 기준',DB.customers.filter(function(c){return String(c.createdAt).slice(0,7)===today().slice(0,7)}))">
      <div class="l">이번달 신규</div><b>${cuNew}곳</b>
      <div class="s">신규 등록 고객사</div></div>`;

  const tags = [...new Set(all.flatMap(c => (c.tags || []).map(t => String(t).trim()).filter(Boolean)))];
  $('c-tagbar').innerHTML = tags.length ? `<span class="pipe-chip ${C_TAG ? '' : 'on'}" onclick="setCTag('')">전체</span>`
    + tags.map(t => `<span class="pipe-chip ${C_TAG === t ? 'on' : ''}" onclick="setCTag('${jsq(t)}')">${esc(t)}</span>`).join('') : '';

  const rows = all.filter(c => {
    if (g && c.grade !== g) return false;
    if (rep && c.rep !== rep) return false;
    if (rg && c.sido !== rg) return false;
    if (C_TAG && !(c.tags || []).map(t => String(t).trim()).includes(C_TAG)) return false;
    if (q) {
      const ct = (c.contacts || []).map(x => (x.name || '') + ' ' + (x.phone || '') + ' ' + (x.role || '')).join(' ');
      return (c.name + ' ' + (c.doctor || '') + ' ' + (c.sido || '') + (c.gugun || '') + ' ' + (c.rep || '')
        + ' ' + (c.tags || []).join(' ') + ' ' + (c.phone || '') + ' ' + (c.addr || '') + ' ' + ct).toLowerCase().includes(q);
    }
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
/* ══ 주소 검색 (다음 우편번호 서비스) ══
   검색 결과에서 우편번호·기본주소를 채우고 시/도·시/군/구를 자동 분해한다. */
function searchAddress(prefix) {
  prefix = prefix || 'c';
  if (typeof daum === 'undefined' || !daum.Postcode) {
    alert('주소 검색 모듈을 불러오지 못했습니다. 인터넷 연결을 확인하고 새로고침해주세요.');
    return;
  }
  new daum.Postcode({
    oncomplete: function (d) {
      const base = d.roadAddress || d.jibunAddress || d.address || '';
      $(prefix + '-zip').value = d.zonecode || '';
      $(prefix + '-addr').value = base;
      $(prefix + '-sido').value = d.sido || '';
      $(prefix + '-gugun').value = d.sigungu || '';
      $(prefix + '-addr2').focus();
    }
  }).open();
}

/* ══ 연락처 여러 명 ══ */
const CT_ROLES = ['원장', '부원장', '실장', '간호', '구매', '행정', '기타'];
function contactRowHtml(c, boxId) {
  c = c || {}; boxId = boxId || 'c-contacts';
  return '<div class="ct-row">'
    + '<select class="form-select form-select-sm ct-role">'
    + CT_ROLES.map(r => '<option' + (c.role === r ? ' selected' : '') + '>' + esc(r) + '</option>').join('')
    + '</select>'
    + '<input type="text" class="form-control form-control-sm ct-name" placeholder="이름" value="' + esc(c.name || '') + '">'
    + '<input type="text" class="form-control form-control-sm ct-phone" placeholder="연락처" value="' + esc(c.phone || '') + '">'
    + '<input type="text" class="form-control form-control-sm ct-memo" placeholder="메모 (선호 시간 등)" value="' + esc(c.memo || '') + '">'
    + '<button class="btn-x" title="삭제" onclick="this.closest(\'.ct-row\').remove();ctEmptyCheck(\'' + boxId + '\')"><i class="bi bi-x-lg"></i></button>'
    + '</div>';
}
function renderContacts(list, boxId) {
  boxId = boxId || 'c-contacts';
  const box = $(boxId);
  if (!box) return;
  const arr = (list || []).filter(Boolean);
  box.innerHTML = arr.length ? arr.map(c => contactRowHtml(c, boxId)).join('')
    : '<div class="ct-empty">등록된 연락처가 없습니다. <b>연락처 추가</b>로 원장·실장 등을 넣어주세요.</div>';
}
function addContactRow(boxId) {
  boxId = boxId || 'c-contacts';
  const box = $(boxId);
  const empty = box.querySelector('.ct-empty');
  if (empty) empty.remove();
  box.insertAdjacentHTML('beforeend', contactRowHtml({}, boxId));
  const rows = box.querySelectorAll('.ct-row');
  const last = rows[rows.length - 1];
  if (last) last.querySelector('.ct-name').focus();
}
function ctEmptyCheck(boxId) {
  boxId = boxId || 'c-contacts';
  const box = $(boxId);
  if (box && !box.querySelector('.ct-row')) renderContacts([], boxId);
}
function readContacts(boxId) {
  boxId = boxId || 'c-contacts';
  return [...$(boxId).querySelectorAll('.ct-row')].map(r => ({
    role: r.querySelector('.ct-role').value,
    name: trimv(r.querySelector('.ct-name').value),
    phone: trimv(r.querySelector('.ct-phone').value),
    memo: trimv(r.querySelector('.ct-memo').value)
  })).filter(c => c.name || c.phone);
}

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
  $('c-zip').value = c ? (c.zip || '') : '';
  $('c-addr').value = c ? (c.addr || '') : '';
  $('c-addr2').value = c ? (c.addr2 || '') : '';
  $('c-tags').value = c ? (c.tags || []).join(', ') : '';
  $('c-memo').value = c ? (c.memo || '') : '';
  renderContacts(c ? c.contacts : []);
  $('c-updated').textContent = (c && c.updatedAt) ? '최종 수정 ' + fmtDate(c.updatedAt) + (c.updatedBy ? ' · ' + c.updatedBy : '') : '';
  new bootstrap.Modal($('custModal')).show();
}
function saveCust() {
  const name = $('c-name').value.trim();
  if (!name) return alert('고객사명을 입력해주세요.');
  const row = { name, type: $('c-type').value, doctor: $('c-doctor').value.trim(), dept: $('c-dept').value.trim(),
    grade: $('c-grade-in').value, sido: $('c-sido').value.trim(), gugun: $('c-gugun').value.trim(),
    rep: resolveRep($('c-rep-in').value), phone: $('c-phone').value.trim(),
    zip: $('c-zip').value.trim(), addr: $('c-addr').value.trim(), addr2: $('c-addr2').value.trim(),
    contacts: readContacts(),
    tags: $('c-tags').value.split(',').map(t => t.trim()).filter(Boolean), memo: $('c-memo').value.trim(),
    updatedAt: today(), updatedBy: curUserName() };
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
/* ══════════════════════════════════════════════════════════════
   중복 고객사 탐지 · 병합
   고객사는 어디서나 직접 입력으로 자동 등록되므로, 표기 차이 하나로
   같은 병원이 둘로 갈라지고 매출·이력도 함께 갈라진다. 여기서 잡는다.
   ══════════════════════════════════════════════════════════════ */

/* 비교용 정규화 — 공백/괄호/법인표기 제거 + 과명 표기 변화 통일 */
function normName(v) {
  let x = String(v == null ? '' : v).toLowerCase();
  x = x.replace(/[\s()（）·.,\-_/]/g, '');
  x = x.replace(/주식회사|㈜|의료법인|재단법인|사단법인/g, '');
  /* 2020년 과명 변경: 비뇨기과 → 비뇨의학과. 같은 병원이 두 표기로 들어온다 */
  x = x.replace(/비뇨기과/g, '비뇨의학과');
  x = x.replace(/의원$|병원$|클리닉$|센터$/g, '');
  return x;
}

/* 편집거리 — 오타 1~2글자 차이를 잡기 위한 최소 구현 */
function editDist(a, b) {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/* 중복 후보 그룹 산출. 판정 근거(why)를 함께 돌려줘 사용자가 오판하지 않게 한다 */
function findDupGroups() {
  const cs = DB.customers.map(c => ({ c, k: normName(c.name) })).filter(x => x.k);
  const used = {};
  const groups = [];
  for (let i = 0; i < cs.length; i++) {
    if (used[cs[i].c.id]) continue;
    const members = [cs[i]];
    let why = '';
    for (let j = i + 1; j < cs.length; j++) {
      if (used[cs[j].c.id]) continue;
      const a = cs[i].k, b = cs[j].k;
      let hit = '';
      if (a === b) hit = '표기만 다른 동일 이름';
      else if (a.length >= 4 && b.length >= 4 && (a.indexOf(b) >= 0 || b.indexOf(a) >= 0)) hit = '한쪽이 다른 쪽을 포함';
      else if (Math.min(a.length, b.length) >= 5 && editDist(a, b) <= 2) hit = '오타 추정 (' + editDist(a, b) + '글자 차이)';
      /* 같은 전화번호는 이름이 달라도 사실상 같은 곳일 확률이 높다 */
      else if (digitsOnly(cs[i].c.phone) && digitsOnly(cs[i].c.phone) === digitsOnly(cs[j].c.phone)) hit = '대표 전화 동일';
      if (hit) {
        members.push(cs[j]);
        used[cs[j].c.id] = 1;
        if (!why) why = hit;
      }
    }
    if (members.length > 1) {
      used[cs[i].c.id] = 1;
      groups.push({ why, members: members.map(m => m.c) });
    }
  }
  return groups;
}

/* 고객사가 실제로 얼마나 쓰이고 있는지 — 대표를 고를 판단 근거 */
function custUsage(id) {
  return {
    deals: DB.deals.filter(d => d.custId === id).length,
    logs: DB.logs.filter(l => l.custId === id).length,
    sch: DB.schedules.filter(x => x.custId === id).length,
    equip: DB.equipments.filter(e => e.custId === id).length,
    quotes: DB.quotes.filter(q => q.custId === id).length,
    won: custWonAmount(id)
  };
}
const usageTotal = u => u.deals + u.logs + u.sch + u.equip + u.quotes;

function openDupModal() {
  renderDupBody();
  new bootstrap.Modal($('dupModal')).show();
}

function renderDupBody() {
  const groups = findDupGroups();
  $('dup-sub').textContent = groups.length
    ? '중복 후보 ' + groups.length + '건 — 남길 고객사를 고르고 병합하세요'
    : '중복 후보가 없습니다';
  if (!groups.length) {
    $('dup-body').innerHTML = '<div class="ana-empty" style="padding:44px 0">'
      + '<i class="bi bi-check-circle" style="font-size:26px;color:#16a34a"></i>'
      + '<div class="mt-2">중복으로 의심되는 고객사가 없습니다</div>'
      + '<span>이름 표기 차이 · 오타(2글자 이내) · 대표 전화 동일을 검사했습니다</span></div>';
    return;
  }
  $('dup-body').innerHTML = groups.map((g, gi) => {
    const rows = g.members.map((c, mi) => {
      const u = custUsage(c.id);
      return '<tr>'
        + '<td class="text-center"><input type="radio" name="dupk' + gi + '" value="' + esc(c.id) + '"'
          + (mi === 0 ? ' checked' : '') + '></td>'
        + '<td class="fw-bold">' + esc(c.name)
          + (c.auto ? ' <span class="dup-auto">자동등록</span>' : '') + '</td>'
        + '<td>' + esc(c.type || '-') + '</td>'
        + '<td>' + esc(c.doctor || '-') + '</td>'
        + '<td>' + esc(((c.sido || '') + ' ' + (c.gugun || '')).trim() || '-') + '</td>'
        + '<td>' + esc(c.phone || '-') + '</td>'
        + '<td class="text-center">' + esc(c.grade || '-') + '</td>'
        + '<td class="text-end fw-bold">' + comma(u.won) + '</td>'
        + '<td class="dup-u">딜 ' + u.deals + ' · 일정 ' + u.sch + ' · 일지 ' + u.logs
          + ' · 장비 ' + u.equip + ' · 견적 ' + u.quotes + '</td>'
        + '<td>' + fmtDate(c.createdAt) + '</td></tr>';
    }).join('');
    /* 사용량이 가장 많은 쪽을 기본 대표로 추천 */
    const best = g.members.slice().sort((a, b) => usageTotal(custUsage(b.id)) - usageTotal(custUsage(a.id)))[0];
    return '<div class="dup-grp">'
      + '<div class="dup-h"><b>후보 ' + (gi + 1) + '</b>'
        + '<span class="dup-why">' + esc(g.why) + '</span>'
        + '<span class="dup-rec">추천 대표: ' + esc(best.name) + '</span>'
        + '<button class="btn btn-sm btn-warning ms-auto" onclick="mergeDupGroup(' + gi + ')">'
        + '<i class="bi bi-intersect me-1"></i>선택한 쪽으로 병합</button></div>'
      + '<div style="overflow-x:auto"><table class="table table-sm mb-0 dup-t">'
      + '<thead><tr><th class="text-center">대표</th><th>고객사명</th><th>구분</th><th>원장</th>'
      + '<th>지역</th><th>전화</th><th class="text-center">등급</th><th class="text-end">누적수주</th>'
      + '<th>사용량</th><th>등록일</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
      + '<input type="hidden" id="dupids' + gi + '" value="' + esc(g.members.map(m => m.id).join(',')) + '"></div>';
  }).join('');
}

function mergeDupGroup(gi) {
  if (!ensureAdmin()) return;
  const ids = ($('dupids' + gi).value || '').split(',').filter(Boolean);
  const picked = document.querySelector('input[name="dupk' + gi + '"]:checked');
  if (!picked) return alert('남길 대표 고객사를 선택해주세요.');
  const keepId = picked.value;
  const dropIds = ids.filter(x => x !== keepId);
  if (!dropIds.length) return alert('병합할 대상이 없습니다.');
  const keep = custById(keepId);
  if (!keep) return;
  const dropNames = dropIds.map(id => (custById(id) || {}).name).filter(Boolean);
  if (!confirm('[' + dropNames.join(', ') + '] 을(를) [' + keep.name + '] 로 병합합니다.\n'
    + '딜 · 일정 · 상담일지 · 장비 · 견적이 모두 옮겨지고 병합된 고객사는 삭제됩니다. 되돌릴 수 없습니다.\n\n계속할까요?')) return;
  const moved = mergeCustomers(keepId, dropIds);
  save();
  renderDupBody();
  if (CUR_PAGE === 'customers') renderCustomers();
  refreshDatalists();
  toast('병합 완료 — ' + moved + '건의 기록을 ' + keep.name + ' 로 이동');
}

/* 실제 병합. 참조를 옮기고, 대표의 빈 항목만 채우고, 연락처·태그는 합친다 */
function mergeCustomers(keepId, dropIds) {
  const keep = custById(keepId);
  if (!keep || !dropIds.length) return 0;
  let moved = 0;
  ['deals', 'logs', 'schedules', 'equipments', 'quotes'].forEach(t => {
    (DB[t] || []).forEach(r => {
      if (dropIds.indexOf(r.custId) >= 0) { r.custId = keepId; moved++; }
    });
  });
  dropIds.forEach(id => {
    const d = custById(id);
    if (!d) return;
    /* 대표에 비어 있는 항목만 보충 — 대표의 값을 덮어쓰지 않는다 */
    ['type', 'doctor', 'dept', 'sido', 'gugun', 'phone', 'zip', 'addr', 'addr2', 'rep'].forEach(f => {
      if (!trimv(keep[f]) && trimv(d[f])) keep[f] = d[f];
    });
    /* 등급은 더 높은 쪽(A가 최상)을 남긴다 */
    if (trimv(d.grade) && (!trimv(keep.grade) || d.grade < keep.grade)) keep.grade = d.grade;
    keep.tags = [...new Set([...(keep.tags || []), ...(d.tags || [])])];
    const seen = {};
    keep.contacts = [...(keep.contacts || []), ...(d.contacts || [])].filter(x => {
      const k = trimv(x.name) + '|' + digitsOnly(x.phone);
      if (k === '|' || seen[k]) return false;
      seen[k] = 1;
      return true;
    });
    if (trimv(d.memo)) keep.memo = (trimv(keep.memo) ? keep.memo + '\n' : '') + '[' + d.name + '] ' + d.memo;
    /* 병합 흔적을 남긴다 — 나중에 "왜 이 이름이 없지" 를 추적할 수 있게 */
    keep.mergedFrom = [...new Set([...(keep.mergedFrom || []), d.name])];
  });
  keep.updatedAt = today();
  keep.updatedBy = curUserName();
  DB.customers = DB.customers.filter(c => dropIds.indexOf(c.id) < 0);
  return moved;
}

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
         ['지역', (c.sido || '') + ' ' + (c.gugun || '')], ['담당영업', c.rep], ['대표 전화', c.phone],
         ['주소', ((c.zip ? '(' + c.zip + ') ' : '') + (c.addr || '') + ' ' + (c.addr2 || '')).trim()],
         ['태그', (c.tags || []).join(', ')], ['등록일', fmtDate(c.createdAt)]]
        .map(([k, v]) => `<div class="col-md-6" style="display:flex;border-bottom:1px solid #f3f4f6">
          <div style="width:100px;flex-shrink:0;background:#fafbfc;padding:10px 12px;font-size:12px;font-weight:600;color:#64748b">${esc(k)}</div>
          <div style="flex:1;padding:10px 12px;font-size:13px;min-width:0;word-break:break-word">${esc(v || '-')}</div></div>`).join('')}
      <div class="col-12" style="display:flex">
        <div style="width:100px;flex-shrink:0;background:#fafbfc;padding:10px 12px;font-size:12px;font-weight:600;color:#64748b">메모</div>
        <div style="flex:1;padding:10px 12px;font-size:13px;white-space:pre-wrap">${esc(c.memo || '-')}</div></div></div>`
      + ((c.contacts || []).length ? `<div class="wt-st mt-3"><i class="bi bi-people me-1"></i>연락처 ${c.contacts.length}명</div>
        <div class="ct-list">${c.contacts.map(x => `<div class="ct-item">
          <span class="ct-role">${esc(x.role || '기타')}</span>
          <b style="min-width:70px">${esc(x.name || '-')}</b>
          <span style="color:#334155">${esc(x.phone || '')}</span>
          <span style="color:#94a3b8;margin-left:auto">${esc(x.memo || '')}</span></div>`).join('')}</div>` : '')
      + (c.updatedAt ? `<div style="font-size:11px;color:#94a3b8;margin-top:10px;text-align:right">최종 수정 ${fmtDate(c.updatedAt)}${c.updatedBy ? ' · ' + esc(c.updatedBy) : ''}</div>` : '');
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

/* ───────────────────────── 10-1. 타겟병원 (아직 계약 안 된 잠재 병원) ───────────────────────── */
const PROSPECT_STATUS = ['신규', '접촉중', '제안', '보류', '일정등록완료'];
const PROSPECT_STATUS_COLOR = { '신규': '#0ea5e9', '접촉중': '#6366f1', '제안': '#8b5cf6', '보류': '#94a3b8', '일정등록완료': '#16a34a' };
const prospectById = id => DB.prospects.find(p => p.id === id);

function renderProspects() {
  const q = trimv(($('pr-search') || {}).value).toLowerCase();
  const st = ($('pr-status') || {}).value, rep = ($('pr-rep') || {}).value, rg = ($('pr-region') || {}).value;
  const all = DB.prospects;
  const stCnt = PROSPECT_STATUS.map(s => all.filter(p => p.status === s).length);
  const band = $('prospect-band');
  if (band) band.innerHTML = `
    <div class="wt-hero"><div class="l">전체 타겟병원</div><b>${all.length}곳</b><div class="s">아직 계약 안 된 잠재 병원</div></div>
    ${PROSPECT_STATUS.map((s, i) => `<div class="wt-fact"><div class="l">${esc(s)}</div><b>${stCnt[i]}</b></div>`).join('')}`;

  const rows = all.filter(p => {
    if (st && p.status !== st) return false;
    if (rep && p.rep !== rep) return false;
    if (rg && p.sido !== rg) return false;
    if (q) return (p.name + ' ' + (p.dept || '') + ' ' + (p.sido || '') + (p.gugun || '') + ' '
      + (p.rep || '') + ' ' + (p.interest || '') + ' ' + (p.phone || '')).toLowerCase().includes(q);
    return true;
  }).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  const tb = $('prospect-tbody');
  if (!tb) return;
  tb.innerHTML = rows.length ? rows.map(p => `<tr>
    <td><a class="cust-link" onclick="openProspectDetail('${p.id}')">${esc(p.name)}</a></td>
    <td style="font-size:12px;color:#64748b">${esc(p.type || '-')}</td>
    <td>${esc(p.dept || '-')}</td>
    <td style="font-size:12px">${esc((p.sido || '') + ' ' + (p.gugun || '')) || '-'}</td>
    <td>${esc(p.rep || '-')}</td>
    <td><span class="badge" style="background:${PROSPECT_STATUS_COLOR[p.status] || '#94a3b8'}">${esc(p.status || '신규')}</span></td>
    <td style="font-size:12px">${esc(p.interest || '-')}</td>
    <td style="font-size:12px;color:#64748b">${esc(p.nextAction || '-')}${p.nextActionDate ? ' · ' + fmtDate(p.nextActionDate) : ''}</td>
    <td class="text-end">
      <button class="btn btn-sm btn-outline-success me-1" title="일정 등록" onclick="openProspectSchModal('${p.id}')"><i class="bi bi-calendar-plus"></i></button>
      <button class="btn btn-sm btn-outline-secondary" onclick="openProspectModal('${p.id}')"><i class="bi bi-pencil"></i></button>
    </td>
  </tr>`).join('') : `<tr><td colspan="9" class="table-empty">타겟병원이 없습니다</td></tr>`;
}

let PR_DETAIL_ID = null;
/* 타겟병원 상세(읽기 전용) — 수정은 목록의 연필 버튼(openProspectModal)에서만 한다 */
function openProspectDetail(id) {
  const p = prospectById(id); if (!p) return;
  PR_DETAIL_ID = id;
  $('prd-name').innerHTML = esc(p.name) + ` <span class="badge" style="background:${PROSPECT_STATUS_COLOR[p.status] || '#94a3b8'}">${esc(p.status || '신규')}</span>`;
  $('prd-sub').textContent = [p.type, p.dept, (p.sido || '') + ' ' + (p.gugun || ''), '담당 ' + (p.rep || '미지정')].filter(x => String(x).trim()).join(' · ');
  const rows = [['구분', p.type], ['진료과', p.dept], ['지역', (p.sido || '') + ' ' + (p.gugun || '')],
    ['담당자', p.rep], ['연락처', p.phone],
    ['주소', ((p.zip ? '(' + p.zip + ') ' : '') + (p.addr || '') + ' ' + (p.addr2 || '')).trim()],
    ['관심장비 / 제품', p.interest],
    ['다음 액션', p.nextAction ? p.nextAction + (p.nextActionDate ? ' · ' + fmtDate(p.nextActionDate) : '') : ''],
    ['등록일', fmtDate(p.createdAt)]];
  $('prd-body').innerHTML = `<div class="row g-0" style="border:1px solid var(--border);border-radius:12px;overflow:hidden">
      ${rows.map(([k, v]) => `<div class="col-md-6" style="display:flex;border-bottom:1px solid #f3f4f6">
        <div style="width:110px;flex-shrink:0;background:#fafbfc;padding:10px 12px;font-size:12px;font-weight:600;color:#64748b">${esc(k)}</div>
        <div style="flex:1;padding:10px 12px;font-size:13px;min-width:0;word-break:break-word">${esc(v || '-')}</div></div>`).join('')}
      <div class="col-12" style="display:flex">
        <div style="width:110px;flex-shrink:0;background:#fafbfc;padding:10px 12px;font-size:12px;font-weight:600;color:#64748b">메모</div>
        <div style="flex:1;padding:10px 12px;font-size:13px;white-space:pre-wrap">${esc(p.memo || '-')}</div></div></div>`
    + ((p.contacts || []).length ? `<div class="wt-st mt-3"><i class="bi bi-people me-1"></i>연락처 ${p.contacts.length}명</div>
      <div class="ct-list">${p.contacts.map(x => `<div class="ct-item">
        <span class="ct-role">${esc(x.role || '기타')}</span>
        <b style="min-width:70px">${esc(x.name || '-')}</b>
        <span style="color:#334155">${esc(x.phone || '')}</span>
        <span style="color:#94a3b8;margin-left:auto">${esc(x.memo || '')}</span></div>`).join('')}</div>` : '')
    + (p.updatedAt ? `<div style="font-size:11px;color:#94a3b8;margin-top:10px;text-align:right">최종 수정 ${fmtDate(p.updatedAt)}${p.updatedBy ? ' · ' + esc(p.updatedBy) : ''}</div>` : '');
  new bootstrap.Modal($('prospectDetailModal')).show();
}
function openProspectModal(id) {
  refreshSelects();
  fillSelect($('pr-status-in'), PROSPECT_STATUS);
  const p = id ? prospectById(id) : null;
  $('pr-modal-title').textContent = p ? '타겟병원 수정' : '타겟병원 추가';
  $('pr-del-btn').style.display = p ? 'inline-block' : 'none';
  $('pr-conv-btn').style.display = p ? 'inline-block' : 'none';
  $('pr-id').value = p ? p.id : '';
  $('pr-name').value = p ? p.name : '';
  $('pr-type').value = p ? (p.type || '의원') : '의원';
  $('pr-dept').value = p ? (p.dept || '') : '비뇨의학과';
  $('pr-sido').value = p ? (p.sido || '') : '';
  $('pr-gugun').value = p ? (p.gugun || '') : '';
  $('pr-rep-in').value = p ? (p.rep || '') : '';
  $('pr-phone').value = p ? (p.phone || '') : '';
  $('pr-zip').value = p ? (p.zip || '') : '';
  $('pr-addr').value = p ? (p.addr || '') : '';
  $('pr-addr2').value = p ? (p.addr2 || '') : '';
  $('pr-status-in').value = p ? (p.status || '신규') : '신규';
  $('pr-interest').value = p && p.interest ? ((prodByName(p.interest) || {}).code || '') : '';
  $('pr-next').value = p ? (p.nextAction || '') : '';
  $('pr-next-date').value = p ? (p.nextActionDate || '') : '';
  $('pr-memo').value = p ? (p.memo || '') : '';
  renderContacts(p ? p.contacts : [], 'pr-contacts');
  new bootstrap.Modal($('prospectModal')).show();
}
function saveProspect() {
  const name = $('pr-name').value.trim();
  if (!name) return alert('병원명을 입력해주세요.');
  const row = { name, type: $('pr-type').value, dept: $('pr-dept').value.trim(),
    sido: $('pr-sido').value.trim(), gugun: $('pr-gugun').value.trim(),
    rep: resolveRep($('pr-rep-in').value), phone: $('pr-phone').value.trim(),
    zip: $('pr-zip').value.trim(), addr: $('pr-addr').value.trim(), addr2: $('pr-addr2').value.trim(),
    status: $('pr-status-in').value, interest: (prodByCode($('pr-interest').value) || {}).name || '',
    contacts: readContacts('pr-contacts'),
    nextAction: $('pr-next').value.trim(), nextActionDate: $('pr-next-date').value, memo: $('pr-memo').value.trim(),
    updatedAt: today(), updatedBy: curUserName() };
  const id = $('pr-id').value;
  if (id) Object.assign(prospectById(id), row);
  else DB.prospects.push(Object.assign({ id: uid(), createdAt: today() }, row));
  save();
  bootstrap.Modal.getInstance($('prospectModal')).hide();
  renderProspects();
}
function deleteProspect() {
  if (!ensureAdmin()) return;
  const id = $('pr-id').value; if (!id) return;
  if (!confirm('이 타겟병원을 삭제할까요?')) return;
  DB.prospects = DB.prospects.filter(p => p.id !== id);
  save(); bootstrap.Modal.getInstance($('prospectModal')).hide(); renderProspects();
}
/* 고객사로 전환 — 타겟병원 정보를 그대로 고객사에 옮기고, 아직 계약 안 된 목록에서는 뺀다 */
function convertProspect(id) {
  const p = prospectById(id);
  if (!p) return;
  if (!confirm(`'${p.name}'을(를) 고객사로 전환할까요?\n타겟병원 목록에서는 사라집니다.`)) return;
  DB.customers.push({ id: uid(), name: p.name, type: p.type || '의원', doctor: '', dept: p.dept || '비뇨의학과',
    grade: 'C', sido: p.sido || '', gugun: p.gugun || '', rep: p.rep || '', phone: p.phone || '',
    zip: p.zip || '', addr: p.addr || '', addr2: p.addr2 || '', contacts: p.contacts || [],
    tags: [], memo: p.memo || '', createdAt: today() });
  DB.prospects = DB.prospects.filter(x => x.id !== id);
  save();
  [$('prospectModal'), $('prospectDetailModal')].forEach(el => {
    const m = bootstrap.Modal.getInstance(el);
    if (m) m.hide();
  });
  refreshSelects();
  renderProspects();
  toast('고객사로 전환했습니다');
}

/* ───────────────────────── 11. 장비 · A/S ───────────────────────── */
function renderEquip() {
  const q = ($('e-search').value || '').trim().toLowerCase();
  const st = $('e-status').value, wf = $('e-warranty').value;
  const all = DB.equipments;
  const soon = all.filter(e => { const n = dDays(e.warrantyEnd); return n != null && n >= 0 && n <= 90; });
  const expired = all.filter(e => { const n = dDays(e.warrantyEnd); return n != null && n < 0; });
  const eqValid = all.filter(e => { const d = dDays(e.warrantyEnd); return d != null && d > 90; }).length;
  const eqAges = all.filter(e => e.installDate).map(e => dayDiff(e.installDate, today()) / 365).filter(v => v >= 0);
  const eqAge = eqAges.length ? Math.round(eqAges.reduce((a, b) => a + b, 0) / eqAges.length * 10) / 10 : null;
  $('equip-band').innerHTML = `
    <div class="wt-hero clickable" onclick="drillEquip('설치 장비 전체','${new Set(all.map(e => e.custId)).size}개 고객사에 ${all.length}대',DB.equipments)">
      <div class="l">설치 장비 (Installed Base)</div><b>${all.length}대</b>
      <div class="s">${new Set(all.map(e => e.custId)).size}개 고객사</div></div>
    <div class="wt-fact clickable" onclick="drillEquip('보증 90일 내 만료','유지보수 계약 제안 대상',DB.equipments.filter(function(e){var n=dDays(e.warrantyEnd);return n!=null&&n>=0&&n<=90}))">
      <div class="l">보증 90일 내 만료</div><b class="${soon.length ? 'rd' : ''}">${soon.length}</b><div class="s">유지보수 영업 기회</div></div>
    <div class="wt-fact clickable" onclick="drillEquip('보증 만료 장비','UL-CARE 제안 대상',DB.equipments.filter(function(e){var n=dDays(e.warrantyEnd);return n!=null&&n<0}))">
      <div class="l">보증 만료</div><b>${expired.length}</b><div class="s">UL-CARE 제안 대상</div></div>
    <div class="wt-fact clickable" onclick="drillEquip('수리중 장비','A/S 진행 중',DB.equipments.filter(function(e){return e.status==='수리중'}))">
      <div class="l">수리중</div><b class="${all.filter(e => e.status === '수리중').length ? 'rd' : ''}">${all.filter(e => e.status === '수리중').length}</b><div class="s">A/S 진행</div></div>
    <div class="wt-fact clickable" onclick="drillEquip('A/S 이력 있는 장비','누적 ${all.reduce((s, e) => s + (e.as || []).length, 0)}회',DB.equipments.filter(function(e){return (e.as||[]).length>0}))">
      <div class="l">A/S 누적</div><b>${all.reduce((s, e) => s + (e.as || []).length, 0)}회</b><div class="s">이력 기준</div></div>
    <div class="wt-fact clickable" onclick="drillRebuy(true)">
      <div class="l">소모품 재구매 도래</div>
      <b class="${rebuyDue().length ? 'rd' : ''}">${rebuyDue().length}</b>
      <div class="s">${money(rebuyDue().reduce((s, x) => s + x.avgAmt, 0))}원 규모</div></div>
    <div class="wt-fact clickable" onclick="drillEquip('보증 유효 장비','보증만료일이 남아 있는 장비',DB.equipments.filter(function(e){var d=dDays(e.warrantyEnd);return d!=null&&d>90}))">
      <div class="l">보증 유효</div><b class="gr">${eqValid}</b>
      <div class="s">90일 이상 남음</div></div>
    <div class="wt-fact clickable" onclick="drillEquip('설치일 기록 장비','평균 사용연수 산정 대상',DB.equipments.filter(function(e){return !!e.installDate}))">
      <div class="l">평균 사용연수</div><b>${eqAge == null ? '-' : eqAge + '년'}</b>
      <div class="s">${eqAge == null ? '설치일 기록 부족' : '교체 제안 판단 기준'}</div></div>`;

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
  $('e-model').value = e ? (e.modelCode || '') : '';
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
  const p = prodByCode($('e-model').value), inst = $('e-install').value;
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
  if (!$('e-model').value) return alert('모델을 선택해주세요.');
  const code = $('e-model').value;
  const p = prodByCode(code);
  const row = { custId: resolveCust($('e-cust').value), modelCode: code, model: p ? p.name : '',
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
      <td class="text-end"><button class="btn btn-sm btn-outline-secondary" onclick="openProdModal('${jsq(p.code)}')"><i class="bi bi-pencil"></i></button></td></tr>`;
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
  /* 드릴다운은 클릭 시점에 다시 계산하므로 기간을 넘겨둔다 */
  DRL.anaA = a; DRL.anaB = b;

  if (ANA_TAB === 'target') {
    $('ana-body').innerHTML = renderTargetTab(y, a, b, wonD);
  } else if (ANA_TAB === 'activity') {
    $('ana-body').innerHTML = renderActivityTab(y, a, b, wonD);
  } else if (ANA_TAB === 'rep') {
    const reps = salesRepNames();
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
            const cnt = stats.filter(s => s.cat === c).reduce((s2, x) => s2 + x.wonCnt, 0);
            return `<div class="funnel-row clk" onclick="drillDeals('${esc(c)} 수주 내역','${esc(anaDesc())}',anaWon().filter(function(d){return (prodByCode(d.productCode)||{}).cat==='${esc(c)}'}))">
              <div class="funnel-label">${esc(c)}</div>
              <div class="funnel-cnt">${cnt ? cnt + '건' : '-'}</div>
              <div class="funnel-bar-wrap"><div class="funnel-bar" style="width:${total ? amt / total * 100 : 0}%;background:${{'장비':'#0e7490','소모품':'#16a34a','액세서리':'#7c3aed','서비스':'#ea580c'}[c]}"></div></div>
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
            return `<div class="funnel-row clk" onclick="drillDeals('${esc(r.name)} 이상 도달 딜','실주 제외 · 전체 딜 기준',DB.deals.filter(function(d){var di=STAGES.findIndex(function(x){return x.name===d.stage});return d.stage!=='실주'&&di>=${STAGES.findIndex(x => x.name === r.name)}}))">
              <div class="funnel-label">${esc(r.name)}</div>
              <div class="funnel-cnt">${r.cnt}건</div>
              <div class="funnel-bar-wrap"><div class="funnel-bar" style="width:${r.cnt / maxC * 100}%;background:${r.color}"></div></div>
              <div class="funnel-amt">${i === 0 ? '-' : conv + '%'}</div></div>`;
          }).join('')}
          <div style="font-size:11.5px;color:#94a3b8;margin-top:8px">오른쪽 수치 = 직전 단계 대비 전환율(실주 제외, 전체 딜 기준)</div>
        </div></div>
        <div class="col-lg-6"><div class="card p-3 h-100"><div class="wt-st">실주 사유</div>
          ${lostBreakdown('lostReason', '사유 미기록')}</div></div>
        <div class="col-lg-6"><div class="card p-3 h-100"><div class="wt-st">담당자별 실주</div>
          ${lostBreakdown('rep', '미지정')}</div></div>
        <div class="col-lg-6"><div class="card p-3 h-100"><div class="wt-st">경쟁사별 승패</div>
          ${compWinTable()}</div></div>
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
  /* 계정 관리 전용 화면 — 다른 카드(요약·담당자·백업·단계)는 제거됨 */
  renderUsers();
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
    일자: l.date, 고객사: logCustLabel(l), 유형: l.type, 내용: l.content,
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
    일자: s.date, 시간: s.time, 고객사: s.custId || s.prospectId ? schCustLabel(s) : '', 유형: s.type,
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
  idleNotice();                       // 자동 로그아웃으로 돌아왔으면 이유를 알려준다
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

/* ══════════════════════════════════════════════════════════════
   자동 로그아웃 (무조작 30분)
   ul_profiles.idle_exempt = true 인 계정은 제외한다.
   ⚠ 이건 '자리 비움 보호' 지 인증 경계가 아니다.
     브라우저를 열어두고 자바스크립트를 막으면 우회할 수 있고,
     Supabase 세션 토큰 자체는 서버가 정한 만료까지 살아 있다.
     진짜 강제하려면 Supabase 의 JWT/refresh 만료를 줄여야 한다.
   ══════════════════════════════════════════════════════════════ */
const IDLE_LIMIT_MS = 30 * 60 * 1000;   // 30분
const IDLE_WARN_MS  = 60 * 1000;        // 만료 60초 전 경고
const IDLE_TICK_MS  = 10 * 1000;        // 확인 주기
const IDLE_SAVE_MS  = 5 * 1000;         // 활동 기록 최소 간격(과도한 쓰기 방지)
const idleKey = () => 'urolink_last_active';

let IDLE_TIMER = null, IDLE_LAST_WRITE = 0, IDLE_WARNED = false;

const idleExempt = () => !!(ME && ME.idle_exempt);

function idleStamp() {
  try { localStorage.setItem(idleKey(), String(Date.now())); } catch (e) {}
}
function idleRead() {
  try { return num(localStorage.getItem(idleKey())) || Date.now(); }
  catch (e) { return Date.now(); }
}
/* 다른 탭에서의 조작도 활동으로 인정해야 하므로 localStorage 를 공유 기준으로 쓴다 */
function idleTouch() {
  const now = Date.now();
  if (now - IDLE_LAST_WRITE < IDLE_SAVE_MS) return;
  IDLE_LAST_WRITE = now;
  idleStamp();
  if (IDLE_WARNED) { IDLE_WARNED = false; hideIdleWarn(); }
}

function startIdleWatch() {
  stopIdleWatch();
  if (!isRemote() || !ME || idleExempt()) return;
  idleStamp();
  ['mousedown', 'keydown', 'wheel', 'touchstart', 'scroll'].forEach(ev =>
    window.addEventListener(ev, idleTouch, { passive: true, capture: true }));
  document.addEventListener('visibilitychange', onIdleVisible);
  IDLE_TIMER = setInterval(idleCheck, IDLE_TICK_MS);
}
function stopIdleWatch() {
  if (IDLE_TIMER) { clearInterval(IDLE_TIMER); IDLE_TIMER = null; }
  ['mousedown', 'keydown', 'wheel', 'touchstart', 'scroll'].forEach(ev =>
    window.removeEventListener(ev, idleTouch, { capture: true }));
  document.removeEventListener('visibilitychange', onIdleVisible);
  hideIdleWarn();
}
/* 탭을 다시 열었을 때 즉시 판정한다 (백그라운드에서 타이머가 눌려 있을 수 있다) */
function onIdleVisible() { if (!document.hidden) idleCheck(); }

function idleCheck() {
  if (!ME || idleExempt()) { stopIdleWatch(); return; }
  const left = IDLE_LIMIT_MS - (Date.now() - idleRead());
  if (left <= 0) { idleLogout(); return; }
  if (left <= IDLE_WARN_MS) { IDLE_WARNED = true; showIdleWarn(Math.ceil(left / 1000)); }
  else if (IDLE_WARNED) { IDLE_WARNED = false; hideIdleWarn(); }
}

let IDLE_LOGGING_OUT = false;
async function idleLogout() {
  if (IDLE_LOGGING_OUT) return;      // 틱이 겹쳐 두 번 도는 것을 막는다
  IDLE_LOGGING_OUT = true;
  stopIdleWatch();
  ME = null;
  try { localStorage.removeItem(idleKey()); } catch (e) {}
  /* 네트워크가 느려도 화면은 반드시 잠긴다.
     signOut 응답을 무한정 기다리면 로그인 상태로 남아 있게 되므로 3초만 기다린다.
     (토큰은 다음 접속 때 어차피 만료·갱신 검사를 거친다) */
  try {
    await Promise.race([
      SB.auth.signOut(),
      new Promise(r => setTimeout(r, 3000))
    ]);
  } catch (e) {}
  /* 저장은 이미 서버에 끝나 있으므로 다시 로그인하면 그대로 이어서 쓸 수 있다 */
  location.replace(location.pathname + '?to=idle');
}

function showIdleWarn(sec) {
  let el = $('idle-warn');
  if (!el) {
    el = document.createElement('div');
    el.id = 'idle-warn';
    document.body.appendChild(el);
  }
  el.innerHTML = '<i class="bi bi-clock-history"></i>'
    + '<span>오래 조작이 없어 <b>' + sec + '초</b> 뒤 자동 로그아웃됩니다</span>'
    + '<button onclick="idleStay()">계속 사용</button>';
  el.style.display = 'flex';
}
function hideIdleWarn() {
  const el = $('idle-warn');
  if (el) el.style.display = 'none';
}
function idleStay() {
  IDLE_LAST_WRITE = 0;
  idleTouch();
  hideIdleWarn();
}
/* 자동 로그아웃으로 돌아온 경우 로그인 화면에 이유를 알려준다 */
function idleNotice() {
  if (String(location.search || '').indexOf('to=idle') < 0) return;
  lgMsg('30분 동안 조작이 없어 자동 로그아웃되었습니다. 다시 로그인해주세요.');
  try { history.replaceState(null, '', location.pathname); } catch (e) {}
}

async function doLogout() {
  if (!confirm('로그아웃할까요?')) return;
  stopIdleWatch();
  try { localStorage.removeItem(idleKey()); } catch (e) {}
  try { await SB.auth.signOut(); } catch (e) {}
  location.reload();
}
async function afterLogin(session) {
  /* active 를 안 가져오면 아래 차단 검사가 항상 통과해버린다(undefined !== false).
     idle_exempt 는 자동 로그아웃 예외 여부. */
  const { data: p } = await SB.from('ul_profiles')
    .select('id,email,display_name,role,active,idle_exempt').eq('id', session.user.id).maybeSingle();
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
  await syncSalesReps();
  startApp();
  startIdleWatch();
}
/* 부서가 '영업'인 로그인 계정은 담당자 명단에 자동 등록한다.
   딜·고객사·타겟병원·일정 등 '담당 영업' 입력칸이 전부 DB.reps 를 보고 채워지므로,
   여기 한 번만 채워두면 그 화면들에서 바로 선택할 수 있다.
   ⚠ 새로 추가만 한다 — 관리자가 담당자 관리에서 수동으로 꺼둔 사람을 다시 켜지는 않는다. */
async function syncSalesReps() {
  if (!isRemote() || !SB || !DB) return;
  let res;
  try { res = await SB.from('ul_profiles').select('display_name,dept,position,active'); }
  catch (e) { return; }
  if (!res || res.error || !res.data) return;
  let changed = false;
  res.data.forEach(u => {
    if (u.active === false) return;
    if (!/영업/.test(trimv(u.dept))) return;
    const name = trimv(u.display_name);
    if (!name || DB.reps.some(r => r.name === name)) return;
    DB.reps.push({ name, role: trimv(u.position) || trimv(u.dept), salesDept: true });
    changed = true;
  });
  if (changed) save(true);
}
function renderAccountBox() {
  const box = $('account-box'), card = $('sidebar-user');
  if (!box || !card) return;
  if (!isRemote()) {
    card.style.display = 'none';
    box.innerHTML = '<div class="mode-chip local" title="config.js 에 anon key 를 넣으면 서버 공유 모드가 됩니다">'
      + '<i class="bi bi-hdd"></i>이 브라우저에만 저장</div>';
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
/* 보안: 비밀번호 변경 */
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
  if (a !== b) return pwMsg('다시 입력한 비밀번호가 다릅니다.');
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
/* 담당자 관리 — 영업 분석 담당자별 화면에 누구를 보여줄지 고른다.
   끄는 건 화면 표시만 빼는 것이고, 그 사람 이름으로 남은 딜·일정·상담일지는 그대로 있다. */
function renderRepMgmt() {
  const box = $('rep-list');
  if (!box) return;
  const reps = [...DB.reps].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  box.innerHTML = reps.length ? '<div style="overflow-x:auto"><table class="table u-t mb-0">'
    + '<thead><tr><th>이름</th><th>역할</th><th>영업 분석 표시</th><th></th></tr></thead><tbody>'
    + reps.map(r => '<tr><td class="fw-bold">' + esc(r.name) + '</td>'
      + '<td style="font-size:12.5px;color:#64748b">' + esc(r.role || '-') + '</td>'
      + '<td><button class="u-ib' + (r.salesDept !== false ? ' ex' : '') + '" onclick="toggleRepSales(&#39;' + jsq(r.name) + '&#39;)"'
        + ' title="' + (r.salesDept !== false ? '영업 분석에 표시 중 — 눌러서 제외' : '영업 분석에서 제외됨 — 눌러서 표시') + '">'
        + '<i class="bi ' + (r.salesDept !== false ? 'bi-check-circle' : 'bi-slash-circle') + '"></i> '
        + (r.salesDept !== false ? '영업부서' : '비영업') + '</button></td>'
      + '<td class="text-end"><button class="u-ib rd" onclick="deleteRep(&#39;' + jsq(r.name) + '&#39;)" title="담당자 명단에서 삭제">'
        + '<i class="bi bi-trash"></i></button></td></tr>').join('')
    + '</tbody></table></div>'
    : '<div class="p-3" style="color:#94a3b8;font-size:12.5px">등록된 담당자가 없습니다</div>';
}
function toggleRepSales(name) {
  const r = DB.reps.find(x => x.name === name);
  if (!r) return;
  r.salesDept = r.salesDept === false ? true : false;
  save();
  renderRepMgmt();
  if (CUR_PAGE === 'analysis') renderAnalysis();
}
/* 담당자 명단에서 완전히 삭제 — 딜·일정·상담일지에 남은 이름 텍스트는 지우지 않는다(기록 보존).
   지운 뒤에도 그 이름을 담당자로 다시 입력하면 자동으로 재등록된다(resolveRep). */
function deleteRep(name) {
  if (!ensureAdmin()) return;
  if (!DB.reps.some(r => r.name === name)) return;
  if (!confirm(`담당자 '${name}'을(를) 명단에서 삭제할까요?\n이미 이 이름으로 남아있는 딜·일정·상담일지 기록은 지워지지 않습니다.`)) return;
  DB.reps = DB.reps.filter(r => r.name !== name);
  save();
  renderRepMgmt();
  refreshSelects();
  if (CUR_PAGE === 'analysis') renderAnalysis();
}
async function renderUsers() {
  const card = $('usermgmt-card');
  if (!card) return;
  const addBtn = $('add-user-btn');
  const repCard = $('repmgmt-card');
  if (repCard) repCard.style.display = isAdmin() ? 'block' : 'none';
  if (isAdmin()) renderRepMgmt();
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
  /* 이 화면을 볼 때마다 부서가 '영업'으로 바뀐 계정을 담당자 명단에 반영 */
  await syncSalesReps();
  renderRepMgmt();
  refreshSelects();
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
  /* 사람이 늘어날 화면이므로 한 사람 = 한 줄로 고정한다.
     이메일을 이름 아래 두 번째 줄로 깔면 인원수만큼 세로가 두 배로 늘어난다.
     그룹 헤더도 얇은 띠로 줄이고, 버튼은 아이콘만 남긴다. */
  const body = grps.map(g => {
    const list = rows.filter(u => (u.dept || '미지정') === g);
    return '<tr class="u-grp"><td colspan="7"><i class="bi bi-building"></i>' + esc(g)
      + '<span class="cnt">' + list.length + '</span></td></tr>'
      + list.map(u => {
        const me = u.id === (ME && ME.id);
        const off = u.active === false;
        const uid = esc(u.id);
        return '<tr' + (off ? ' class="u-off"' : '') + '>'
          + '<td><div class="u-name">'
            + '<input type="text" class="u-in nm" value="' + esc(u.display_name || '') + '" placeholder="이름"'
            + ' onchange="setUserField(&#39;' + uid + '&#39;,&#39;display_name&#39;,this.value)">'
            + (me ? '<span class="u-badge usr">나</span>' : '')
            + (off ? '<span class="u-badge off">비활성</span>' : '') + '</div></td>'
          + '<td><input type="email" class="u-in em" value="' + esc(u.email || '') + '" placeholder="이메일"'
            + ' autocomplete="off" onchange="setUserEmail(&#39;' + uid + '&#39;,this.value,this)"'
            + ' title="로그인 아이디입니다. 바꾸면 새 주소로 로그인해야 합니다."></td>'
          + '<td><input type="text" class="u-in" list="dl-dept" value="' + esc(u.dept || '') + '" placeholder="부서"'
            + ' onchange="setUserField(&#39;' + uid + '&#39;,&#39;dept&#39;,this.value)"></td>'
          + '<td><input type="text" class="u-in sm" list="dl-pos" value="' + esc(u.position || '') + '" placeholder="직급"'
            + ' onchange="setUserField(&#39;' + uid + '&#39;,&#39;position&#39;,this.value)"></td>'
          + '<td><select class="u-in sel' + (u.role === 'admin' ? ' adm' : '') + '"'
            + (me ? ' disabled title="본인 역할은 바꿀 수 없습니다"' : '')
            + ' onchange="setUserRole(&#39;' + uid + '&#39;,this.value)">'
            + '<option value="user"' + (u.role === 'user' ? ' selected' : '') + '>일반</option>'
            + '<option value="admin"' + (u.role === 'admin' ? ' selected' : '') + '>관리자</option></select></td>'
          + '<td class="u-date">' + fmtDate(u.created_at) + '</td>'
          + '<td class="u-act">'
            + '<button class="u-ib' + (u.idle_exempt ? ' ex' : '') + '" onclick="toggleIdleExempt(&#39;' + uid + '&#39;)"'
              + ' title="' + (u.idle_exempt ? '자동 로그아웃 예외 (제한 없음) — 눌러서 30분 제한 적용'
                                            : '30분 무조작 시 자동 로그아웃 — 눌러서 예외 처리') + '">'
              + '<i class="bi ' + (u.idle_exempt ? 'bi-infinity' : 'bi-clock-history') + '"></i></button>'
            + (me ? '<span class="u-self">본인</span>'
                  : '<button class="u-ib" onclick="openSetPw(&#39;' + uid + '&#39;)" title="비밀번호 직접 변경">'
                    + '<i class="bi bi-key"></i></button>'
                  + '<button class="u-ib' + (off ? ' gr' : '') + '" onclick="setUserActive(&#39;' + uid + '&#39;,'
                    + (off ? 'true' : 'false') + ')" title="' + (off ? '접속 복구' : '접속 차단') + '">'
                    + '<i class="bi ' + (off ? 'bi-arrow-counterclockwise' : 'bi-slash-circle') + '"></i></button>'
                  + '<button class="u-ib rd" onclick="deleteUser(&#39;' + uid + '&#39;)" title="계정 완전 삭제">'
                    + '<i class="bi bi-trash"></i></button>')
          + '</td></tr>';
      }).join('');
  }).join('');
  $('user-list').innerHTML = '<div style="overflow-x:auto"><table class="table u-t mb-0">'
    + '<thead><tr><th>이름</th><th>이메일 (로그인 ID)</th><th>부서</th><th>직급</th>'
    + '<th>역할</th><th>가입일</th><th></th></tr></thead>'
    + '<tbody>' + body + '</tbody></table></div>';
}
/* 이메일은 Supabase 로그인 아이디다.
   ul_profiles 만 고치면 화면엔 새 주소가 보이는데 실제 로그인은 옛 주소로만 되는
   어긋난 상태가 된다. 그래서 auth 계정까지 함께 바꾸는 Edge Function 을 거친다. */
async function setUserEmail(id, v, el) {
  const u = U_ROWS.find(x => x.id === id);
  if (!u) return;
  const next = trimv(v).toLowerCase();
  const prev = trimv(u.email).toLowerCase();
  if (next === prev) return;
  const revert = () => { if (el) el.value = u.email || ''; };
  if (!next) { toast('이메일은 비울 수 없습니다'); revert(); return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next)) { toast('이메일 형식이 올바르지 않습니다'); revert(); return; }
  if (U_ROWS.some(x => x.id !== id && trimv(x.email).toLowerCase() === next)) {
    toast('이미 사용 중인 이메일입니다'); revert(); return;
  }
  const mine = ME && ME.id === id;
  if (!confirm((u.display_name || prev) + ' 님의 로그인 아이디를 바꿉니다.' + NL + NL
    + prev + NL + '  ↓' + NL + next + NL + NL
    + '이제부터 새 주소로 로그인해야 합니다. 비밀번호는 그대로입니다.'
    + (mine ? NL + NL + '⚠ 본인 계정입니다. 변경 후 다시 로그인해야 할 수 있습니다.' : '')
    + NL + NL + '계속할까요?')) { revert(); return; }

  if (el) el.disabled = true;
  const { data, error } = await callAdminFn({ action: 'set_email', id: id, email: next });
  if (el) el.disabled = false;
  if (error) {
    /* 아직 set_email 을 모르는(재배포 전) 함수면 원인을 정확히 알려준다 */
    const msg = /알 수 없는 요청/.test(error)
      ? '이메일 변경 기능이 서버에 아직 배포되지 않았습니다.' + NL
        + 'Supabase → Edge Functions → admin-user 를 edge-admin-user.ts 로 다시 배포해주세요.'
      : error;
    alert('이메일 변경 실패' + NL + NL + msg);
    revert();
    return;
  }
  toast('로그인 아이디를 ' + next + ' 로 변경했습니다');
  if (mine && ME) ME.email = next;
  renderUsers();
}

async function setUserField(id, field, v) {
  const val = trimv(v);
  if (field === 'display_name' && !val) { toast('이름은 비울 수 없습니다'); renderUsers(); return; }
  const upd = {}; upd[field] = val || null;
  const { error } = await SB.from('ul_profiles').update(upd).eq('id', id);
  if (error) { alert('수정 실패: ' + error.message); renderUsers(); return; }
  if (field === 'display_name' && ME && ME.id === id) { ME.display_name = val; renderAccountBox(); }
  toast('수정했습니다');
  renderUsers();
}
/* 자동 로그아웃 예외 켜고 끄기 */
async function toggleIdleExempt(id) {
  const u = U_ROWS.find(x => x.id === id);
  if (!u) return;
  const next = !u.idle_exempt;
  const nm = u.display_name || u.email;
  if (!confirm(next
    ? nm + ' 계정을 자동 로그아웃 예외로 둡니다.' + NL + '자리를 비워도 로그인 상태가 유지됩니다.'
    : nm + ' 계정에 30분 자동 로그아웃을 적용합니다.' + NL + '30분 동안 조작이 없으면 로그아웃됩니다.')) return;
  const { error } = await SB.from('ul_profiles').update({ idle_exempt: next }).eq('id', id);
  if (error) {
    alert(/column .* does not exist|idle_exempt/i.test(error.message || '')
      ? '아직 migration_v4.sql 을 실행하지 않았습니다.' + NL + 'Supabase → SQL Editor 에서 먼저 실행해주세요.'
      : '변경 실패: ' + error.message);
    return;
  }
  /* 본인 설정을 바꿨으면 감시도 즉시 반영 */
  if (ME && ME.id === id) { ME.idle_exempt = next; next ? stopIdleWatch() : startIdleWatch(); }
  toast(nm + ' — ' + (next ? '자동 로그아웃 예외' : '30분 자동 로그아웃 적용'));
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
/* ══ 관리자가 사용자 비밀번호를 직접 변경 ══
   남의 비밀번호 변경은 service_role 키가 필요한 관리자 API 라 브라우저에서 직접 못 한다.
   (그 키를 공개 repo 에 두면 DB 가 통째로 열린다)
   → Edge Function 'admin-user' 가 서버에서 호출자를 검증한 뒤 대신 처리한다. */
let PW_TARGET = null;
function openSetPw(id) {
  const u = U_ROWS.find(x => x.id === id);
  if (!u) return;
  PW_TARGET = u;
  $('sp-who').innerHTML = esc(u.display_name || '-')
    + ' <span style="font-weight:400;color:#64748b">(' + esc(u.email || '') + ')</span>';
  $('sp-pw').value = '';
  spMsg('');
  genSetPw();
  new bootstrap.Modal($('setPwModal')).show();
}
function genSetPw() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ', b = 'abcdefghijkmnpqrstuvwxyz', c = '23456789', d = '!@#$%';
  const pick = (set, k) => Array.from({ length: k },
    (_, i) => set[(Date.now() + i * 7919 + Math.floor(performance.now() * 1000)) % set.length]).join('');
  $('sp-pw').value = pick(A, 2) + pick(b, 5) + pick(c, 3) + pick(d, 1);
}
function spMsg(m, ok) {
  const el = $('sp-msg');
  el.innerHTML = m || '';
  el.style.display = m ? 'block' : 'none';
  el.style.background = ok ? '#f0fdf4' : '#fef2f2';
  el.style.color = ok ? '#15803d' : '#b91c1c';
  el.style.border = '1px solid ' + (ok ? '#bbf7d0' : '#fecaca');
}
async function callAdminFn(body) {
  try {
    const { data, error } = await SB.functions.invoke('admin-user', { body });
    if (error) {
      let msg = error.message || '요청 실패';
      try { const j = await error.context.json(); if (j && j.error) msg = j.error; } catch (e) {}
      if (/not found|404/i.test(msg)) msg = 'Edge Function(admin-user)이 배포되지 않았습니다.';
      return { error: msg };
    }
    if (data && data.error) return { error: data.error };
    return { data };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}
async function doSetPw() {
  if (!PW_TARGET) return;
  const pw = trimv($('sp-pw').value);
  if (pw.length < 8) return spMsg('비밀번호는 8자 이상이어야 합니다.');
  $('sp-btn').disabled = true;
  spMsg('변경 중입니다...', true);
  const r = await callAdminFn({ action: 'set_password', id: PW_TARGET.id, password: pw });
  $('sp-btn').disabled = false;
  if (r.error) return spMsg(esc(r.error));
  spMsg('<b>' + esc(PW_TARGET.display_name || PW_TARGET.email) + '</b> 의 비밀번호를 <b>' + esc(pw)
    + '</b> 로 변경했습니다.<br>본인에게 전달하고 첫 로그인 후 변경하도록 안내해주세요.', true);
}
async function deleteUser(id) {
  const u = U_ROWS.find(x => x.id === id);
  if (!u) return;
  if (!confirm((u.display_name || u.email) + ' 계정을 완전히 삭제할까요?\n\n로그인 계정과 프로필이 지워지고 되돌릴 수 없습니다.\n작성한 딜·일지 기록은 그대로 남습니다.')) return;
  const r = await callAdminFn({ action: 'delete_user', id });
  if (r.error) { alert('삭제 실패: ' + r.error); return; }
  toast('계정을 삭제했습니다');
  renderUsers();
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
