# UroLink CRM

비뇨의학과 의료기기 유통·판매 영업을 위한 CRM. 백엔드 없이 **브라우저 단독**으로 동작합니다.
원텍 한국영업 사이트의 문서형 대시보드 디자인 언어를 기준으로 제작했습니다.

## 실행

로컬 파일을 그대로 열거나(`index.html` 더블클릭), GitHub Pages에 올려서 접속합니다.
별도 설치·빌드·서버가 필요 없습니다.

## 화면 구성

| 메뉴 | 내용 |
|---|---|
| 종합 현황 | 확정 수주·파이프라인·확률가중 예상·성공률, 월별 실적 차트, 단계 퍼널, 매출 전망 바, 다음 액션 보드, 관리 필요 알림 |
| 영업 분석 | 담당자별 / 제품별 / 지역별 / 전환율 4개 탭 (기간 필터: 연간·분기·월) |
| 수주관리 | 칸반 파이프라인(드래그로 단계 변경), 목록, 상담일지, 딜 상세 드로어 |
| 일정 | 월간 달력, 오늘 일정, 결과 미입력(지난 일정) 추적 |
| 견적서 | 품목·수량·할인 자동 계산, VAT 별도 표기, A4 인쇄 출력 |
| 고객사 | 등급·지역·담당자·태그 필터, 상세 모달(기본정보/딜/보유장비/견적/활동 타임라인) |
| 장비 · A/S | 설치 장비(Installed Base), 보증만료 추적(90일 내 / 만료), A/S 이력 |
| 제품 | 장비·소모품·액세서리·서비스 카탈로그 |
| 설정 · 데이터 | 담당자 관리, JSON 백업/복원, 전체 엑셀 내보내기, 초기화 |

- 단축키: `Ctrl/⌘ + K` 통합 검색, `ESC` 닫기
- 모바일: 햄버거 메뉴 + 하단 탭바
- 우하단 `PDF` 버튼으로 현재 화면 인쇄/PDF 저장

## 데이터 저장 — 두 가지 모드

`config.js`의 `SUPABASE_KEY` 값에 따라 자동으로 갈립니다.

| | localStorage 모드 | 서버 공유 모드 |
|---|---|---|
| 조건 | `SUPABASE_KEY`가 빈 값 | `SUPABASE_KEY`가 채워짐 |
| 로그인 | 없음 | 필수 (관리자 발급 계정) |
| 데이터 | 이 브라우저에만 | 전원이 같은 데이터 공유 |
| 삭제 권한 | 제한 없음 | 관리자만 |

### 서버 공유 모드 켜기

1. **테이블 생성** — Supabase 대시보드 → SQL Editor에 `migration.sql` 전체를 붙여넣고 실행
2. **자유 회원가입 차단** — Authentication → Sign In / Providers → Email
   - `Allow new users to sign up` **끄기** ← repo가 공개면 필수
   - `Confirm email` 끄기
3. **계정 발급** — Authentication → Users → Add user (Auto Confirm User 체크)
   → `ul_profiles` 행이 트리거로 자동 생성됩니다
4. **첫 관리자 지정** — SQL Editor에서
   `update ul_profiles set role = 'admin' where email = '본인이메일';`
5. **키 입력** — Settings → API Keys의 `anon` / `publishable` 값을 `config.js`에 붙여넣기

이후 이름·역할 변경은 앱 안에서 **설정 · 데이터 → 사용자 · 접속 권한**으로 합니다.

### 동기화 방식

저장할 때 전체를 덮어쓰지 않습니다. 마지막 동기화 시점의 사본과 비교해 **바뀐 행만 upsert,
없어진 행만 delete** 하므로, 두 사람이 서로 다른 건을 동시에 고쳐도 상대 데이터가 날아가지 않습니다.
서버 저장이 실패하면(권한·네트워크) 로컬 사본은 유지되고 **다음 저장에서 자동 재시도**합니다.
남이 바꾼 내용은 사이드바 **새로고침** 또는 탭으로 돌아올 때 자동으로 반영됩니다.

### 보안 유의사항

anon key는 공개되어도 되는 키지만, 그렇기 때문에 **RLS가 데이터를 지키는 유일한 장치**입니다.
- `service_role`(secret) 키는 절대 `config.js`에 넣지 마세요. RLS를 전부 우회합니다.
- repo를 공개로 두려면 위 2번(자유 회원가입 차단)을 반드시 적용하세요.
  안 하면 누구나 가입해서 전 데이터를 열람·수정할 수 있습니다.

### 백업

두 모드 모두 **설정 · 데이터 → JSON 내보내기**로 전체를 파일로 받을 수 있습니다.
서버 모드에서도 무료 플랜은 자동 백업이 없으니, 주기적으로 내려받아 두세요.

### 데이터 구조

```
customers  고객사    id, name, type, doctor, dept, grade, sido, gugun, rep, phone, addr, tags[], memo
deals      딜        id, custId, productCode, product, qty, amount, stage, prob, rep,
                     expectedDate, nextAction, nextActionDate, memo, closedAt
logs       상담일지  id, custId, date, type, content, interest, nextAction, rep
quotes     견적서    id, no, custId, date, validDays, rep, items[{code,name,qty,price,disc}], status, memo
equipments 장비      id, custId, modelCode, model, serial, installDate, warrantyEnd,
                     status, contract, rep, as[{date,type,content,engineer}]
products   제품      code, name, cat, price, unit, warranty, memo
schedules  일정      id, date, time, custId, type, title, rep, done, result
reps       담당자    name, role
```

파이프라인 단계와 기본 확률은 `app.js`의 `STAGES` 상수에서 수정합니다.
(리드발굴 10% → 상담중 25% → 데모/시연 45% → 견적발송 60% → 협의중 80% → 계약완료 100% / 실주 0%)

## 샘플 데이터

처음 열면 **가상의** 샘플 데이터(고객사 14곳, 딜 20건, 제품 13종 등)가 들어갑니다.
상단 노란 배너의 **샘플 데이터 삭제** 버튼으로 지우고 실제 데이터를 입력하세요.
담당자·제품 카탈로그만 남기는 선택지도 제공됩니다.

샘플에 쓰인 고객사명·제품명·담당자명은 전부 가상이며 실제 병원·제품과 무관합니다.

## 파일

```
index.html     마크업 (로그인 · 사이드바 · 페이지 · 모달)
app.css        디자인 시스템
app.js         데이터 계층 + 렌더링 + 이벤트
config.js      Supabase 접속 설정 (여기만 고치면 모드가 바뀝니다)
migration.sql  Supabase 테이블 · RLS · 트리거 (1회 실행)
```

CDN: Bootstrap 5.3, Bootstrap Icons 1.11, Chart.js 4.4, SheetJS(xlsx) 0.18 — 인터넷 연결이 필요합니다.
