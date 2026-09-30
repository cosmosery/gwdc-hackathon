> **현재 배포:** [Settle 웹](https://settle-payroll-web.vercel.app) · [현행 실행 흐름과 지갑 지원 범위](CURRENT_INTEGRATION_KO.md). 현재는 TronLink GasFree 수동 입금 후 `/execute`에 `mode: direct`를 전송합니다. 서드파티 지원 지갑의 사용자 승인 후 자동 제출 경로는 현재 웹에서 활성화되지 않았습니다.

> 아래 실험 결과·원본 계약은 해당 작성 시점의 기록입니다. 당시 성공/실패 사실은 보존하며 현재 배포 기능·최신 계약은 위 문서를 우선합니다.

# Nile 실제 엔진 E2E 및 만료 회수 검증

2026-09-29. 모든 자금은 Nile 테스트 토큰이며 mainnet 송금은 없다.

## 준비

공식 Nile faucet에서 릴레이어 `TXijs8r732nDvULaPCPFDSDebcFLhkgGAL`로 1,000 테스트 TRX 수령을 RPC 잔액으로 확인했다. 사용자 CAPTCHA 완료 후 faucet은 재요청에 이미 수령했다고 응답했고, 이후 입금이 반영됐다.

수정 Factory: `TXsZ8vWS5h6c7H7XpvY4jKk1tWf1dVGYN8`. implementation: `TBhmanfkJeszULsfNv3zXb3Jx5oTPKGj5g`. 소스 hash는 artifacts/nile-factory-v2.json에 기록했다. 기존 Factory/기존 배치 코드를 바꾼 것은 아니다.

## 정상 지급 E2E — PASS

실제 Fastify API의 quote → create batch → TIP-712 서명 검증 → GasFree submit → 입금 confirmed → lazy deployment → payout → paid bitmap 및 잔액 검증. 지갑 팝업 대신 로컬 실험용 키로 서명한 엔진 API 테스트다. 브라우저 지갑 연결 E2E 완료를 뜻하지 않는다.

- batchId: `b_1790687324263_3046dd2e`
- 입금/지급 원금: 0.1 테스트 USDT
- Provider 기록 실제 수수료: 0.3 테스트 USDT
- 수취인: `TQZE7vxcx9qr6d8BczbYYLwfeHJ5ZbDj7c` (실험 지갑으로 회수하는 자가 송금)
- Executor: `TXkQ1bo8o81XHsHmyB9yocxb5cNGjV2qT2`
- 지급 receipt: SUCCESS, block 71386803
- 지급 tx의 실제 fee: 11076900 sun (배포 비용 및 GasFree USDT 수수료와 별도)
- 동일 Idempotency-Key 재요청에서 기존 traceId를 반환하고 신규 입금을 만들지 않음.
- confirmed `paid(0)=true`, Executor 잔액 0 검증.

[GasFree 입금](https://nile.tronscan.org/#/transaction/8b55aff8dbef5152d0214bb8feeb13629ff547b9378de80e2da6042372633d19) · [최종 지급](https://nile.tronscan.org/#/transaction/c31de4eab2b7c4ef401eaf4e00c3a7f150347fd5adbfb3c0870cda9edd3af4b5) · [로컬 대시보드](http://127.0.0.1:5173/?batch=b_1790687324263_3046dd2e)

## 만료·미배포 회수 회귀 검사 — PASS

일반 batch 생성 API의 만료 제한을 우회해 고객 배치를 만들었다는 뜻이 아니다. 회수 결함 재현을 위해 테스트 harness가 이미 만료된 예상 주소와 READY 레코드를 구성하고, 실제 GasFree 소액 입금 후 엔진 `/refund` API를 실행했다. 일반 생성 API는 여전히 최소 300초를 요구한다.

- batchId: `refund_regression_2ad33f280c0841a1b6a1bd5c7b055759`
- 입금 당시 Executor 미배포 확인
- 만료 후 수정 Factory에서 배포 → 원래 refundAddress로 0.1 테스트 USDT 회수
- confirmed owner 잔액 증가 100000 atomic, Executor 잔액 0
- DB 상태 REFUNDED, refund_state CONFIRMED
- Provider 조회 중 `fetch failed`가 발생했지만 기존 traceId를 사용해 재개했으며 새 permit을 제출하지 않음.

[회귀 검사 입금](https://nile.tronscan.org/#/transaction/b2523e914cba07ef768bb34327e8fe6a6116ba0da642a011cf29ea3003d39002) · [실제 환불](https://nile.tronscan.org/#/transaction/9c68d68c7802c13b1228d23a8c8b39b163dc7bfe8897ef6f9f3d35788297f951) · [환불 대시보드](http://127.0.0.1:5173/?batch=refund_regression_2ad33f280c0841a1b6a1bd5c7b055759)

## 함께 수정한 사항

- 배포·재시도·환불은 현재 env가 아니라 배치에 저장된 Factory와 Executor에 결속. 예상 주소가 달라지면 배포 거부.
- implementation 캐시를 Factory 주소별로 분리.
- Provider HTTP/application 오류와 불완전 schema를 정상 빈 응답으로 취급하지 않음. 요청 timeout 15초.
- SSE query 인증 옵션의 경로 판별 및 Fastify raw stream 연결 처리 수정, disconnect listener 해제 검증.
- 대시보드 batch URL 복구, 실제 chain 링크, 지급 완료와 재무 증빙 대기 구분, 환불 완료한 미지급 행 표시 수정.

## 검증 합계와 남은 범위

엔진 시나리오 81, 로컬 컨트랙트 11, TRON/SQLite 경계 6, Provider 경계 8, SSE 1: 총 107개 통과. 별도 프론트 6개 및 build 통과. 위 두 live Nile 시나리오는 별도 증빙이다.

일반 고객의 wallet 연결/서명 UI, fee 예산 예약·원장 정산, 독립적인 전후 잔액 snapshot을 이용한 재무 FINAL, 실제 AI 판단 기능은 남아 있다. 대사 PARTIAL/Evidence pending은 지급 실패가 아니라 재무 증빙 미완성이다. 이번 단건 실측 비용을 전체 CSV 배치나 mainnet 수수료 상한의 근거로 확대 해석하지 않는다.

원시 증빙: artifacts/nile-engine-e2e.json, artifacts/nile-expired-refund.json. CAPTCHA/개인키/API Secret/서명은 증빙에 포함하지 않는다.
