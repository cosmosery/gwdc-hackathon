> **현재 배포:** [Settle 웹](https://settle-payroll-web.vercel.app) · [현행 실행 흐름과 지갑 지원 범위](CURRENT_INTEGRATION_KO.md). 현재는 TronLink GasFree 수동 입금 후 `/execute`에 `mode: direct`를 전송합니다. 서드파티 지원 지갑의 사용자 승인 후 자동 제출 경로는 현재 웹에서 활성화되지 않았습니다.

# Module PRD & Integration Contract — Fee Budget & Settlement

> 2026-09-29. 사용자 승인 정책을 엔진 담당자에게 전달하는 요구사항·통합 계약 초안. 현재 실행 코드에 예산 예약·정산이 구현됐다는 뜻이 아니다. 기존 API를 대체하지 않으며 신규 인터페이스는 review 후 확정한다.

## 0. Metadata

```yaml
module: fee-budget-settlement
owner: execution-engine-owner (담당자 확정 필요)
version: 0.1
status: draft
upstream: [csv-validation, execution-plan, gasfree-provider, nile-rpc]
downstream: [client-review, execution-engine, result-dashboard]
external_dependencies: [TRON Nile, GasFree, operator-treasury]
```

# 1. Summary

## Goal

사용자는 승인한 지급 목록과 비용 한도 안에서만 부담한다. 승인 후 실행비 부족을 이유로 추가 결제를 요구하지 않는다. 엔진은 자원 확보 후 접수하고, 부족 시 복구 대기 또는 미지급금 정산·환불로 종료한다. 모든 지급의 무조건 성공을 보장하는 정책은 아니다.

## Responsibility

전체 실행 계획, 비용 산출 근거, 복구 예산, 원자적 예약, 실행 전 재평가, 실제 비용 기록, 정산·환불 요청 및 상태 노출.

## Non-Responsibility

CSV UI/파싱, 사용자 개인키 보관, 사용자 동의 없는 원금 차감, Provider 장애의 해결, 무제한 자동 재시도.

# 2. User / System Flow

1. 검증된 지급 목록을 엔진이 재검증하고 순서를 고정한다.
2. 정상 실행과 복구를 포함한 견적을 만들고 근거·상한·유효기간을 반환한다.
3. 브라우저는 CSV와 견적·배치 결속을 독립 확인하고 사용자에게 승인 내용을 표시한다.
4. 승인 접수 시 견적 유효성과 잔액을 재확인하고 전체 예산을 원자적으로 예약한다. 실패하면 자금 이동 전에 중단한다.
5. GasFree 입금 후 릴레이어가 실행한다. 각 전송 전에 예산·자원·기존 거래 결과를 확인한다.
6. 미지급 행만 복구한다. 결과 불명은 조회를 계속하고 재전송하지 않는다.
7. 실제 비용과 미지급 원금을 분리 정산하고 필요한 환불 거래를 확정한다.

### Expected Result

추가 결제 요청 없이 지급 완료, 부분 지급 후 잔여금 환불 또는 운영 복구 대기 상태가 근거와 함께 표시된다.

# 3. Functional Requirements

| ID | Requirement | Priority |
|---|---|---|
| FR-01 | 승인 후 비용 증가로 추가 결제를 요구하지 않는다 | MUST |
| FR-02 | 원금·GasFree 한도·릴레이어 예산·사용자 비용 한도를 분리한다 | MUST |
| FR-03 | 정상 실행 외 지급별 추가 1회, 배포 추가 1회, 환불 1회 예산을 포함한다 | MUST |
| FR-04 | 같은 운영 자원을 여러 배치에 중복 예약하지 않는다 | MUST |
| FR-05 | 승인 금액·목록·네트워크·토큰·버전·만료를 결속한다 | MUST |
| FR-06 | 비용 부족 시 대기/운영 복구/환불로 전환하고 원금을 가스비로 쓰지 않는다 | MUST |
| FR-07 | 사용한 실패 비용도 원장에 기록한다 | MUST |
| FR-08 | 사용자 환불액 계산과 실제 환불 확정을 구분한다 | MUST |
| FR-09 | 운영 예비비 소진 시 신규 접수를 중단한다 | MUST |
| FR-10 | GasFree maxFee 증가를 릴레이어 자원 증가로 해석하지 않는다 | MUST |

# 4. Input Contract

## Input Type

```typescript
type UInt = string; // 정규식 ^(0|[1-9][0-9]*)$, 계산은 BigInt
interface FeeBudgetInput {
  network: 'nile';
  sender: string;
  token: string;
  payments: { index: number; recipient: string; amount: UInt }[];
}
```

## Field Rules

| Field | Required | Description | Validation |
|---|---:|---|---|
| network | Yes | 테스트넷 구분 | nile만 허용 |
| sender/token | Yes | TRON 주소 | 유효성 및 지원 토큰 검증 |
| payments | Yes | 지급 순서 | 1~1000행, 0부터 연속 index |
| amount | Yes | 최소 단위 | 양수 정수 문자열, 합계 uint256 범위 |

## Example

```json
{"network":"nile","sender":"TQZE7vxcx9qr6d8BczbYYLwfeHJ5ZbDj7c","token":"TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf","payments":[{"index":0,"recipient":"TKv2SjwKCxMCqtQebbCXEdHbPXCvwErLnJ","amount":"1000000"}]}
```

# 5. Output Contract

## Output Type

```typescript
interface FeeBudgetQuote {
  quoteId: string;
  policyVersion: string;
  planHash: string; // 계산 규칙은 OD-03에서 확정
  expiresAt: number; // Unix seconds
  status: 'ESTIMATED' | 'UNAVAILABLE';
  approvalReady: boolean;
  principalAtomic: UInt;
  gasFree: { quotedFeeAtomic: UInt; authorizedMaxFeeAtomic: UInt | null };
  relayer: {
    normalSun: UInt | null;
    payoutRetrySun: UInt | null;
    deploymentRetrySun: UInt | null;
    refundSun: UInt | null;
    totalReservedSun: UInt | null;
  };
  customerFeeCapAtomic: UInt | null;
  customerTotalCapAtomic: UInt | null;
  additionalPaymentRequired: false;
  evidenceIds: string[];
  blockingCodes: string[];
}
```

## Output Guarantees

- null은 미확정이며 0원이 아니다. 항목 누락·추정 불가·정산 경로 미구현이면 approvalReady=false.
- 견적만으로 자금 확보를 선언하지 않는다. 별도 예약 성공이 접수 조건이다.
- customerTotalCapAtomic은 원금과 사용자 부담 수수료의 최종 상한이며, 기존 estimatedTotal과 구분한다.
- quotedFee, authorizedMaxFee, relayer 예산을 중복 청구하지 않는다.

## Example

```json
{"quoteId":"example-not-live","policyVersion":"0.1-draft","planHash":"example-only","expiresAt":1790683200,"status":"UNAVAILABLE","approvalReady":false,"principalAtomic":"1000000","gasFree":{"quotedFeeAtomic":"300000","authorizedMaxFeeAtomic":null},"relayer":{"normalSun":null,"payoutRetrySun":null,"deploymentRetrySun":null,"refundSun":null,"totalReservedSun":null},"customerFeeCapAtomic":null,"customerTotalCapAtomic":null,"additionalPaymentRequired":false,"evidenceIds":[],"blockingCodes":["BUDGET_NOT_CALIBRATED","SETTLEMENT_NOT_IMPLEMENTED"]}
```

# 6. Shared Domain Objects

```typescript
interface CostEvidence {
  evidenceId: string;
  network: 'nile';
  observedAt: number;
  blockNumber?: number;
  source: 'SIMULATION' | 'RECEIPT' | 'MODEL';
  operation: 'DEPLOY' | 'PAYOUT' | 'REFUND';
  energy?: UInt;
  energyPriceSun?: UInt;
  bandwidthBudgetSun?: UInt;
  plannedFeeLimitSun?: UInt;
  assumptions: string[];
}
interface FeeSettlement {
  batchId: string;
  paidPrincipalAtomic: UInt;
  refundablePrincipalAtomic: UInt;
  actualGasFreeFeeAtomic: UInt | null;
  actualRelayerBurnSun: UInt;
  customerChargedFeeAtomic: UInt | null;
  refundableFeeAtomic: UInt | null;
  operatorOverrunSun: UInt;
  state: 'PENDING' | 'RECONCILING' | 'SETTLED' | 'REFUND_PENDING' | 'REFUNDED';
}
```

### Rules

금액은 정수 문자열로 전달한다. TRX는 sun, 토큰은 최소 단위로 계산하며 서로 직접 더하지 않는다. 원본 CSV 행 번호는 클라이언트에서 engine index와 매핑하며, 임의 병합·정렬하지 않는다.

# 7. State Model

```yaml
states: [ESTIMATED, RESERVED, EXECUTING, RECONCILING, RECOVERY_PENDING, SETTLING, REFUND_PENDING, COMPLETED, PARTIAL_REFUNDED, REFUNDED]
```

```text
ESTIMATED → RESERVED → EXECUTING → SETTLING → COMPLETED
                         ├→ RECONCILING → EXECUTING / RECOVERY_PENDING
                         └→ RECOVERY_PENDING → EXECUTING / REFUND_PENDING
REFUND_PENDING → PARTIAL_REFUNDED / REFUNDED
```

| State | Meaning | Final |
|---|---|---:|
| RECONCILING | 거래 결과 불명, 새 송금 금지 | No |
| RECOVERY_PENDING | 운영 자원·복구 조치 필요, 고객 추가 결제 없음 | No |
| REFUND_PENDING | 환불 미확정 | No |
| COMPLETED | 지급·정산 완료 | Yes |
| PARTIAL_REFUNDED / REFUNDED | 잔여금 환불 확정 | Yes |

모듈 상태를 기존 batch.status에 즉시 덮어쓰지 않는다. 상태 매핑은 통합 계약에서 확정한다. UNKNOWN != FAILED.

# 8. Validation

| ID | Validation | Failure Code | Blocking |
|---|---|---|---:|
| VR-01 | 견적 유효기간 및 목록 결속 | QUOTE_EXPIRED / PLAN_CHANGED | Yes |
| VR-02 | 비용 근거·정산 준비 | BUDGET_NOT_CALIBRATED / SETTLEMENT_NOT_IMPLEMENTED | Yes |
| VR-03 | 미예약 자원 충분 | RELAYER_RESERVE_UNAVAILABLE | Yes |
| VR-04 | Provider 요율이 서명 상한 이내 | GASFREE_CAP_EXCEEDED | Yes |
| VR-05 | 기존 요청 결과 확인 | OUTCOME_UNKNOWN | Yes |
| VR-06 | 만료 시 미배포 환불 경로 존재 | REFUND_PATH_UNAVAILABLE | Yes |

# 9. Error Contract

```typescript
type ModuleError = {
  code: string;
  category: 'VALIDATION' | 'AUTHORIZATION' | 'DEPENDENCY' | 'TIMEOUT' | 'CONFLICT' | 'EXECUTION' | 'INTERNAL';
  message: string;
  retryable: boolean; // 고객 재결제나 무조건 재전송을 뜻하지 않음
  details?: Record<string, unknown>;
};
```

| Code | Condition | Retryable | Required Action |
|---|---|---:|---|
| QUOTE_EXPIRED / PLAN_CHANGED | 승인 전 조건 변경 | No | 새 견적 |
| RELAYER_RESERVE_UNAVAILABLE | 접수 전 운영 자원 부족 | Yes | 운영 충전 후 예약 재검사 |
| BUDGET_NOT_CALIBRATED | 안전한 비용 입력 없음 | No | 측정/검증 |
| SETTLEMENT_NOT_IMPLEMENTED | 수수료 예치·정산 미구현 | No | 통합 완료 |
| OUTCOME_UNKNOWN | 제출 결과 불명 | No | 기존 요청 조회 |
| EXECUTION_BUDGET_EXHAUSTED | 승인 후 운영 예산 부족 | No | 운영 조치/환불, 추가 청구 금지 |
| GASFREE_CAP_EXCEEDED | Provider 요율 상한 초과 | No | 자동 재제출 금지, 상태 대조 |
| IDEMPOTENCY_CONFLICT | 같은 키 다른 payload | No | 기존 결과 확인 |

# 10. Exception Scenarios

| ID | Scenario | Detection | Expected Behavior | Final State |
|---|---|---|---|---|
| EX-01 | 지급 OUT_OF_ENERGY | 확정 영수증·paid 조회 | 비용 기록 후 재추정, 예산 내 추가 1회 | EXECUTING / RECOVERY_PENDING |
| EX-02 | 전송 후 응답 유실 | timeout | txHash/nonce/입금/paid 조회, 무조건 재전송 금지 | RECONCILING |
| EX-03 | 일부 행 지급 완료 | 행별 확정 증거 | 완료 행 제외 후 복구·잔여금 환불 | PARTIAL_REFUNDED 등 |
| EX-04 | 릴레이어 잔액 부족 | 전송 전 자원 검사 | 전송 중지, 운영 충전, 고객 결제 버튼 없음 | RECOVERY_PENDING |
| EX-05 | 예산 모두 소진 | 원장·예약 잔액 | 운영 예비비 승인 또는 환불 | RECOVERY_PENDING |
| EX-06 | 미배포 상태로 만료 | code/state/expiry | 배포·환불 가능한 설계가 접수 선행 조건 | RECOVERY_PENDING |
| EX-07 | GasFree Permit 만료 전 미입금 | Provider/확정 nonce | 사용자 서명 없이 deadline 연장 불가. 자동 완료 보장 금지 | RECONCILING |

EX-07에서 재서명과 추가 결제는 다르다. 본 정책은 추가 결제를 금지하지만 모든 경우 재서명도 없다고 보장하지 않는다. 만료된 Permit을 새로 서명하지 않고 실행할 수 있다는 표현을 사용하지 않는다.

# 11. Side Effects

| Operation | Side Effect | Idempotent |
|---|---:|---:|
| 견적 작성 | 조회·견적 저장 | 동일 quoteId 재조회 Yes |
| 예산 예약 | 운영 원장 DB 변경 | Yes |
| 실행 | Provider 제출·체인 전송 | 논리 요청 중복 방지 필수 |
| 정산 | 원장 변경 | Yes |
| 환불 | 온체인 전송 | 기존 tx 확인 후 한 논리 환불 |

# 12. Idempotency

```yaml
idempotency:
  required: true
  key: 'operation + quoteId/batchId + Idempotency-Key'
  duplicate_same_payload: 기존 예약/결과 반환
  duplicate_different_payload: IDEMPOTENCY_CONFLICT
```

예약은 DB 트랜잭션으로 경쟁 처리한다. 지급 retry 번호와 실제 txHash를 기록한다. 같은 원금·미사용 수수료를 두 번 환불하지 않는다. 기존 execute 멱등성만으로 자원 예약·정산 멱등성을 충족하지 않는다.

# 13. Timeout & Retry

```yaml
timeout:
  can_side_effect_have_occurred: true
  resulting_state: RECONCILING
  required_recovery: 기존 요청/거래/nonce/확정 입금/paid 조회
retry:
  automatic: 조건부
  max_attempts: 2 # 지급/배포별 최초 포함, 환불은 예산상 최초 1회
  backoff: 초기 5초 이상, 지수 증가 및 jitter; 운영 조정 가능
  precondition: 미실행/확정 실패 + 충분한 잔여 예산 + 유효한 배치 + 원인 해소
```

한도를 초과한 재시도·환불 재시도는 고객 추가 결제 대신 운영 복구 정책으로 처리한다. 읽기 재시도는 전송 시도 수와 분리한다. 계약 검증 실패·잘못된 proof는 같은 요청을 자동 재시도하지 않는다.

# 14. Dependencies

## Upstream

CSV 정규화 Contract, 실행 계획과 주소 예측, 비용 추정기, Provider 계정/요율.

## Downstream

견적 검토 UI, 실행 워커, 결과 대시보드, 정산 원장.

## External Services

Nile RPC 및 GasFree. 환율·Energy 조달을 도입하면 출처/시점/만료를 별도 기록한다.

# 15. Security Boundary

| Question | Answer |
|---|---|
| Private key 접근 | 견적 모듈 No; 실행 모듈은 릴레이어 키만 |
| Signature 생성 | 사용자 지갑에서만 |
| 사용자 자금 이동 가능 | 검증된 승인·확정 계약 범위 내 |
| Blockchain transaction 발생 가능 | 실행/환불 Yes, 견적 No |
| 사용자 승인 필요 | 최초 지급 및 비용 한도 승인 |

API secret·개인키·원시 인증정보·재사용 가능한 서명은 일반 로그에 기록하지 않는다. planHash만으로 서명이 자동 결속되지는 않는다. 실제 서명 필드 및 컨트랙트 검증과 연결돼야 한다.

# 16. Observability

```yaml
identifiers: [quoteId, policyVersion, planHash, batchId, paymentId, executionId, requestId, traceId, txHash, reservationId, settlementId]
```

| Event | When |
|---|---|
| BUDGET_RESERVED | 자원 예약 확정 |
| COST_REESTIMATED | 실행 전 재추정 |
| RECOVERY_PENDING | 운영 비용/자원 부족 |
| SETTLEMENT_FINALIZED | 원장 정산 완료 |
| REFUND_CONFIRMED | 환불 영수증 확정 |

대시보드 문구: “실행비 부족으로 복구 대기 중입니다. 추가 결제는 필요하지 않습니다.” 세부 원인 코드와 완료/대기/환불 행 수를 함께 표시한다.

# 17. API / Function Surface

아래는 신규 제안이며 현재 호출 가능한 endpoint가 아니다. 현 /quote는 그대로 유지한다.

| Operation | Input | Output | Side Effect |
|---|---|---|---|
| estimateBudget | FeeBudgetInput | FeeBudgetQuote | 조회·견적 저장 |
| reserveBudget | quoteId + 승인 참조 + 멱등키 | reservationId | 원장 예약 |
| reconcileBudget | batchId | 비용 및 복구 상태 | 원장 갱신 |
| settleBudget | batchId + 멱등키 | FeeSettlement | 정산·환불 스케줄 |

## 예산 계산 규칙

각 작업의 최초 시도 한도 C1과 복구 시도 한도 C2를 별도로 구한다. C에는 계획된 Energy 소각 상한, Bandwidth 및 적용 가능한 추가 비용을 포함한다. Energy를 빌리는 경우 조달 비용과 소각 비용을 이중 계상하지 않는다. 예비 예산 계산은 확보되지 않은 무료 자원을 가정하지 않는 보수적 기준을 쓴다.

```text
정상 예산 = Cdeploy1 + Σ Cpayout_i1
복구 예산 = Cdeploy2 + Σ Cpayout_i2 + Crefund1
배치 예약액 = 정상 예산 + 복구 예산
```

C2를 최초 실패를 감당할 수 있게 잡고, 실패가 상한을 소비한 경우도 계산한다. 실행 직전 상한을 올릴 때는 잔여 예산이 새 한도를 수용해야 한다. 환불 예산을 지급 재시도에 전용하지 않는다. Factory 최초 설치 비용은 배치별 clone 비용과 구분한다.

GasFree 토큰 수수료는 별도다. authorizedMaxFeeAtomic은 Provider 견적·유효기간·정책에 따라 산출하고 사용자에게 명시한다. maxFee 미사용분은 선차감되지 않았다면 환불 대상이 아니라 원래 잔액이다.

# 18. Acceptance Criteria

### AC-01 — 예산 이중 예약 방지

Given 두 배치를 모두 감당하지 못하는 운영 잔액, When 두 승인 요청이 동시 도착, Then 하나만 예약되고 다른 요청은 자금 이동 전 차단된다.

### AC-02 — 실패 후 추가 청구 없음

Given 지급 예산과 추가 시도 예산이 확보된 배치, When 첫 지급이 확정 OUT_OF_ENERGY, Then 실패 비용을 기록하고 paid=false 및 원인 해소를 확인한 후 확보 예산 내 재시도하며 고객 추가 청구는 없다.

### AC-03 — 불명 결과 재송금 방지

Given 전송 응답 유실, When 재시도 버튼 클릭, Then 조회/복구만 수행하고 두 번째 전송을 즉시 만들지 않는다.

### AC-04 — 원금과 수수료 정산 분리

Given 부분 지급 완료, When 정산, Then 미지급 원금과 미사용 수수료를 각각 계산하고 실제 환불 확정 전 완료로 표시하지 않는다.

### AC-05 — 예산 소진

Given 복구 예산 소진, When 다음 지급을 계획, Then 추가 결제 없이 운영 대기 또는 환불로 전환하며 승인 금액과 수취인 원금은 변경하지 않는다.

### AC-06 — 계산 불가 견적 차단

Given 미배포/미입금 상태에서 성공 경로 시뮬레이션 불가, When 견적, Then 오류 실행의 Energy를 성공 비용으로 사용하지 않고 검증된 모델 또는 UNAVAILABLE을 반환한다.

# 19. Required Test Cases

| Type | Required |
|---|---:|
| 정상 지급·정산 | Yes |
| 금액/상한 경계와 BigInt 반올림 | Yes |
| 시뮬레이션 REVERT·RPC 장애·불완전 근거 | Yes |
| 중복 승인·동시 배치 예약·재시작 | Yes |
| 전송 후 timeout·nonce 변경·만료 | Yes |
| 부분 지급·OUT_OF_ENERGY·릴레이어 고갈 | Yes |
| 재시도 상한 상향과 잔여 예산 부족 | Yes |
| 환불 실패·중복 환불·미배포 만료 | Yes |
| 네트워크/토큰/목록/정책 버전 변경 | Yes |

# 20. Open Decisions

| ID | Question | Options | Impact |
|---|---|---|---|
| OD-01 | 고객 수수료 정산 방식 | 상한 예치 후 실비 정산 / 고정 서비스 요금 | 수취·환불 계약 필요. 미사용분 반환 목적에는 전자 권장 |
| OD-02 | 최초 GasFree 수수료 상한 여유 | 실시간 요율 + 정책 여유 / 짧은 유효기간 고정 상한 | 실제 서명 범위 및 토큰 잔액 |
| OD-03 | planHash·quoteId 결속 | 기존 batchHash 확장 / 별도 버전 계약 | 브라우저 독립 검증 |
| OD-04 | 수수료 예치 자금 수취·정산 컨트랙트 | 기존 구조 확장 / 별도 정산 계약 | 현재 value==total_amount 및 Merkle 모델 변경 필요 |
| OD-05 | 보수적 Energy 모델과 배율 | 작업별 측정 + 현재 체인 상한/검증된 envelope | 특정 배율을 아직 안전치로 확정하지 않음 |
| OD-06 | 운영 복구 시간·손실 한도 | 운영 예비비·접수 제한·환불 기한 | 사용자 안내 및 중단 정책 |
| OD-07 | 미배포 만료 복구 | 사전 배포 / 초기화·환불 경로 재설계 | 자금 회수 가능성 |

추가 결제를 요구하지 않는 정책은 확정 방향이다. OD는 이 정책을 구현하기 위한 계약 결정이며, 빈 값을 가정해 실행하지 않는다.

# 21. Integration Notes

기존 /quote의 estimatedTotal은 원금+GasFree뿐이다. estimatedRelayerFeeTrx=20+15N은 임시 추정으로 승인 총액에 쓰지 않는다. CSV 모듈은 비용을 재계산하지 않고 엔진 결과를 표시한다. 화면의 재시도는 결제 재요청과 구분하며 모의 성공은 실제 온체인 성공과 구분한다.

# 22. Agent Handoff

## Safe to Assume

- 고객 추가 결제 없는 복구/정산을 목표로 한다.
- 건별 추가 1회, 배포 추가 1회, 환불 1회가 기본 예산 범위다.
- 현재 환불은 Executor 잔여 토큰 회수이며 수수료 원장 정산이 아니다.

## Must NOT Assume

- 코드가 이 정책을 이미 강제한다.
- maxFee만 늘리면 릴레이어 비용이 충당된다.
- 모든 실패가 재서명 없이 복구된다.
- 실패한 거래 비용은 환불된다.
- 단일 Nile 실측이나 예시 숫자가 mainnet 안전 상한이다.

## Integration Dependencies

CSV Contract, Execution Engine Contract, Wallet Authorization Contract, Treasury/Settlement Contract, Dashboard Contract.

# 23. Definition of Done

- [x] 책임·입출력 초안·오류·부작용·예외·재시도·멱등성 정의
- [x] 근거와 정책 선택·미결정 사항 구분
- [x] 수락 기준과 필요한 테스트 정의
- [ ] 모듈 담당자 review 및 계약 locked
- [ ] 실제 예산 추정·예약·정산·환불 구현
- [ ] 사용자 승인과 원장/컨트랙트 결속 검증
- [ ] 실패·부분 지급·미배포 만료 포함 E2E 검증
