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
```

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

## 코드 수정 시 주의
- 화면에 사용자 입력을 넣을 때는 **반드시 `esc()`** 로 감싸세요 (XSS 방지).
- 삭제 기능에는 `ensureAdmin()` 을 먼저 호출하세요 (관리자만).
- 문자열을 유니코드 이스케이프(`\uXXXX`)로 만들지 마세요. 한글 오타가 납니다. 한글은 그대로 쓰세요.
- 단계·상태 같은 상수를 지울 때는 기존 데이터 이관 코드를 `fixShape()` 에 넣으세요.
  (안 넣으면 그 값을 가진 데이터가 화면에서 사라집니다)

## 배포 전 체크리스트
1. `node --check app.js` — 문법 오류 1개면 사이트 전체가 백지가 됩니다.
2. 로컬 서버로 띄워 바꾼 화면 + 관련 화면 확인.
3. 버전 3곳 올리기.
4. `git add -A && git commit` → `git push origin HEAD:crm`
5. 1~3분 뒤 https://urolink.github.io/CRM-System/version.json 이 새 버전인지 확인.
