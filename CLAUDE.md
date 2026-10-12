# UroLink CRM — 작업 규칙 (Claude Code 전용)

이 파일은 Claude Code 가 자동으로 읽습니다. 아래 규칙을 반드시 지키세요.

## 이 프로젝트가 무엇인가
비뇨의학과 의료기기 유통사 **유로링크**의 영업관리 CRM.
빌드 도구 없는 정적 사이트(HTML + CSS + JS 3파일) + Supabase(DB·로그인).

- 라이브: **https://urolink.github.io/CRM-System/**
- repo: `urolink/CRM-System`

## ⚠ 배포 브랜치는 `main` 이 아니라 `crm` 이다
GitHub Pages 가 **`crm` 브랜치**를 배포합니다.
`main` 에는 지금 쓰지 않는 옛 Next.js 앱이 남아 있으니 **절대 건드리지 마세요.**

```bash
git push origin HEAD:crm      # 배포는 항상 이렇게
```

`git push` 만 치면 main 으로 갈 수 있습니다. 반드시 `HEAD:crm` 을 붙이세요.

## ⚠ 배포할 때 버전 3곳을 반드시 같이 올린다
안 올리면 사용자 브라우저가 옛 파일을 계속 씁니다(캐시).

| 파일 | 고칠 곳 |
|---|---|
| `index.html` | `?v=` 3군데 (app.css, config.js, app.js) |
| `app.js` | `const APP_VERSION = '...'` |
| `version.json` | `{ "version": "..." }` |

형식은 `YYYYMMDD` + 알파벳 한 자 (예: `20260731a`, 같은 날 두 번째면 `20260731b`).
세 곳이 모두 같아야 하고, 다르면 새 버전 알림이 계속 뜨거나 반영이 안 됩니다.

## ⚠ 절대 하지 말 것
- **`service_role` / `sb_secret_` 키를 코드에 넣지 마세요.** 이 repo 는 공개입니다.
  그 키는 보안 규칙(RLS)을 전부 우회하므로 DB 가 통째로 열립니다.
  `config.js` 에는 공개용 `sb_publishable_` 키만 들어갑니다.
- Supabase 로그인 설정(`Allow new users to sign up` 켬 / `Confirm email` 끔)을 바꾸지 마세요.
  계정 발급 기능이 멈춥니다.
- `ul_invites` 허용목록 테이블·트리거를 지우지 마세요.
  이게 없으면 **아무나 가입해서 전 데이터를 봅니다.**
- 데이터를 지우는 SQL(`delete`, `truncate`, `drop`)은 실행 전에 사람에게 확인받으세요.
  Supabase 무료 플랜은 **자동 백업이 없어 복구가 불가능**합니다.

## 파일 구조
```
index.html      화면 마크업 — 사이드바, 11개 페이지, 모달 전부
app.css         디자인 시스템 (원텍 한국영업 문서형 테마 이식)
app.js          전부. 아래 섹션 주석으로 나뉘어 있음
config.js       Supabase 주소 + 공개 키
version.json    자동 최신화용 버전
migration.sql   Supabase 초기 스키마 (이미 실행됨)
migration_v2.sql 계정 발급용 추가 스키마 (이미 실행됨)
edge-admin-user.ts  비밀번호 변경·계정 삭제용 서버 함수 (이미 배포됨)
.github/workflows/keep-supabase-awake.yml  Supabase 자동 일시정지 방지 (아래 참고)
```

## Supabase 자동 일시정지 방지 (지우지 말 것)
Supabase **무료 플랜은 7일 동안 활동이 없으면 프로젝트가 자동 일시정지**되어 로그인·데이터가
전부 안 된다(2026-10에 연차관리 프로젝트가 실제로 이렇게 멈춤). 이를 막으려고
`.github/workflows/keep-supabase-awake.yml` 이 **매일 09:23(KST)** 에 DB를 한 번 조회한다.

- 조회 대상은 `ul_customers` (`/rest/v1/ul_customers?select=id&limit=1`). RLS 때문에 빈 목록
  `[]` 이 와도 **HTTP 200 이면 정상**이다. 200 이 아니면 작업이 실패해 GitHub 가 실패 메일을 보낸다
  (= 이미 정지됐다는 신호 → Supabase 대시보드에서 Resume).
- 쓰는 키는 `config.js` 의 publishable 키와 같다(공개 키라 비밀값 아님). service_role 키는 절대 쓰지 말 것.
- ⚠ **스케줄 실행은 저장소 기본 브랜치(`crm`)의 파일만 동작**한다. 기본 브랜치를 바꾸면 이 파일도
  옮겨야 한다. 이 파일을 만지거나 `ul_customers` 테이블 이름을 바꾸면 워크플로도 같이 고칠 것.
- GitHub 는 저장소에 **60일 넘게 커밋이 없으면 스케줄을 자동으로 끈다.** 그때는 Actions 탭 →
  "Keep Supabase awake" → **Enable workflow** 를 한 번 누르면 된다.
- 수동 실행(테스트): Actions 탭 → Keep Supabase awake → Run workflow.
- 연차관리(PTO-System) 저장소에도 같은 워크플로가 있다(그쪽 기본 브랜치는 `main`).

`app.js` 섹션 순서: 상수 → 유틸 → 데이터계층(로컬/서버 분기·diff 동기화) → 시드 →
라우팅 → 현황판 → 종합·매출믹스 → 수주관리 → 일정 → 견적서 → 고객사 → 장비 →
제품 → 영업분석 → 사용자관리 → 초기화

## 로컬에서 확인하는 방법
`file://` 로 열면 로그인이 동작하지 않습니다. 반드시 로컬 서버로 띄우세요.

```bash
python -m http.server 8795
```

그리고 http://localhost:8795 접속. (파이썬이 없으면 `npx serve -l 8795`)

## 데이터 모델 요령
- 저장은 `localStorage`(config 키가 비었을 때) 또는 Supabase(키가 있을 때) 자동 분기.
- Supabase 테이블은 `ul_*` 이고 구조가 **`id` + `data`(jsonb)** 입니다.
  → **필드를 추가해도 SQL 마이그레이션이 필요 없습니다.** 그냥 JS 객체에 넣으면 됩니다.
- 저장은 `save()` 하나만 호출하면 됩니다. 바뀐 행만 골라 서버에 올립니다(diff).
- 매출 = `stage: '계약완료'` 인 딜. 종합·매출믹스·영업분석이 모두 이걸 집계합니다.
- **방문 결과의 '소통 담당자 연락처'는 필수입니다** (`contactPersons: [{role,name,phone,memo}]`).
  병원 **대표번호가 아니라** 실제로 소통한 사람(원장·상담실장 등)의 직통·휴대전화를 받습니다.
  일정(`s-contacts`)·방문일지(`l-contacts`)가 같은 입력 UI(`renderContacts`/`readContacts`)와
  같은 검사(`validateVisitContacts`)를 씁니다. 일정은 **결과를 적을 때**(내부 일정 제외),
  방문일지는 **항상** 필수이고, 병원에 등록된 대표번호와 같은 번호는 막습니다.
  `hospitalContact`(글)는 예전 기록·보고서 호환용으로 담당자 이름을 모아 자동으로 채웁니다.
  검사는 `resolveCust` 로 고객사를 새로 만들기 **전에** 해야 합니다(실패했는데 쓰레기 고객사가 남음).
  저장되면 `syncVisitContacts()` 가 그 담당자를 **고객사(타겟병원) `contacts` 명단에도 자동 추가**합니다.
  이미 있는 번호는 건너뛰고(`ctPhoneKey` — 숫자만, 내선 제외), 기록에 `ctSynced: true` 를 남겨
  다음 저장 때는 "그때 이미 반영한 담당자"를 다시 넣지 않습니다(명단에서 일부러 지운 사람이 되살아나지 않게).
  일정은 필수 검사를 거친 경우(결과 입력·내부 제외)에만 반영합니다.

### ⚠ 아직 실행하지 않은 SQL이 있습니다
- `migration_v3.sql` — **목표(ul_targets)** 와 **변경이력(ul_audits)** 테이블을 만듭니다. (실행 여부 미확인)
- `migration_v6.sql` — **고객사·딜·상담일지·견적서·장비·일정의 삭제 권한**을
  관리자 전용에서 "관리자 또는 작성자 본인"으로 완화합니다.
  ⚠ **화면(app.js)은 이미 작성자 본인에게 삭제 버튼을 보여주도록 되어 있습니다.**
  이 SQL 을 실행하기 전까지는 서버(RLS)가 여전히 관리자만 허용하므로,
  작성자가 삭제를 눌러도 서버에서 거부되고 새로고침하면 다시 나타납니다.
  반드시 화면 배포와 같이(또는 먼저) 실행하세요.

(`migration_v4.sql` 타겟병원, `migration_v5.sql` 자동 로그아웃 예외는 실행 완료됨.)

Supabase → SQL Editor 에 붙여넣고 1회씩 실행하세요.

실행 전까지는 목표·변경이력이 **그 브라우저에만** 저장되고 다른 사람과 공유되지 않습니다.
(앱은 정상 동작합니다. 없는 테이블은 `OPTIONAL_TABLES` 로 처리해 로딩을 막지 않습니다.)
새 테이블을 또 추가할 일이 생기면 `TABLES` 에 넣고 같은 방식으로 선택적 처리를 하세요.

## 코드 수정 시 주의
- 화면에 사용자 입력을 넣을 때는 **반드시 `esc()`** 로 감싸세요 (XSS 방지).
- 삭제 기능에는 `ensureAdmin()` 을 먼저 호출하세요 (관리자만).
- 문자열을 유니코드 이스케이프(`\uXXXX`)로 만들지 마세요. 한글 오타가 납니다. 한글은 그대로 쓰세요.
  같은 이유로 `onclick` 안의 따옴표는 `&#39;`, 줄바꿈은 `NL` 상수, 따옴표는 `Q` 상수를 쓰세요.
- **`onclick` 안의 JS 문자열에는 `esc()` 가 아니라 `jsq()` 를 쓰세요.**
  `esc()` 는 `'` 를 `&#39;` 로 바꾸는데 브라우저가 속성을 파싱할 때 다시 `'` 로 되돌립니다.
  담당자·경쟁사·태그처럼 사용자가 입력하는 값이면 거기서 문자열이 끊겨 코드가 실행됩니다.
  (화면에 그냥 보여줄 때는 `esc()` 가 맞습니다)
- **새 테이블 SQL 을 쓸 때 RLS 는 `ul_is_active()` 를 겁니다.**
  `using (true)` 로 두면 차단(active=false)된 계정이 그 테이블만 읽고 쓸 수 있습니다.
- 단계·상태 같은 상수를 지울 때는 기존 데이터 이관 코드를 `fixShape()` 에 넣으세요.
  (안 넣으면 그 값을 가진 데이터가 화면에서 사라집니다)
- **`resolveCust` / `resolveRep` 는 없는 이름이면 새로 만듭니다.**
  조회 목적이라면 절대 쓰지 말고 `findCust()` 같은 조회 전용 함수를 쓰세요.
  (입력 중 조회에 쓰면 타이핑 글자마다 쓰레기 고객사가 생깁니다)
- **제품/장비는 자유 입력이 아니라 `<select>`로 등록된 것만 고릅니다.** (`resolveProd`는 삭제됨)
  딜·매출·견적·상담일지·일정·타겟병원·장비등록의 제품칸은 전부 `DB.products` 목록에서만 고르고,
  값은 제품 코드(`prodByCode()`로 조회)입니다. 새 제품은 반드시 **제품** 페이지에서 먼저 등록해야
  다른 화면의 select에 나타납니다. 이 목록을 채우는 곳은 `refreshSelects()`의 `fillProductSelect()`입니다.
- `renderAnalysis` 가 넘기는 `a`, `b` 는 **날짜 문자열**(`'2026-01-01'`)입니다. 월 번호가 아닙니다.
  월이 필요하면 `num(String(a).slice(5,7))` 로 변환하세요.
- 여백이 크게 남는 밴드는 히어로의 flex 를 줄이지 마세요. 여백이 컬럼 안쪽으로 옮겨갈 뿐입니다.
  `.ov-band` 처럼 **그리드로 컬럼이 폭을 나눠 갖게** 하거나 지표를 더 채우세요.

## 배포 전 체크리스트
1. `node --check app.js` — 문법 오류 1개면 사이트 전체가 백지가 됩니다.
2. 로컬 서버로 띄워 바꾼 화면 + 관련 화면 확인.
3. 버전 3곳 올리기.
4. `git add -A && git commit` → `git push origin HEAD:crm`
5. 1~3분 뒤 https://urolink.github.io/CRM-System/version.json 이 새 버전인지 확인.
