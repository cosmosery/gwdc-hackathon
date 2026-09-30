## 현재 배포와 지갑 지원 범위 (2026-09-30)

- **프론트:** https://settle-payroll-web.vercel.app
- **엔진 API:** https://tron-gasfree-batch-nile-probe.vercel.app
- 배포 사이트의 Connection settings에 엔진 접근 토큰을 입력합니다. 토큰은 해당 탭 메모리에만 유지되며 새로고침 시 다시 입력합니다. 문서·URL·공개 번들에 비밀값을 넣지 않습니다.

### 현재 제공하는 수동 흐름

CSV 업로드·검토 → 견적 → 배치 Vault 주소 생성 → **TronLink 내부 GasFree → Send에서 사용자 수동 송금 승인** → Vault 잔액 확인 → **Start payouts** → 개별 거래 확정·대사.

출금 원천은 사용자의 GasFree 계좌입니다. 연결하는 일반 TRON 주소(EOA)는 GasFree 계좌 소유자 식별용입니다. 웹에서는 PermitTransfer 서명 요청을 하지 않습니다. 수동 입금 확인은 현재 Vault 잔액 검사이므로 **입금 출처가 GasFree인지까지 검증하지 않습니다**. `depositTxId`가 없다는 이유만으로 입금 실패를 뜻하지 않습니다.

Start payouts는 `POST /batches/:batchId/execute`에 `{"mode":"direct"}`와 배치별 `Idempotency-Key`를 보냅니다. `authorization`·`signature`는 포함하지 않습니다. 서버는 실시간 잔액을 확인하고 충분하면 PROCESSING으로 접수해 지급을 실행합니다. 잔액 부족 400은 실행 성공이 아닙니다. `/resume`은 최초 지급 요청을 대체하지 않습니다. 응답 유실·새로고침 후에도 같은 실행 키를 재사용합니다.

### 서드파티 서명을 지원하는 지갑의 연동 흐름

지원 지갑에서는 dApp이 PermitTransfer typed data를 생성 → **사용자가 지갑에서 승인·서명** → dApp이 서명을 수신 → Backend가 GasFree Provider에 제출 → GasFree 계좌에서 Vault로 입금 → 엔진 지급으로 연결할 수 있습니다. 여기서 자동화는 **승인 후 서명 전달·제출·실행의 연결**이며, 사용자 승인 없이 개인키로 자동 서명한다는 뜻이 아닙니다. GasFree 계좌를 통제하는 소유자 EOA가 서명합니다.

GasFree 공식 문서는 이 서명·Provider 제출 구조를 설명합니다: https://docs.gasfree.io/ . 다만 우리 테스트의 TronLink는 `TronLink does not support permit transfer requests from a third party`로 외부 요청을 거절했습니다. **프로토콜 지원과 지갑의 외부 요청 지원은 별개**입니다. 모든 지갑이 불가능하다는 뜻도, 다른 지갑을 이미 검증했다는 뜻도 아닙니다.

현재 배포 프론트는 수동 경로로 고정되어 있습니다. 지원 지갑에서 자동 연동하려면 별도 연결·검증이 필요하며, 지갑만 바꾸면 현재 화면이 자동으로 서명 모드로 전환되지는 않습니다. 백엔드의 기존 signed execute 호환성과 프론트의 현재 제공 기능을 구분합니다.

수동 경로의 fee buffer는 추정 예산이며 PermitTransfer의 강제 `maxFee`가 아닙니다. 실제 수수료는 TronLink 승인 화면에서 확인합니다. 지급 성공은 실행 접수(200)가 아니라 수신자별 확정 상태로 판단합니다.

---

## 최신 수동 입금 계약 반영 (2026-09-30)

이 절이 아래 과거 서명 방식 설명보다 우선합니다.

- CSV 검토 → 견적 → 배치 생성 → TronLink의 GasFree → Send에서 수동 입금 → 입금 확인 → Start payouts.
- 프론트는 PermitTransfer 서명이나 signing-context를 요청하지 않습니다. 지갑 연결은 소유자 주소 확인에만 사용합니다.
- Start payouts는 `POST /batches/:batchId/execute`에 `{"mode":"direct"}`를 전송합니다. authorization/signature 필드는 보내지 않습니다.
- 로컬 BFF는 서버 Bearer 인증을 붙입니다. Vercel 프론트는 사용자가 연결 설정에 입력한 토큰을 메모리에만 유지하고 고정 엔진 주소로 전달합니다. 두 경로 모두 Idempotency-Key를 전달합니다. 배치별 키를 브라우저 localStorage에 보관해 새로고침·응답 유실 후에도 같은 키를 사용합니다.
- `/resume`은 최초 지급 트리거로 사용하지 않습니다. `/execute-direct` 대체 호출도 하지 않습니다.
- 서버가 실제 잔액을 검증합니다. 400 부족 오류나 응답 유실을 성공으로 표시하지 않습니다. 200 PROCESSING은 실행 접수이며 개별 송금 성공은 이후 조회 결과로만 표시합니다.
- 서버의 `/retry` 개선은 별도의 복구 계약이며 이번 변경에서 자동 재시도를 추가하지 않았습니다.
- 수동 송금의 실제 수수료는 TronLink에서 확인합니다. 화면의 버퍼는 강제되는 서명 상한이 아닙니다.

---

# Settle 현재 통합 상태 — 2026-09-30


이 문서가 현재 사용자 흐름의 기준이다. 기존 E2E·시나리오 보고서는 해당 시점의 이력이며 현재 원격 배포 검증과 구분한다.

## 사용자 흐름

기존 Nile GasFree 계정에 USDT 보유 → CSV 가져오기·검토 → TronLink로 소유자 연결·견적 → 배치 전용 볼트 주소 준비 → TronLink의 GasFree → Send에서 직접 입금 승인 → 입금 확인 → 사용자가 엔진 지급 시작 요청 → 지급·대사 결과.

- 일반 지갑 주소는 GasFree 소유자 식별용이며 GasFree 계정 주소와 다르다.
- 볼트 주소는 CREATE2로 미리 계산한다. 주소 생성이 계약 배포 완료를 의미하지 않는다.
- 현재 TronLink에서 제3자 PermitTransfer 서명이 차단되어 수동 GasFree 송금 경로를 사용한다. 버튼 하나로 GasFree 승인창이 열린다고 주장하지 않는다.
- API 응답에 GasFree 계정 잔액이 없으므로 잔액 검증 완료를 표시하지 않는다.
- 수수료 버퍼는 추정치의 두 배다. 수동 송금에서는 maxFee를 강제하지 못하며 TronLink에서 실제 비용을 확인한다. 운영자 TRX 비용과 고객 USDT 비용은 별도다.
- 입금 자체가 지급 시작을 보장하지 않는다. funding 확인 후 `/resume` 요청을 사용한다.

## 프론트

- React/TypeScript, CSV 실데이터 파싱·검증·수정·제외·경고 확인, 정확한 정수 단위 합산.
- CSV review는 실제 규칙 검사 결과와 금액 차이·중복·메모 근거를 표시한다. 외부 AI 모델 호출은 구현되지 않았다.
- 가져오기로 성공 결과를 만들지 않는다. 지급 결과는 엔진 응답에서만 표시한다.
- 배치 상태는 3초, 입금 대기 잔액은 5초 간격으로 조회한다. 폴링은 서명·송금을 수행하지 않는다.
- 소액 테스트 제한: 1–20행, 행당 최대 1 USDT, 원금 합계 최대 10 USDT.

## 실행 및 보안

```sh
npm ci
npm --prefix web ci
npm run dev:web
```

루트 `.env`와 선택적 `.env.frontend.local`에서 `ENGINE_API_URL` 및 `API_BEARER_TOKEN`을 설정한다. 현재 원격 주소는 `https://tron-gasfree-batch-nile-probe.vercel.app`. 비밀값은 커밋하거나 VITE 변수로 노출하지 않는다. 프론트 5173, 로컬 API 브리지 3478. 로컬 브리지는 공개 서비스용 사용자/tenant 인증을 대체하지 않는다.

## 원격 저장 일관성 재검증

- 시각: 2026-09-30T01:23:51.885Z
- 배치: `b_1790731423864_e9cb9341`
- 생성 201; 상세 순차 6회 + 상세/수신자/진행률 병렬 24회 모두 200, ID 또는 수신자 수 일치.
- 진단 원금 0.01 USDT의 미입금 배치만 생성했다. 서명·입금·배포·지급은 실행하지 않았다.
- 이전의 동일 배치 200/404 혼재는 이번 검사에서 재현되지 않았다.
- 서버 재시작, 재배포, 콜드 스타트 후 영속성은 이 검사만으로 보장할 수 없다. 실제 배포의 DB 변경 구현은 별도 확인이 필요하다.

## Git 통합 및 검증

원격 `1e0c907`의 대시보드와 `4ba991a`의 상태 이력·대사 변경을 로컬 프론트·엔진 개선과 병합했다.

- 중복 `/progress` 등록을 단일 경로로 통합했다. stages/evidence와 succeeded/inFlight 호환 필드를 제공하며 근거 없는 actualFeesTotal은 null이다.
- status_events와 batch_transactions를 모두 유지한다. 대사 증거가 없는 값을 합성하지 않는다.
- 공개 대시보드 HTML에 서버 Bearer를 삽입하는 코드를 제거했다. SSE query-token 허용은 명시적 환경 설정이 필요하다. 현재 원격 홈페이지에 설정된 Bearer가 포함되지 않은 것도 확인했다.
- 엔진 87, 계약 11, 복구·Provider·SSE·수수료·브리지 30, 프론트 33, 병합 회귀 1: 총 162개 통과. 프론트 production build 통과.
- 원격 진단 배치는 수분 뒤 추가 조회에서도 200/READY였다. 재시작 검증은 수행하지 않았다.
- `artifacts/`의 기존 스크린샷·거래 진단 원본은 이번 소스 커밋에 포함하지 않는다. 과거 문서의 해당 경로는 로컬 자료를 가리킨다.

## 남은 과제

공유 영속 저장소 운영 검증, 서버리스 환경의 지속 작업 실행 보장, GasFree 잔액 API 계약, 공개 서비스 인증, 외부 AI 모델 연동. 실제 고객 지급 전 배포 환경에서 별도의 자금 이동 E2E가 필요하다.
