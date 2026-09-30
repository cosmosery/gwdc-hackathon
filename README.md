# Settle · GasFree Batch Payments

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


**[프론트 실행하기 →](https://settle-payroll-web.vercel.app)** · [Engine API](https://tron-gasfree-batch-nile-probe.vercel.app) · [현재 연동 상태](docs/CURRENT_INTEGRATION_KO.md)

TRON Nile에서 CSV 지급 목록을 검토하고, 사용자 GasFree 계정에서 배치별 vault로 입금한 뒤 엔진을 통해 수취인별 지급 결과를 확인합니다.

현재 웹 흐름은 **CSV 검토 → 수수료 조회 → vault 준비 → TronLink GasFree에서 수동 송금 → Start payouts → 결과·대사**입니다. 웹은 PermitTransfer 서명 팝업을 요청하지 않습니다. 입금 후 실행 요청은 `POST /batches/:batchId/execute`, `{ "mode": "direct" }`이며 signature를 보내지 않습니다. 서버의 해당 실행 모드 지원과 릴레이어 자원이 필요합니다.

공개 페이지에서 엔진 기능을 사용하려면 **Open another batch · connection settings → Engine access token**에 발급받은 토큰을 입력합니다. 토큰은 해당 탭 메모리에만 유지되며 새로고침 후 다시 입력해야 합니다. 저장소·배포 번들에는 토큰을 포함하지 않습니다. Chrome의 TronLink를 Nile로 설정하고 GasFree 계정 잔액을 준비하세요.

프론트 배포 프로젝트는 `settle-payroll-web`, 소스 디렉터리는 `web/`입니다. `cd web` 후 `npx vercel --prod`로 배포합니다. GitHub 자동 배포 연결은 아직 완료되지 않았으므로 push만으로 배포되지는 않습니다. 아래는 엔진의 기존 실증 설계와 개발 문서입니다.

## Q1. Nile에서 확인할 것

이 저장소의 실증 스크립트는 다음 순서로 실행한다.

1. Nile GasFree API에서 지원 토큰, Provider, 사용자 GasFree 계정의 nonce와 수수료를 조회한다.
2. 릴레이어가 `BatchFactory`를 배포한다. Factory는 `BatchExecutor` 구현을 한 번 배포한다. 배치마다 CSV의 Merkle root, 총액, 토큰, 환불 주소, 만료 시각, batchId에서 salt를 만들고 CREATE2로 경량 clone을 배포·초기화한다. 배포된 clone의 상태를 읽어 서명 메시지와 대조한다.
3. 사용자 키로 TIP-712 `PermitTransfer`를 **한 번** 서명한다. `receiver`는 배포된 BatchExecutor다. 공식 Nile Provider의 `POST /nile/api/v1/gasfree/submit`에 제출하고 traceId로 `SUCCEED`까지 조회한다.
4. USDT `balanceOf(BatchExecutor)`가 정확한 금액 이상인지 확인한다. 릴레이어가 `execute`를 호출하고 수취인의 잔액 증가와 `paid(0)`을 확인한다. 같은 행의 재실행이 거부되는지 조회한다.

실증 성공 조건은 **Provider 수락 + 온체인 입금 + 출금 + 중복 지급 거부**를 모두 만족하는 것이다. Provider가 단순 주소 형식 검사 이후 custom contract 수취인을 실제 허용하는지는 이 실증 전에 확정할 수 없다.

API를 실행할 때는 Factory를 한 번 배포하고 `.env`의 `NILE_FACTORY_ADDRESS`에 출력된 주소를 설정한다. `npm run deploy:factory`는 Nile TRX를 소비한다. 이후 `/batches`는 같은 Factory와 구현 컨트랙트에서 배치별 clone만 배포한다. 기존 전체 코드 배포용 Factory 주소는 재사용할 수 없다.

```bash
npm install
npm run check
cp .env.example .env
# .env를 채우고, Nile의 GasFree account에 테스트 USDT를 입금한다.
# 릴레이어에는 배포 및 execute용 Nile TRX를 준비한다.
node --env-file=.env scripts/nile-probe.cjs
```

`.env`에는 Nile 전용 사용자 키, 별도 릴레이어 키, [GasFree Developer Center](https://developer.gasfree.io/)의 API Key/Secret, 공식 Provider가 지원하는 Nile USDT 주소, 테스트 수취인 주소를 입력한다. 테스트용 사용자 키는 GasFree Permit 서명에만 쓰인다. 서드파티 서명을 지원하는 지갑 연동에서는 브라우저에서 사용자 승인을 받아 서명하며 개인키를 서버에 전달하지 않는다. 현재 TronLink 웹 경로는 위 수동 흐름을 사용한다. 테스트 계정의 GasFree 잔액에는 `amount + maxFee`가 필요하다. 생성한 `.env`는 Git에서 제외된다. 테스트는 배포와 송금으로 Nile 자산과 릴레이어 TRX를 소비한다.

GasFree 호출이 타임아웃되면 **같은 서명을 새 requestId로 즉시 재제출하지 말고** traceId와 계정 nonce/잔액을 먼저 확인한다. `SUCCEED`가 나온 뒤에는 입금 잔액을 확인하고 payout 단계로 진행한다. payout 타임아웃 후에는 `paid(index)` 및 체인 거래 결과를 확인한다. 온체인 `paid`가 이중 지급을 막는다. 실증 스크립트는 정상 경로를 한 번 실행하는 용도이며, 재실행하면 새 batch가 배포된다.

## Q2. Merkle root와 전체 목록 저장

| 항목 | Merkle root | 전체 목록을 컨트랙트에 저장 |
| --- | --- | --- |
| 배포 데이터 | root, 총액 등 일정한 크기 | 행 수에 비례해 증가 |
| 행별 실행 | `index`, 수취인, 금액, proof 제출 및 해시 검증 | `index`만 제출해 저장된 행을 읽음 |
| CSV 검증 | 브라우저가 원본에서 root와 총액을 계산해야 함 | 브라우저가 배포 시 저장 목록 전체를 확인해야 함 |
| 규모 | 수십~수백 행에 유리 | 아주 작은 고정 목록에서 구현이 단순 |
| 비용 경향 | 배포비가 낮고 행별 proof 검증비가 있음 | 배포 저장비가 크고 행별 실행이 간단함 |

100행 일괄 지급에는 Merkle 방식을 권장한다. 목록 저장 방식도 **배포 전에** 목록을 확정하고 주소를 사용자가 독립 계산해야 동일한 서명 보안 모델이 된다. 두 방식 모두 생성 코드, factory 주소, constructor 인자, 행의 순서와 금액 단위를 브라우저가 검증해야 한다. `CREATE2` 주소만 표시하는 것으로 CSV와의 결속이 자동으로 생기지는 않는다.

## Q3. 최소 컨트랙트

`BatchExecutor`의 구현 코드는 한 번 배포하고, 배치마다 clone을 만든다. Factory가 호출하는 `initialize()`는 clone의 `token`, `paymentsRoot`, `totalAmount`, `refundAddress`, `expiry`를 한 번만 설정한다. 변경 상태는 `paid[index]`, `paidAmount`, 재진입 잠금이다. 지급·환불 함수는 `execute(index, recipient, amount, proof)`와 `refund()`다. `execute`는 만료, 입금, proof, 중복, 총액 상한을 검사한 뒤 `paid[index]`를 먼저 기록하고 TRC-20 `transfer`를 실행한다. Nile USDT가 성공한 송금에서도 `false`를 반환하므로, 실제 송신·수신 잔액 변화를 검사한다. `refund`는 만료 후 미지급 잔액을 고정된 사용자 주소로 돌려준다. 전체 지급이 끝난 뒤 들어온 초과 토큰도 같은 주소로 돌려줄 수 있다. 환불은 예정 수취인에게 지급하는 작업과 다른 경로이므로 사용자 UI에서 이를 명확히 보여줘야 한다.

Merkle leaf는 `keccak256(abi.encode(uint256 index, address recipient, uint256 amount))`다. 주소는 TVM 내부 20바이트 주소로 인코딩하고, 짝 해시는 바이트 순으로 정렬해 `keccak256(left || right)`를 계산한다. 홀수 마지막 노드는 다음 단계로 그대로 올린다. 브라우저, 서버, 컨트랙트가 이 규칙을 동일하게 써야 한다.

이 컨트랙트 자체는 **root 안의 각 금액 합계가 `totalAmount`와 같은지 증명하지 않는다**. 사용자의 브라우저가 CSV를 파싱해 고유 인덱스, 수취인, 양수 금액, 합계, root를 검증해야 한다. Factory는 배치 설정값과 batchId를 salt에 포함하고 clone 생성·초기화를 한 트랜잭션에서 수행한다. 공식 Factory 주소와 구현 코드도 고정하고 실제 배포 코드 및 초기화 상태를 검증해야 서버가 다른 의미의 컨트랙트를 내밀지 못한다. BatchExecutor는 **배포 확인 후 GasFree 서명**을 받는다. 만료 전 지급을 완료하지 못하면 나머지는 환불될 수 있으므로 만료 시각과 릴레이어 처리 시간을 넉넉히 잡아야 한다. 실서비스 투입 전에는 TRON/Nile 실증, 수수료 측정, 보안 검토가 필요하다.

## 현재 검증 수준

`npm run check`는 로컬 EVM에서 모의 토큰으로 CREATE2 배포, 입금 전 지급 거부, 수취인/금액 변조 거부, 정상 지급, 중복 지급 거부, 만료 후 환불을 실행한다. TRON의 CREATE2 주소 공식은 별도로 계산한다. 로컬 EVM 결과가 TRON TVM이나 공식 GasFree Provider 정책을 증명하지는 않는다. Nile 실행은 `node --env-file=.env scripts/nile-probe.cjs`로 시작한다. 2026-09-28 실증 결과와 제한은 [NILE_RESULTS.md](NILE_RESULTS.md)를 참조한다.

공식 근거: [GasFree Developer Documentation](https://docs.gasfree.io/), [GasFree JS SDK](https://github.com/gasfreeio/gasfree-sdk-js/blob/main/src/TronGasFree.ts), [TRON CREATE2 차이](https://developers.tron.network/re/docs/migrating-eth-contracts-to-tron), [TronWeb TIP-712 서명](https://tronweb.network/docu/docs/6.0.0/API%20List/trx/signTypedData/).
