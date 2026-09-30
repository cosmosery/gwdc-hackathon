> 현재 흐름과 최신 원격 API 재검증은 [CURRENT_INTEGRATION_KO.md](CURRENT_INTEGRATION_KO.md)를 기준으로 확인하세요. 아래 내용은 작업 시점의 이력을 포함합니다.

# E2E 검증 현황 — 2026-09-29

## 검증 수준을 구분한 결과

| 실행한 테스트 묶음 | 통과 | 검증 환경 |
|---|---:|---|
| 엔진 API / 상태 전이 / 장애 / 복구 | 87 | 실제 Fastify·SQLite·TIP-712 서명, 외부 RPC와 Provider만 대체 |
| Solidity 계약 시나리오 | 11 | 실제 계약을 로컬 Ganache EVM에 배포 |
| TRON 어댑터·SQLite 경계 | 6 | 실제 어댑터 오류 처리 및 독립 DB 연결 |
| GasFree 응답 경계 | 8 | HTTP·응답 스키마·타임아웃 주입 |
| SSE | 1 | 실제 로컬 HTTP 스트림 |
| 수수료 영수증 | 8 | Transfer 로그 검증·실패 트랜잭션 비용·증거 누락 |
| 프론트 API 브리지 | 5 | 실제 로컬 HTTP·Origin·멱등키·응답 유실 |
| CSV 및 지갑 서명 검증 | 20 | 정확한 단위·체크섬·독립 Merkle/CREATE2·지갑 대역 |
| 합계 | **146** | 이 숫자 전체를 Nile 실거래 횟수로 표현하지 않음 |

## 실제 Nile 거래

1. 단일 지급 성공: `b_1790687324263_3046dd2e`. GasFree 입금 후 0.1 USDT 지급 및 잔액 0 확인. `artifacts/nile-engine-e2e.json`.
2. 만료된 미배포 Executor 원금 회수: `refund_regression_2ad33f280c0841a1b6a1bd5c7b055759`. 만료 fixture를 DB에 심고, 실제 GasFree 입금·배포·원래 소유자 환불을 실행. 일반 생성 API가 만료 배치를 허용한다는 뜻은 아님. `artifacts/nile-expired-refund.json`.
3. 세 행 지급 성공: `b_1790689768860_2ad44eb8`. 동일 테스트 주소에 0.01, 0.02, 0.03 USDT를 서로 다른 행으로 지급. 하나의 GasFree 입금에서 세 개의 지급 tx가 확정됐고, 지급 bitmap 세 개 true 및 Executor 잔액 0 확인. 서로 다른 수취인 세 명을 실거래 검증했다는 주장은 하지 않음. 최초 5분 테스트 도구 제한에 도달했지만 같은 배치가 복구되어 완료; 새 permit 제출 없음. `artifacts/nile-three-row-e2e.json`.

4. 새 HTTP signing-context 및 수수료 증거 전 구간 성공: `b_1790690167948_83b4c4ab`. 0.01 USDT 지급, maxFee 0.6 USDT, 확정 로그상 실제 fee 0.3 USDT, 미청구 allowance 0.3 USDT. 새 DB 기록에서 배포 tx 16.9955 TRX + 지급 tx 9.5769 TRX = 운영자 burn 26.5724 TRX. `/fees`는 `VERIFIED_TRACKED_FEES`, 증거 누락 없음. 전체 자금 대사 FINAL을 뜻하지 않는다. `artifacts/nile-wallet-context-e2e.json`, `artifacts/nile-confirmed-fees.json`.

[새 입금 트랜잭션](https://nile.tronscan.org/#/transaction/f6cd3562ae6c72ad6f2243a2e517f08ad352edf128ff30f5fb1e1070f86496cd) · [새 지급 트랜잭션](https://nile.tronscan.org/#/transaction/8c053bcca3bad8b3c846e71af654e8a0105f5f19704bfef520ec1291edbf4d3b).

실패·부분 성공·Provider 단절·위조 서명·동시 요청은 재현 가능한 격리 테스트에서 주입했다. 테스트넷에서 모든 종류의 장애를 실제 발생시킨 것은 아니다.

## 이번에 연결한 기능

- Chrome의 TronLink로 Nile 연결 → CSV 견적 → 배치 생성 → signing-context 조회 → TIP-712 서명 → execute → 결과 추적.
- 브라우저에서 CSV 기준 Merkle root, batchHash, salt, CREATE2 Executor를 독립 재계산한다. 검토한 Factory/implementation을 고정하며 배포가 바뀌면 명시적인 코드 갱신이 필요하다.
- 계정/네트워크를 서명 전후 검사한다. 수취인·금액·도메인·서명 스키마·만료·fee cap 변경을 거부한다.
- 동일 페이지의 중복 제출을 막고, 제출 응답을 잃으면 기존 배치를 추적한다. 개인키와 서명은 sessionStorage에 저장하지 않는다.
- BFF는 로컬 전용이다. 허용 Origin과 Host를 확인하고, 필요한 경로와 멱등키만 전달한다. 공개 서비스의 사용자/tenant 인증을 대체하지 않는다.
- 새 execute의 승인 fee cap과 GasFree 주소를 원자적으로 저장한다. 배포·지급·환불 tx 기록을 보존해 재시도 전 실패 tx 비용도 누락하지 않는다.
- `/fees`는 확정된 토큰 Transfer 로그에서 입금 원금과 GasFree 계정의 실제 순유출을 검증한다. 두 값의 차이가 실제 GasFree token fee다. relayer TRX는 확인된 추적 tx의 burn 비용 합계이며 스테이킹/임대 자원 원가는 제외한다.

## 발표할 수 있는 수수료 정책과 한계

`maxFee = 현재 Provider 수수료 × 2`로 100% 여유를 두며, 고객 승인 상한은 `원금 + maxFee`다. 현재 활성 계정 0.3 USDT 수수료라면 maxFee는 0.6 USDT다. 이는 구현한 정책적 여유이며, 통계적으로 보장한 최악값이나 성공률은 아니다.

maxFee는 선결제 잔액이 아니다. 실제 청구가 0.3이면 남은 0.3은 애초에 청구되지 않는다. Executor에 남은 미지급 원금은 별도의 온체인 refund 흐름으로 반환한다. TRX는 운영자 부담이며 부족 오류를 고객 TRX 충전 요구로 바꾸지 않는다.

운영자 TRX의 배치 간 회계 예약, 자원 임대 원가, 고객 대상 추가 플랫폼 요금의 선결제·환불 계약은 구현되지 않았다. 현재 UI도 이를 고객에게 청구했다고 표시하지 않는다. 전체 잔액 대사는 독립 증거가 부족하면 PARTIAL을 유지하며, fee report가 검증됐다는 사실만으로 FINAL로 승격하지 않는다.

실제 Chrome에서 Live API → Review quote로 지갑 연결을 시도했지만 TronLink가 `User rejected the request.`를 반환했다. 화면에서도 이 오류가 표시됐으며 서명·제출로 넘어가지 않았다. 따라서 Chrome 지갑 팝업의 승인 완료는 미검증이다. 지갑 호출은 대역으로 검증했고 동일 TIP-712/엔진 경로는 테스트 지갑 SDK로 실제 Nile에 제출했다.

## 재현 명령

```sh
rtk npm run test:engine:scenarios
rtk npm run test:contract:scenarios
rtk npm run test:recovery:boundaries
rtk npm run test:provider:boundaries
rtk npm run test:events
rtk npm run test:fee:evidence
rtk npm run test:frontend:bridge
rtk npm run test:web
rtk npm run build:web
```

실거래는 `scripts/api-e2e.cjs` 사용. `E2E_HTTP_URL=http://127.0.0.1:3000`이면 실행 중인 엔진 HTTP API를 통과한다. `E2E_PAYMENT_COUNT=1..3`은 테스트 지갑 자신에게만 소액 송금한다. 이미 제출한 batch를 재생성해 재시도하지 않는다. 키는 로컬 환경에서만 읽는다.

공식 지갑 API 근거: [TronLink 연결](https://docs.tronlink.org/dapp/getting-started/), [Nile chain ID](https://docs.tronlink.org/reference/networks/).

## 실행한 엔진 시나리오 전체 목록

1. fee cap: twice current fee, principal unaffected
2. signing context: exact batch permit and fresh nonce without submission
3. signing context: activation included in cap
4. signing context: submitted batch cannot obtain a new permit
5. signing context: expired batch rejected
6. signing context: provider outage fails closed
7. auth: missing bearer rejected
8. quote: active account exact units
9. quote: inactive account activation fee included
10. quote rejects zero
11. quote rejects negative
12. quote rejects fraction
13. quote rejects exponent
14. quote rejects unsafe-number
15. quote rejects uint256-overflow
16. quote rejects empty list
17. quote rejects 1001 rows
18. quote accepts 1000 rows
19. quote rejects invalid address
20. quote: provider outage returns 503, no invented estimate
21. create: lazy persistence without deployment
22. create rejects expired-duration request
23. engine API journey: create, sign, submit, payout, query, report
24. INPUT: /quote null row returns 400, not internal error
25. INPUT: /batches null row returns 400, not internal error
26. restart: persisted pending batch recovered at server startup
27. restart: abandoned submission becomes UNKNOWN without resubmit
28. SQLite transaction: failed payment insert rolls back batch
29. execute rejects wrong receiver
30. execute rejects wrong value
31. execute rejects wrong token
32. execute rejects expired permit
33. execute rejects wrong version
34. execute rejects unknown provider
35. execute rejects nonce mismatch
36. execute rejects maxFee insufficient
37. execute rejects forged signer
38. execute rejects insufficient GasFree balance
39. execute: same request submitted once
40. execute: idempotency key with changed request rejected
41. execute: simultaneous distinct keys submit only once
42. execute: submitError remains unknown without payout
43. execute: noTrace remains unknown without payout
44. workflow: provider FAILED never pays unfunded batch
45. workflow: provider success without balance stays unconfirmed
46. workflow: provider outage preserves pending state
47. workflow: funded batch succeeds despite provider outage
48. workflow: partial payout failure preserved
49. workflow: all payouts fail
50. workflow: lazy deployment failure does not payout
51. deployment: persisted factory and executor bind recovery across configuration changes
52. workflow: repeated recovery skips confirmed on-chain rows
53. workflow: simultaneous resume runs one worker
54. workflow: broadcast timeout keeps submitted, no resend
55. workflow: timeout after on-chain payment is confirmed
56. workflow: prior receipt success but bitmap absent waits
57. retry batch: unknown funding outcome blocked
58. retry batch: definitive provider failure resets to READY
59. retry row: already paid skips send
60. retry row: unfunded blocked
61. retry row: known pending receipt blocks resend
62. SAFETY: row retry must not resend when previous receipt missing
63. SAFETY: row retry must stop when paid bitmap RPC fails
64. SAFETY: row broadcast timeout remains unresolved, not FAILED
65. SAFETY: simultaneous row retries must broadcast once
66. refund: active unpaid batch blocked
67. refund: expired deployed batch returns remaining balance
68. refund: empty executor does not send
69. refund: broadcast timeout not resubmitted
70. SAFETY: refund receipt reconciled even after balance becomes zero
71. reconciliation: missing batch 404
72. reconciliation: mixed statuses and exact principal
73. reconciliation: nonzero chain disagreement detected
74. SAFETY: zero on-chain paid amount must not be ignored
75. SAFETY: RPC outage must not produce FINAL reconciliation
76. SAFETY: estimated provider fee must not become actual fee
77. SAFETY: row fee allocations must sum to actual total
78. POLICY: relayer fee shortage must not demand customer top-up
79. POLICY: network timeout must reconcile before resubmit
80. recovery: row timeout without txId must retain persisted claim
81. recovery: worker timeout without txId must not auto-resend
82. recovery: row retry and batch worker share exclusion
83. retry: expired batch must not broadcast payout
84. refund: timeout without txId keeps claim and blocks resend
85. reconciliation: missing fee and balance evidence remains unknown
86. reconciliation: confirmed zero fee is preserved
87. reconciliation: failed rows share funding fee without lost units
