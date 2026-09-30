> **현재 배포:** [Settle 웹](https://settle-payroll-web.vercel.app) · [현행 실행 흐름과 지갑 지원 범위](CURRENT_INTEGRATION_KO.md). 현재는 TronLink GasFree 수동 입금 후 `/execute`에 `mode: direct`를 전송합니다. 서드파티 지원 지갑의 사용자 승인 후 자동 제출 경로는 현재 웹에서 활성화되지 않았습니다.

> 아래 실험 결과·원본 계약은 해당 작성 시점의 기록입니다. 당시 성공/실패 사실은 보존하며 현재 배포 기능·최신 계약은 위 문서를 우선합니다.

> 현재 흐름과 최신 원격 API 재검증은 [CURRENT_INTEGRATION_KO.md](CURRENT_INTEGRATION_KO.md)를 기준으로 확인하세요. 아래 내용은 작업 시점의 이력을 포함합니다.

> 최신 검증: [146개 자동화 테스트 및 실제 Nile 결과](LATEST_E2E_VERIFICATION.md). 아래는 이전 검증 기록입니다.

> 최신 실제 Nile 결과는 [NILE_LIVE_E2E_RESULTS.md](NILE_LIVE_E2E_RESULTS.md)를 참고. 아래 97개는 이전 검증 시점이며 추가 수정 후 총 107개 통과, 실제 지급·만료 회수도 별도 통과했다. 릴레이어 0 TRX 조건은 해소되었고 새 Factory를 배포했다.

# 엔진 시나리오 수정 및 검증 결과

2026-09-29 · 기준 원격 엔진 a3cae8b + 로컬 수정. 최초 83개 중 14개 실패는 `ENGINE_SCENARIO_BASELINE_FAILURES.md`에 보존했다.

## 현재 결과

| 계층 | 통과 / 전체 |
|---|---:|
| 실제 서버·DB·서명 + 외부 경계 장애 주입 | 80 / 80 |
| 실제 Solidity / 임시 EVM | 11 / 11 |
| 실제 TRON 어댑터·SQLite 연결/재연결 경계 | 6 / 6 |
| 엔진 관련 합계 | 97 / 97 |
| 별도 프론트 검증 | 6 / 6 |

프론트 TypeScript/Vite build도 통과했다. Ganache native µWS 불일치 경고는 JS fallback으로 실행되어 테스트 결과에 영향을 주지 않았다.

## 변경 내용

- 재시도와 배치 worker가 동일한 배치 실행 잠금 및 SQLite 지급 claim을 사용한다. 기존 tx 결과 불명, paid bitmap RPC 실패, txId 응답 전 timeout은 재전송하지 않는다. SQLite 재연결 후에도 미해결 claim을 유지한다. 옛 receipt를 가진 worker가 새 claim을 덮어쓰지 못하도록 txId 조건부 갱신을 추가했다.
- TRON 어댑터가 RPC 오류를 미배포/미지급/0으로 바꾸던 처리를 제거했다. 명시적 contract-not-found만 미배포로 간주한다.
- 환불 receipt 확인을 빈 잔액 검사보다 먼저 수행한다. txId 전 timeout은 기존 claim을 유지한다.
- 컨트랙트는 만료된 예상 주소에도 배포 가능하며, 지급은 기존 execute 만료 조건으로 금지한다. 환불은 배포 시 고정된 원래 주소로만 이동한다.
- 대사 actual fee는 Provider가 명시한 txnTotalFee만 사용한다. 추정치와 기본 0.3을 실제 비용으로 만들지 않는다. 독립적인 잔액 snapshot과 검증된 수수료 증빙이 없어 현재 재무 대사 FINAL은 제공하지 않는다. 지급 성공과 대사 증빙 완성은 별도다.
- 수수료는 제외되지 않은 모든 행에 funding fee를 균등 배분하고 나머지 최소 단위는 index 순서로 배분한다. 실제 개별 지급 가스비가 아니다.
- 릴레이어 비용 부족은 OPERATOR_ACTION / RESTORE_RELAYER_RESOURCES, 결과 불명 timeout은 MANUAL_REVIEW / RECONCILE_EXISTING_ATTEMPT로 안내한다.
- null CSV 지급 행은 내부 500 대신 400을 반환한다.

## API 계약 변경 (클라이언트 적용 필요)

`summary.estimatedFeesTotal`, `actualFeesTotal`은 증빙이 없으면 null. `balanceCheck`의 금액·matched도 null을 허용하며 evidenceStatus=UNAVAILABLE이다. `principalCheck`는 DB 지급 합계와 confirmed paidAmount 비교를 제공하고, `evidence`는 미충족 증빙을 설명한다. 현재 FINAL을 발급하지 않는 것은 기능 완성이 아니라 거짓 완료를 방지한 상태다.

수수료 상한 예약·실제 비용 원장·정산 환급은 아직 구현되지 않았다. 분류를 OPERATOR_ACTION으로 바꾼 것이 해당 비용을 자동 조달한다는 의미는 아니다.

## 실제 Nile 적용 전 조건

**기존 Factory/implementation은 immutable이므로 이 소스 수정만으로 기존 주소의 만료 회수 문제를 고칠 수 없다.** 수정된 Factory를 새로 배포하고 새 주소로 생성한 배치로 검증해야 한다. 기존 배치 주소/expiry를 임의로 변경하면 안 된다.

이번 검증은 Provider 응답과 체인 경계를 제어한 서버 통합, 로컬 EVM, 어댑터 단위 검증이다. 실제 TVM/Provider/지갑 종단간 송금, 실제 Energy 수수료, 블록별 독립 잔액 snapshot, UI 서명 연동은 완료로 주장하지 않는다. 미해결 SUBMITTING은 안전을 위해 자동 재전송하지 않으며, 방송 직전 crash와 txId 유실을 구별하기 위한 서명 tx 사전 저장 및 운영자 복구 도구는 다음 단계다. SSE와 다중 프로세스 전체 실행은 별도 검증이 남는다(이번에는 두 DB 연결 간 claim 원자성 검증).

## 재현

```sh
npm run test:engine:scenarios
npm run test:contract:scenarios
npm run test:recovery:boundaries
npm run test:web
npm run build:web
```

외부 키·.env 없이 테스트를 실행한다. 원시 결과는 artifacts/engine-scenarios.json, artifacts/contract-scenarios.json이다.

## 실행 환경 확인

수정 서버 재시작 후 엔진 및 BFF health 200 확인. Nile RPC로 조회한 현재 로컬 릴레이어 `TXijs8r732nDvULaPCPFDSDebcFLhkgGAL` 잔액은 0 sun이다. 실제 새 Factory 배포/지급 실행에는 테스트 TRX가 필요하다. 현재 .env Factory는 `TMQYoEzE4LagKinHjKE5GU3MLTtrcuGnFB`이며 수정 전 배포를 자동 변경하지 않았다.

## 실행한 시나리오

### Isolated engine integration; real API/DB/signatures, simulated external boundaries; no on-chain transfer

| 시나리오 | 결과 |
|---|---|
| auth: missing bearer rejected | PASS |
| quote: active account exact units | PASS |
| quote: inactive account activation fee included | PASS |
| quote rejects zero | PASS |
| quote rejects negative | PASS |
| quote rejects fraction | PASS |
| quote rejects exponent | PASS |
| quote rejects unsafe-number | PASS |
| quote rejects uint256-overflow | PASS |
| quote rejects empty list | PASS |
| quote rejects 1001 rows | PASS |
| quote accepts 1000 rows | PASS |
| quote rejects invalid address | PASS |
| quote: provider outage returns 503, no invented estimate | PASS |
| create: lazy persistence without deployment | PASS |
| create rejects expired-duration request | PASS |
| engine API journey: create, sign, submit, payout, query, report | PASS |
| INPUT: /quote null row returns 400, not internal error | PASS |
| INPUT: /batches null row returns 400, not internal error | PASS |
| restart: persisted pending batch recovered at server startup | PASS |
| restart: abandoned submission becomes UNKNOWN without resubmit | PASS |
| SQLite transaction: failed payment insert rolls back batch | PASS |
| execute rejects wrong receiver | PASS |
| execute rejects wrong value | PASS |
| execute rejects wrong token | PASS |
| execute rejects expired permit | PASS |
| execute rejects wrong version | PASS |
| execute rejects unknown provider | PASS |
| execute rejects nonce mismatch | PASS |
| execute rejects maxFee insufficient | PASS |
| execute rejects forged signer | PASS |
| execute rejects insufficient GasFree balance | PASS |
| execute: same request submitted once | PASS |
| execute: idempotency key with changed request rejected | PASS |
| execute: simultaneous distinct keys submit only once | PASS |
| execute: submitError remains unknown without payout | PASS |
| execute: noTrace remains unknown without payout | PASS |
| workflow: provider FAILED never pays unfunded batch | PASS |
| workflow: provider success without balance stays unconfirmed | PASS |
| workflow: provider outage preserves pending state | PASS |
| workflow: funded batch succeeds despite provider outage | PASS |
| workflow: partial payout failure preserved | PASS |
| workflow: all payouts fail | PASS |
| workflow: lazy deployment failure does not payout | PASS |
| workflow: repeated recovery skips confirmed on-chain rows | PASS |
| workflow: simultaneous resume runs one worker | PASS |
| workflow: broadcast timeout keeps submitted, no resend | PASS |
| workflow: timeout after on-chain payment is confirmed | PASS |
| workflow: prior receipt success but bitmap absent waits | PASS |
| retry batch: unknown funding outcome blocked | PASS |
| retry batch: definitive provider failure resets to READY | PASS |
| retry row: already paid skips send | PASS |
| retry row: unfunded blocked | PASS |
| retry row: known pending receipt blocks resend | PASS |
| SAFETY: row retry must not resend when previous receipt missing | PASS |
| SAFETY: row retry must stop when paid bitmap RPC fails | PASS |
| SAFETY: row broadcast timeout remains unresolved, not FAILED | PASS |
| SAFETY: simultaneous row retries must broadcast once | PASS |
| refund: active unpaid batch blocked | PASS |
| refund: expired deployed batch returns remaining balance | PASS |
| refund: empty executor does not send | PASS |
| refund: broadcast timeout not resubmitted | PASS |
| SAFETY: refund receipt reconciled even after balance becomes zero | PASS |
| reconciliation: missing batch 404 | PASS |
| reconciliation: mixed statuses and exact principal | PASS |
| reconciliation: nonzero chain disagreement detected | PASS |
| SAFETY: zero on-chain paid amount must not be ignored | PASS |
| SAFETY: RPC outage must not produce FINAL reconciliation | PASS |
| SAFETY: estimated provider fee must not become actual fee | PASS |
| SAFETY: row fee allocations must sum to actual total | PASS |
| POLICY: relayer fee shortage must not demand customer top-up | PASS |
| POLICY: network timeout must reconcile before resubmit | PASS |
| recovery: row timeout without txId must retain persisted claim | PASS |
| recovery: worker timeout without txId must not auto-resend | PASS |
| recovery: row retry and batch worker share exclusion | PASS |
| retry: expired batch must not broadcast payout | PASS |
| refund: timeout without txId keeps claim and blocks resend | PASS |
| reconciliation: missing fee and balance evidence remains unknown | PASS |
| reconciliation: confirmed zero fee is preserved | PASS |
| reconciliation: failed rows share funding fee without lost units | PASS |

### Ephemeral Ganache EVM executing repository Solidity; excludes TVM and live GasFree

| 시나리오 | 결과 |
|---|---|
| funding gate: partial deposit blocks all payout | PASS |
| proof: altered recipient rejected | PASS |
| proof: altered amount rejected | PASS |
| proof: altered index rejected | PASS |
| payout: exact balance movement and duplicate rejection | PASS |
| Nile-style false return accepted only with actual movement | PASS |
| initialize: outsider cannot reinitialize clone | PASS |
| refund: active incomplete batch blocked | PASS |
| refund: full payout allows surplus return before expiry | PASS |
| refund: expiry blocks payment, outsider can only refund original owner | PASS |
| SAFETY: funded counterfactual executor recoverable after expiry | PASS |

