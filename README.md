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

## 데이터 저장

`localStorage` 키 **`urolink_crm_v1`** 하나에 전부 JSON으로 저장됩니다.

> **중요:** 데이터는 접속한 브라우저에만 남습니다. 다른 PC·다른 브라우저와 공유되지 않고,
> 브라우저 데이터를 지우면 함께 사라집니다. **설정 · 데이터 → JSON 내보내기**로 주기적으로
> 백업하세요. 여러 명이 같은 데이터를 함께 쓰려면 Supabase 같은 백엔드로 옮겨야 합니다.

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
index.html   마크업 (사이드바 · 페이지 · 모달)
app.css      디자인 시스템
app.js       데이터 계층 + 렌더링 + 이벤트
```

CDN: Bootstrap 5.3, Bootstrap Icons 1.11, Chart.js 4.4, SheetJS(xlsx) 0.18 — 인터넷 연결이 필요합니다.
