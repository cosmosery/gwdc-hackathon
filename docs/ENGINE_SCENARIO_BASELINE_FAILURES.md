# 엔진 시나리오 검증 보고서

기준: 원격 엔진 커밋 `a3cae8b`, 2026-09-29 로컬 실행. 제품 코드의 기대 동작을 기준으로 검사했으며 발견된 결함은 이번 검증에서 수정하지 않았다. 테스트 실패는 의도적으로 유지한다.

## 결과

| 실행 계층 | 전체 | 통과 | 실패 |
|---|---:|---:|---:|
| 실제 서버·SQLite·서명 / 외부 경계 장애 주입 | 72 | 59 | 13 |
| 실제 Solidity / 임시 Ganache EVM | 11 | 10 | 1 |
| 합계 | 83 | 69 | 14 |

## 검증 범위와 한계

서버 통합 검사는 실제 Fastify 경로, 메모리 SQLite, TIP-712 서명 생성·검증, Merkle 생성, 상태 전이와 복구 로직을 실행한다. GasFree/체인 호출 경계만 테스트 대역으로 바꾸며, 외부 HTTP 요청은 차단한다. 실제 자금·기존 DB·기존 서버에는 접근하지 않는다. 정상 흐름은 배치 생성 → 서명 → Provider 제출 → 지급 → 조회 → 대사까지 실행했다.

컨트랙트 검사는 저장소 Solidity를 컴파일해 임시 EVM에 실제 배포하고 실행한다. TRON TVM, 실제 Provider 장애, 네트워크 최종성, 실제 Energy/수수료를 검증한 것은 아니다. 회귀 검사에서 쓰는 공개 테스트 개인키에는 자금을 보내지 않는다.

이 테스트는 아래 83개 시나리오를 검증한 것이며 모든 가능한 입력·장애를 증명하는 형식 검증은 아니다. SSE 전송, 다중 프로세스 경합, 실제 디스크 crash 시점, 악성 토큰 재진입, 지갑 UI와 실제 Nile 종단간 송금은 별도 검증이 남는다. 재시작 테스트는 같은 SQLite 인스턴스로 서버를 다시 구성해 시작 복구 훅을 검증한다.

## 우선 해결할 실패

| 우선순위 | 재현 | 현재 결과 | 기대 동작 / 근거 위치 |
|---|---|---|---|
| P0 | 미배포 CREATE2 예상 주소에 300 단위 입금 → 만료 → 배포·환불 | `execution reverted: "expired"`, 현재 경로로 회수 불가 | `contracts/BatchExecutor.sol:35`; 지급은 만료 후 차단하되 고정 환불 주소로 회수 가능한 배포/회수 설계 필요. 주소 계산에 expiry가 포함되므로 단순 연장은 해결책이 아님 |
| P1 | 개별 retry, 기존 tx 조회 결과 `{}` | 새 지급 호출 1회 | `src/server.cjs:702`; 조회 불명은 대기·대사로 유지 |
| P1 | 개별 retry, paid bitmap 조회 오류 | 미지급으로 취급하고 전송 | `src/server.cjs:670`; 조회 실패는 unpaid 증거가 아님 |
| P1 | 개별 retry, 전송 후 timeout | FAILED 확정 | `src/server.cjs:772`; txId 보존하고 불확실 상태 유지 |
| P1 | 동일 행 동시 retry 두 건 | 지급 전송 함수 2회 진입 | `src/server.cjs:743`; 행별 DB claim 및 batch worker와 조정 필요. 실제 두 번 지급됐다는 뜻은 아님: 컨트랙트 bitmap이 중복 지급을 막아도 불필요한 tx/비용은 발생 가능 |
| P1 | 환불 전송 이후 잔액 0, receipt SUCCESS | refund_state가 SUBMITTED에 머묾 | `src/server.cjs:532`; EMPTY 반환 전에 기존 환불 receipt 대사 |
| P1 | DB 지급 완료, 체인 paidAmount=0 또는 RPC 실패 | FINAL 반환 (2개 테스트) | `src/reconciler.cjs:70`; 0을 유효 값으로 처리하고 증빙 없으면 FINAL 금지 |
| P1 | Provider에 estimatedTotalFee만 존재 | actualFeesTotal에 그대로 사용 | `src/reconciler.cjs:49`; 실제 fee 부재는 null/unknown 및 source 표시 |
| P2 | 실제 수수료 300001을 2행 배분 | 합 300000, 1단위 유실 | `src/reconciler.cjs:96`; 잔여 배분 규칙과 전체 합 불변조건 필요 |
| P1 정책 | 릴레이어 OUT_OF_ENERGY | USER_ACTION / TOP_UP_TRX | `src/failureCatalog.cjs:25`; 고객 재결제 없이 운영자가 복구하는 합의와 충돌 |
| P1 정책 | 방송 후 네트워크 timeout | RETRY_PAYOUT 안내 | `src/failureCatalog.cjs:55`; 자동 재전송보다 기존 요청 대사 우선 |
| P2 | payments=[null]로 quote/create 요청 | 500 (2개 테스트) | `src/server.cjs:119,185`; 잘못된 행 입력은 400 |

실패한 테스트 수와 독립 결함 수는 같지 않다. 정책 2건은 기술적 crash가 아니라 합의된 제품 동작과의 불일치다. 대사 API의 actualDecrease가 독립적인 잔액 증빙 없이 계산되는 구조도 별도 정정해야 한다.

## 통과한 핵심 경로

- 0/음수/소수/지수/안전하지 않은 JS 숫자/uint256 초과/주소/행수 검증, 활성·비활성 계정 견적, Provider 장애 시 503.
- receiver/value/token/provider/deadline/version/nonce/maxFee/서명 변조·계정 잔액 검사.
- 같은 요청 중복 제출 차단, 다른 요청과 idempotency 충돌, 동시 배치 실행 단일 제출.
- Provider 실패·응답 유실·traceId 누락·성공 후 미입금, 실제 입금 확인 후 지급.
- 전체 성공·부분 실패·전체 실패, 배포 실패, chain-confirmed 행 건너뛰기.
- 배치 worker의 방송 후 timeout 처리, 재개 경합 방지, 시작 복구와 DB transaction rollback.
- 환불 만료/전체 지급 조건, 초과 입금 반환, 원래 환불 주소 보호, 이미 전송한 환불의 중복 방지.
- 로컬 체인의 입금 게이트, proof 변조, 중복 지급 방지, 지급 후 정확한 잔액 차이, 만료 후 지급 거절.

## 재현 명령

```sh
npm run test:engine:scenarios
npm run test:contract:scenarios
```

두 명령 모두 현재 실패를 발견하므로 종료 코드 1을 반환한다. 외부 키나 `.env`가 필요 없다. 원시 결과: `artifacts/engine-scenarios.json`, `artifacts/contract-scenarios.json`. 일반 `npm test`는 특정 Nile 주소에 의존하고 실제 재시도 경로를 포함하므로 이 격리 테스트를 대체할 수 없다.

## 전체 시나리오

### Isolated engine integration; real API/DB/signatures, simulated external boundaries; no on-chain transfer

| # | 시나리오 | 결과 |
|---:|---|---|
| 1 | auth: missing bearer rejected | PASS |
| 2 | quote: active account exact units | PASS |
| 3 | quote: inactive account activation fee included | PASS |
| 4 | quote rejects zero | PASS |
| 5 | quote rejects negative | PASS |
| 6 | quote rejects fraction | PASS |
| 7 | quote rejects exponent | PASS |
| 8 | quote rejects unsafe-number | PASS |
| 9 | quote rejects uint256-overflow | PASS |
| 10 | quote rejects empty list | PASS |
| 11 | quote rejects 1001 rows | PASS |
| 12 | quote accepts 1000 rows | PASS |
| 13 | quote rejects invalid address | PASS |
| 14 | quote: provider outage returns 503, no invented estimate | PASS |
| 15 | create: lazy persistence without deployment | PASS |
| 16 | create rejects expired-duration request | PASS |
| 17 | engine API journey: create, sign, submit, payout, query, report | PASS |
| 18 | INPUT: /quote null row returns 400, not internal error | FAIL |
| 19 | INPUT: /batches null row returns 400, not internal error | FAIL |
| 20 | restart: persisted pending batch recovered at server startup | PASS |
| 21 | restart: abandoned submission becomes UNKNOWN without resubmit | PASS |
| 22 | SQLite transaction: failed payment insert rolls back batch | PASS |
| 23 | execute rejects wrong receiver | PASS |
| 24 | execute rejects wrong value | PASS |
| 25 | execute rejects wrong token | PASS |
| 26 | execute rejects expired permit | PASS |
| 27 | execute rejects wrong version | PASS |
| 28 | execute rejects unknown provider | PASS |
| 29 | execute rejects nonce mismatch | PASS |
| 30 | execute rejects maxFee insufficient | PASS |
| 31 | execute rejects forged signer | PASS |
| 32 | execute rejects insufficient GasFree balance | PASS |
| 33 | execute: same request submitted once | PASS |
| 34 | execute: idempotency key with changed request rejected | PASS |
| 35 | execute: simultaneous distinct keys submit only once | PASS |
| 36 | execute: submitError remains unknown without payout | PASS |
| 37 | execute: noTrace remains unknown without payout | PASS |
| 38 | workflow: provider FAILED never pays unfunded batch | PASS |
| 39 | workflow: provider success without balance stays unconfirmed | PASS |
| 40 | workflow: provider outage preserves pending state | PASS |
| 41 | workflow: funded batch succeeds despite provider outage | PASS |
| 42 | workflow: partial payout failure preserved | PASS |
| 43 | workflow: all payouts fail | PASS |
| 44 | workflow: lazy deployment failure does not payout | PASS |
| 45 | workflow: repeated recovery skips confirmed on-chain rows | PASS |
| 46 | workflow: simultaneous resume runs one worker | PASS |
| 47 | workflow: broadcast timeout keeps submitted, no resend | PASS |
| 48 | workflow: timeout after on-chain payment is confirmed | PASS |
| 49 | workflow: prior receipt success but bitmap absent waits | PASS |
| 50 | retry batch: unknown funding outcome blocked | PASS |
| 51 | retry batch: definitive provider failure resets to READY | PASS |
| 52 | retry row: already paid skips send | PASS |
| 53 | retry row: unfunded blocked | PASS |
| 54 | retry row: known pending receipt blocks resend | PASS |
| 55 | SAFETY: row retry must not resend when previous receipt missing | FAIL |
| 56 | SAFETY: row retry must stop when paid bitmap RPC fails | FAIL |
| 57 | SAFETY: row broadcast timeout remains unresolved, not FAILED | FAIL |
| 58 | SAFETY: simultaneous row retries must broadcast once | FAIL |
| 59 | refund: active unpaid batch blocked | PASS |
| 60 | refund: expired deployed batch returns remaining balance | PASS |
| 61 | refund: empty executor does not send | PASS |
| 62 | refund: broadcast timeout not resubmitted | PASS |
| 63 | SAFETY: refund receipt reconciled even after balance becomes zero | FAIL |
| 64 | reconciliation: missing batch 404 | PASS |
| 65 | reconciliation: mixed statuses and exact principal | PASS |
| 66 | reconciliation: nonzero chain disagreement detected | PASS |
| 67 | SAFETY: zero on-chain paid amount must not be ignored | FAIL |
| 68 | SAFETY: RPC outage must not produce FINAL reconciliation | FAIL |
| 69 | SAFETY: estimated provider fee must not become actual fee | FAIL |
| 70 | SAFETY: row fee allocations must sum to actual total | FAIL |
| 71 | POLICY: relayer fee shortage must not demand customer top-up | FAIL |
| 72 | POLICY: network timeout must reconcile before resubmit | FAIL |

### Ephemeral Ganache EVM executing repository Solidity; excludes TVM and live GasFree

| # | 시나리오 | 결과 |
|---:|---|---|
| 1 | funding gate: partial deposit blocks all payout | PASS |
| 2 | proof: altered recipient rejected | PASS |
| 3 | proof: altered amount rejected | PASS |
| 4 | proof: altered index rejected | PASS |
| 5 | payout: exact balance movement and duplicate rejection | PASS |
| 6 | Nile-style false return accepted only with actual movement | PASS |
| 7 | initialize: outsider cannot reinitialize clone | PASS |
| 8 | refund: active incomplete batch blocked | PASS |
| 9 | refund: full payout allows surplus return before expiry | PASS |
| 10 | refund: expiry blocks payment, outsider can only refund original owner | PASS |
| 11 | SAFETY: funded counterfactual executor recoverable after expiry | FAIL |

