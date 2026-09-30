> **현재 배포:** [Settle 웹](https://settle-payroll-web.vercel.app) · [현행 실행 흐름과 지갑 지원 범위](CURRENT_INTEGRATION_KO.md). 현재는 TronLink GasFree 수동 입금 후 `/execute`에 `mode: direct`를 전송합니다. 서드파티 지원 지갑의 사용자 승인 후 자동 제출 경로는 현재 웹에서 활성화되지 않았습니다.

> 현재 흐름과 최신 원격 API 재검증은 [CURRENT_INTEGRATION_KO.md](CURRENT_INTEGRATION_KO.md)를 기준으로 확인하세요. 아래 내용은 작업 시점의 이력을 포함합니다.

# 프론트·엔진 통합 인계 (2026-09-29)

## 기준과 실행

원격 커밋 `a3cae8b` (financial reconciliation API / failure catalog)를 fast-forward 병합했다. 프론트 변경은 로컬에 있으며 아직 커밋·푸시하지 않았다.

```sh
npm install
npm --prefix web ci
npm start
# 별도 터미널
npm run dev:web
```

화면 http://127.0.0.1:5173 / 로컬 BFF 3478 / 엔진 3000. 루트 `.env`의 `API_BEARER_TOKEN`이 엔진과 BFF에 필요하다. 키·Secret은 브라우저 번들에 넣지 않는다. 현재 BFF는 로컬 개발용이며 사용자·tenant 인증을 제공하지 않는다.

## 구현된 범위

- React/TypeScript 프론트: CSV 검토 → 견적/승인 검토 → 행별 진행 → 결과/대사.
- UTF-8, 헤더, 주소 체크섬, 소수점 6자리와 양수 금액, 기본 메타데이터 검증. 금액 합산은 BigInt.
- 경고 확인, 오류 수정, 제외/복원, 제출에서 빠진 행 명시. 오류는 경고 확인으로 통과하지 않는다.
- 실제 `POST /quote`, `GET /health`, `GET /batches/:id`, `/payments`, `/reconciliation` 어댑터. 배치는 ID로 조회하고 3초 간격으로 갱신한다.
- Demo는 실제 요청/트랜잭션과 분리. 성공, 부분 실패, 결과 불명, 릴레이어 자원 부족, 대사 불일치, 환불 대기 시나리오와 CSV 내보내기.
- BFF 허용 경로 제한. 실행·재시도·환불 요청을 프론트에서 전달하지 않는다.

## 병합 후에도 남은 계약 공백

1. **지갑 서명과 실행**: signing context, nonce/provider/domain, BatchExecutor commitment 검증, 승인 패키지·예산 예약이 연결되어야 한다. 현재 Live 서명 버튼은 비활성화했다. 실제 송금 E2E 완료를 주장하지 않는다.
2. **수수료**: `src/server.cjs`의 릴레이어 견적은 `20 + 15 × N` TRX 공식이다. 고객 총 수수료 상한과 초과 부담/잔액 반환 원장은 구현되지 않았다. GasFree maxFee와 릴레이어 TRX 비용은 별개다.
3. **대사 증빙**: `src/reconciler.cjs`가 `estimatedTotalFee` 또는 기본 0.3 USDT를 actualFeesTotal로 사용할 수 있다. actualDecrease도 독립적인 전후 잔액이 아닌 내부 지급 합계로 만든다. 조회 실패 시 DB 값으로 대체하므로 FINAL만으로 실제 잔액 대사를 입증할 수 없다. 화면은 engine-reported와 Verification pending을 표시한다. 실제 fee source, chain snapshot/block, 증빙 조회 실패 상태를 계약에 추가해야 한다.
4. **행별 수수료**: 현재 정수 나눗셈 배분은 잔여 최소 단위를 버리고 실패 행에는 null을 반환해 행별 합과 전체가 다를 수 있다. 배분 규칙 합의가 필요하다.
5. **실패 복구 정책**: INSUFFICIENT_FEE의 TOP_UP_TRX/USER_ACTION은 고객 추가 결제 없이 운영자가 처리한다는 정책과 정합화해야 한다. TIMEOUT은 기존 요청 확인 후 재전송 여부를 결정해야 한다.
6. **preflight 완성도**: 현재는 미리보기 검증기다. tenant 전체 중복 조회, 승인 버전/TTL, canonical hash, 원본 파일 영속화와 CSV 메타데이터 왕복 계약은 미연결이다. sourceRow는 물리적 줄 번호가 아닌 논리적 CSV 레코드 번호다. 국가 코드는 두 글자 형식 검사만 한다.
7. **만료 후 회수**: 아직 배포되지 않은 executor가 만료되면 배포 초기화의 만료 검사 때문에 환불 경로가 막힐 가능성을 엔진에서 검증해야 한다.

## 검증 결과

- `npm run build:web`: TypeScript 및 Vite production build 통과.
- `npm run test:web`: 6개 통과 (금액 정밀도, 주소 체크섬, 경고/오류, 헤더, CSV 수식 방지, 응답 단위 검증).
- `npm run check`: 로컬 컨트랙트 컴파일, Merkle, CREATE2, funding gate, 변조/중복 거부, 지급, 만료 환불 통과. Ganache native µWS 불일치로 JS fallback 사용.
- 실제 Chrome: 샘플 4행 → 경고 확인 후 3행/3,190.5 USDT → 데모 승인 → 3/3 결과 화면 확인.
- Live API 견적: 동일 3행의 원금 3,190.5 USDT, GasFree 추정 0.3 USDT, 릴레이어 추정 65 TRX 응답 표시 확인. 온체인 시뮬레이션 비용으로 해석하면 안 된다.
- BFF health 200, 실행 경로 404, 외부 Origin 견적 요청 403 확인.
- 기존 배치의 실제 지급/대사 데이터로 완료한 브라우저 E2E는 미검증. Nile 재시도 엔드포인트를 실행하는 기존 `npm test`는 이번 UI 검증에서 실행하지 않았다.

## 코드 경계

`web/src/domain.ts`: CSV·금액·검증 모델 / `web/src/api.ts`: 엔진 어댑터 / `web/src/main.tsx`: 화면 / `web/src/style.css`: 디자인 / `scripts/frontend-dev.cjs`: 개발 BFF.

다음 통합에서는 실제 preflight 모듈이 domain 검증을 대체하고, signing context·예산 계약을 붙인 뒤 실제 서명/실행을 열어야 한다. tenant/session 인증을 먼저 정의하고 엔진 bearer를 고객 인증으로 재사용하지 않는다.

## 추가 엔진 시나리오 검증

`ENGINE_SCENARIO_TEST_REPORT.md` 참고. 83개 시나리오 중 69개 통과, 14개 실패. 개별 재시도·대사·환불의 결함이 재현됐으므로 기존 UI/빌드 통과를 엔진 전체 정상으로 해석하면 안 된다.

## E2E 수정 반영 (후속)

최신 상태는 ENGINE_SCENARIO_TEST_REPORT.md를 따른다. 엔진 관련 97개 통과. 기존 actual fee fallback과 잘못된 FINAL 발급은 제거했고 프론트 타입은 nullable balanceCheck에 맞췄다. fee 예산 원장과 wallet 서명은 여전히 미구현. 컨트랙트 수정은 새 Factory 배포가 필요하며 기존 on-chain 주소에는 적용되지 않는다. 제출 영상/피치덱 요구는 SUBMISSION_DELIVERABLES.md 참고.
