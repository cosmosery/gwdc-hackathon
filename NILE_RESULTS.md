> 과거 Nile 실험 기록입니다. 현재 배포는 [Settle 웹](https://settle-payroll-web.vercel.app), 현행 수동 GasFree 흐름과 서드파티 지원 범위는 [현재 연동 문서](docs/CURRENT_INTEGRATION_KO.md)를 참고하세요.

# Nile 실증 결과 — 2026-09-28

2026-09-28 결과는 전체 코드 배포형 BatchExecutor에 대한 기록이다. Factory + clone 결과는 다음 별도 절에 기록했다.

## 2026-09-29 Factory + clone E2E

- 새 Factory `TMQYoEzE4LagKinHjKE5GU3MLTtrcuGnFB`와 구현 `TWZ6tenu76YucUEjqpaY78d61vbn1Xwbkj`를 Nile에 배포했다. [Factory 배포 거래](https://nile.tronscan.org/transaction/07576d8da70bd26928ba4124c1cdf69be602ed425b2d1d68288c9c62a37345de/overview)는 `SUCCESS`다.
- [clone 생성 거래](https://nile.tronscan.org/transaction/49ae98a82565857a3c9148cf57da60f97c7beb8f2195e719ce3e0e5a015faf56/overview)도 `SUCCESS`다. clone 주소는 `TETK2qqP3gDLcifoTfBBtpBgV5U3YeAiLS`이며, 독립 계산한 CREATE2 주소와 Factory 이벤트 주소가 일치했다. clone의 `initialized`, 토큰, Merkle root, 총액 1 USDT, 만료 시각을 온체인에서 확인했다.
- 공식 GasFree Provider에 clone을 수취인으로 하는 1 USDT `PermitTransfer`를 제출했다. traceId `10b1980e-6c48-4ff2-a453-7dd30f209bae`는 `FAILED`, `txnHash=null`이다. GasFree 계정 nonce `0`, USDT 잔액 3개가 그대로여서 입금이 일어나지 않았다. Provider가 커스텀 컨트랙트를 금지하는지, 다른 이유로 실패했는지는 이 상태만으로 판단할 수 없다.
- 일반 TRC-20 [입금 거래](https://nile.tronscan.org/transaction/51901c48b4ef266dfc2f4a387395acee1cd09c2c82d032c7011276ef90c17627/overview)는 `SUCCESS`로 clone에 1 USDT가 도착했다. 첫 [지급 시도](https://nile.tronscan.org/transaction/02f6e9dfb87ed8797e454e83509f6111fbdcd5417226681a65e964e17ff090a0/overview)는 입금 확정 전 전송되어 `REVERT: not funded`였다. 해당 거래는 `paid(0)`를 변경하지 않았다. 스크립트를 영수증 `SUCCESS`를 기다리도록 수정했다.
- 같은 행의 [지급 재시도](https://nile.tronscan.org/transaction/78816481bbf62ea858e63a9a4d3b5717c19cb1b2df5634995fa4bf7f6aed3ad7/overview)는 `SUCCESS`다. 수취인에게 1 USDT가 도착했고, clone `paid(0)=true`, `paidAmount=1000000`, 잔액 `0`을 확인했다. 동일 행 재실행 시뮬레이션은 거부됐다.
- 이번 Nile 실행에서 사용자 테스트 지갑을 relayer로 사용했다. `.env`의 별도 relayer 키가 유효한 64자리 hex가 아니었기 때문이다. Factory 106.9535 TRX, clone 16.9954 TRX, 일반 입금 0.345 TRX, 실패한 첫 지급 2.2809 TRX, 성공한 지급 9.5769 TRX로 총 136.1517 TRX가 사용됐다. 이 수치는 테스트 당시 지갑의 에너지 상태와 배포 비용을 포함한다.

## 확인된 것

- TRON CREATE2 예측 주소와 Factory의 `BatchCreated` 이벤트에 기록된 주소가 일치했다. 내부 생성 컨트랙트는 Nile `getContract` 조회에서 `bytecode` 없이 `code_hash`만 반환할 수 있어 배포 확인 조건을 수정했다.
- 첫 컨트랙트 `TP5RUjxv88fMkngWX4shBtwnuiUKpM6TTK`는 직접 입금 1 USDT를 받았다. 지급 트랜잭션 `a632ab432163d2456445a321d45c0565f1326637e5b5a963179bc45f431315bd`는 `transfer failed`로 revert했다.
- 원인: Nile USDT의 정상 `transfer` 트랜잭션 `38432cf010c7f84fd6ca6ddfdd95232bccf84d3ca17508932421931d8ec07683` 및 `81125e30dbc179598f20e4f524ca77b6a1a9459c61c96b0725869e9183cddaa6`는 `SUCCESS`와 Transfer 로그가 있으나 반환 데이터는 `0x00…00`이다. 첫 버전은 이를 실패로 해석해 전체 지급을 되돌렸다.
- 수정본은 호출 성공 여부와 송신·수신 잔액 차이를 함께 검증한다. 새 BatchExecutor `TXa8D4wuNgyE3UueLhzCKWMUS74YgMCLSr`에 직접 입금 후 `execute(0, user, 1000000, [])`가 성공했다. 조회 결과 `paid(0)=true`, `paidAmount=1000000`, BatchExecutor 잔액 `0`이다. 같은 호출의 Nile 시뮬레이션은 `already paid`로 revert했다. 로컬 모의 토큰에서도 `false`를 반환하면서 실제 송금하는 경우를 재현해 통과했다.

## GasFree 결과

2026-09-28 17:36 UTC 추가 대조군: 새 EOA의 GasFree 주소 `THs7vY1Qvs6L6ht8RRkoYwuMpdJUTYPh1G`를 Provider `/address/{accountAddress}`로 확인한 뒤, 기존 GasFree 계정에서 이 주소로 1 USDT를 보내는 Permit을 1건 제출했다. traceId는 `bf2379b2-d9ed-4442-bfc1-44c246ce665d`이다. 이 건도 접수 직후 `FAILED`, `txnHash=null`, `txnState=null`, `txnTotalCost=null`이었다. 재조회 결과 발신 GasFree 잔액은 3 USDT, 수신 GasFree 잔액은 0, 발신 nonce는 0, `frozen=0`이다. 따라서 실제 송금과 수수료 차감은 없었다. 새 수취 EOA의 개인키는 Git에서 제외되는 로컬 `.env`의 `NILE_OTHER_GASFREE_PRIVATE_KEY`에 보관했다.

공식 Nile Provider는 BatchExecutor 수취인 Permit을 접수해 traceId `3279619d-787e-4859-bccd-7c37878334f5`를 발급했지만 상태가 `FAILED`로 끝났고 `txnHash`는 없었다. 일반 사용자 EOA 수취인 대조군도 traceId `cf0052cd-c873-4aa0-90c2-4b20ae214fd7`에서 동일하게 실패했다. 수수료 상한을 높인 EOA 대조군 traceId `90cb1f6a-9c17-4d90-8945-c02e837a83a3`도 실패했다. 따라서 **이번 실증은 custom contract receiver 허용 여부를 판정하지 못했다.** Provider API가 실패 사유를 반환하지 않아 원인은 미확정이다. 공식 SDK가 생성하는 TIP-712 domain, types, message와 스크립트의 값은 일치했다.

같은 GasFree 계정 `TPQZQ6EuNcjtMbnTebaWNqRrVf6XLZvWke`을 receiver로 둔 0.1 USDT 대조 요청도 traceId `95efb763-85c6-4985-a963-26d3f9b20a9e`에서 `FAILED`로 끝났다. `txnHash`는 없었고 계정 nonce `0`, 비활성 상태, 잔액 3 USDT는 그대로였다. 자기 자신에게 송금하는 요청에 별도 제한이 있을 수 있으므로, 이 결과만으로 Provider의 일반 송금 전체 장애를 단정하지 않는다.

2026-09-28 17:10 UTC 재조회: Provider 요청은 총 **5건**이다. 다섯 건 모두 `FAILED`, `txnHash=null`, `txnTotalCost=null`이며 GasFree 계정 nonce는 `0`, 잔액은 3 USDT다. 첫 두 건에 표시된 **2.3 USDT는 `estimatedTotalCost`**로, 1 USDT 송금액 + 1 USDT 활성화 수수료 + 0.3 USDT 송금 수수료의 예상 합계다. 나머지 세 건의 예상 합계는 각각 1.4 USDT다. Nile USDT Transfer 기록에는 사용자 EOA에서 GasFree 계정으로 **입금한 3 USDT 한 건만** 있으며, GasFree 계정에서 나간 Transfer는 없다. 따라서 이 다섯 요청에서 2.3 USDT가 실제 차감됐다는 온체인 증거는 없다.

실패 원인 추가 조사: 공식 SDK로 구성한 TIP-712 메시지의 사용자 서명을 로컬 검증했고 유효했다. Nile GasFreeController의 구현 컨트랙트에서 Provider 설정 주소에 대응하는 등록 signer `TR2F1ankFfFKhNqDHfMaeD9GvqeWJtR7P9`가 `isSignerSupported=true`임을 확인했다. 이 signer를 발신자로 지정해 `permitTransfer`를 **방송하지 않는** `triggerconstantcontract`에서 실행한 결과, 일반 EOA 수취인과 수정본 BatchExecutor 수취인 모두 성공했다(각각 Energy 208792, 223792). 이는 해당 온체인 조건이 현재 상태에서 실행 가능함을 보여주지만, Provider 서비스가 실제로 서명·전송할 때 쓰는 계정과 내부 검증·정책은 검증하지 않는다. 5건 모두 `txnHash=null`이므로 실패 지점은 Provider 접수 후 온체인 방송 전이다. 구체적인 서버 측 실패 원인은 Provider 로그 또는 지원 응답이 필요하다.

2026-09-28 17:21 UTC 최근 거래 조회: 공식 Nile GasFreeController `THQGuFzL87ZqhxkgqYEryRAd7gqFqL5rdc`의 가장 최근 성공한 `permitTransfer`는 [2026-09-23 04:04:42 UTC의 거래](https://nile.tronscan.org/transaction/86c345ac79e8913004ff5428c598c95dce60f0e7ae7cc7c5e6bbf9987f99746c)다. 등록 signer `TR2F1ankFfFKhNqDHfMaeD9GvqeWJtR7P9`가 호출했고, Nile USDT Transfer 이벤트로 0.3 USDT 수수료와 0.000001 USDT 수취인 지급이 확인됐다. 9월 27일에는 `deployGasFree` 성공 거래 2건과 실패 호출 1건이 있었지만 성공한 `permitTransfer`는 없었다. 조회 시점부터 직전 5일 이상 공식 Controller의 성공 송금 거래는 확인되지 않는다. 이 사실만으로 Provider 서비스 장애를 확정할 수는 없다.

## 자산 상태와 후속 조치

2026-09-28 17:41 UTC 활성화: GasFreeController의 `deployGasFree(user)`를 사용자 EOA에서 직접 호출한 Nile 거래 [`0dbe922ef0b15a21468654f159897daccdb95a589c5045ae5c1d9f21f8122037`](https://nile.tronscan.org/transaction/0dbe922ef0b15a21468654f159897daccdb95a589c5045ae5c1d9f21f8122037)가 `SUCCESS`로 확정됐다. GasFree 계정 `TPQZQ6EuNcjtMbnTebaWNqRrVf6XLZvWke`의 컨트랙트가 배포됐고 Provider `/address/{accountAddress}`는 `active=true`를 반환한다. 사용자 EOA TRX는 `659051600`→`644489700` sun으로 **14.5619 테스트 TRX** 감소했다(영수증 Energy fee 14.2489 TRX + Net fee 0.313 TRX). 이는 직접 배포의 네트워크 비용으로, GasFree의 1 USDT 활성화 수수료를 별도 결제한 것은 아니다. GasFree 송금 성공 여부는 아직 다시 검증하지 않았다.

활성화 후 EOA 수취인 `TPCozYqnistWHH9VaoJtjXp5djKX4VJgai`에게 1 USDT를 보내는 GasFree 요청도 두 번 실패했다. 첫 요청 `9ed82939-4de4-4632-829d-15f0ce6b1325`는 기존 스크립트의 추가 `requestId` 필드를 포함했고, 두 번째 `27ee5457-0732-4eda-bc63-5d37dddc10a2`는 명세의 제출 필드만 포함했다. 두 건 모두 즉시 `FAILED`, `txnHash=null`, `txnState=null`, `txnTotalCost=null`로 종료됐다. Provider 계정은 `active=true`, `nonce=0`, `allowSubmit=true`이고 GasFree 3 USDT 및 EOA 996 USDT 잔액은 그대로다. 따라서 활성화 여부와 추가 `requestId` 필드는 이 실패를 설명하지 못한다. Provider 내부 실패 원인은 여전히 미확정이다.

활성 GasFree 계정 수취인 대조: 기존에 만든 별도 EOA `TPs87QEVYb6N9g7a8q23eRFf6BrqQLqTJX`의 GasFree 주소 `THs7vY1Qvs6L6ht8RRkoYwuMpdJUTYPh1G`를 직접 배포했다. [배포 거래 `65102c546f5e9fc9672bb09ddca718df5caf152f8cb4016ef940ed0a8a22044e`](https://nile.tronscan.org/transaction/65102c546f5e9fc9672bb09ddca718df5caf152f8cb4016ef940ed0a8a22044e)는 `SUCCESS`; EOA가 **14.5619 테스트 TRX**를 지출했고 Provider는 수취 계정을 `active=true`로 표시한다. 그 뒤 원래 GasFree 계정에서 이 활성 GasFree 계정으로 1 USDT를 보내는 공식 필드만의 요청 `7801e984-8995-48bf-bc3d-05b6518cf3aa`를 제출했지만 즉시 `FAILED`, `txnHash=null`, `txnState=null`, `txnTotalCost=null`이었다. 발신 GasFree 잔액 3 USDT, 수신 0, 발신 nonce 0으로 변동이 없다. 양쪽이 모두 활성 상태여도 Provider 송금 실패가 재현된다.

USDD 확인: 사용자 EOA `TPCozYqnistWHH9VaoJtjXp5djKX4VJgai`에는 Nile 토큰 `TFT7sNiNDGZcqL7z7dwXUPpxrx1Ewk8iGL`의 **2,000 USDD**가 있다(`symbol=USDD`, `name=Decentralized USD`, `decimals=18`). 앞서 USDD 잔액이 0이라고 한 것은 다른 컨트랙트 `TYQF9cAeJ3Faq8QXpHxTcFco72DRCQbgFt`만 조회한 결과였다. Provider `/config/token/all`에는 USDD로 `TYQF9cAeJ3Faq8QXpHxTcFco72DRCQbgFt`만 지원된다고 표시되어, 사용자 보유 `TFT7...`는 현재 Provider 지원 목록에 없다. 두 주소는 별도 토큰이므로 TFT7 USDD를 GasFree 계정에 보내지 않았다.

요청 파라미터 재감사(읽기 전용): 활성 계정의 USDT 1 USDT 전송에서 `value=1000000`, `maxFee=300000`, `nonce=0`, `version=1`을 공식 SDK `assembleGasFreeTransactionJson` 결과 및 컨트롤러 상태와 비교했다. 컨트롤러 `tokenFees(USDT)=300000`, `activateFees(USDT)=1000000`, `nonces(user)=0`, `isTokenSupported(USDT)=true`, `isVersionSupported(1)=true`; Provider의 180초 deadline은 허용 범위 60~3600초이고 로컬 시계와 Provider HTTP Date는 0초 차이였다. 같은 메시지를 새로 서명했을 때 `verifyTypedData=true`, 등록된 Provider signer `TR2F1ankFfFKhNqDHfMaeD9GvqeWJtR7P9`를 호출자로 한 `permitTransfer` 읽기 전용 시뮬레이션도 성공했다(energy 67,573). 이는 현재 파라미터·서명·온체인 선행 조건이 맞음을 보여주지만 Provider의 과거 내부 실패 원인을 증명하지는 않는다. 새 공식 사이트 명세에는 `requestId`가 선택 필드로 명시돼 있다. 이 필드를 포함한 요청과 제외한 요청 모두 실패했으므로 원인으로 볼 수 없다. 향후 Provider 문의에 도움이 되도록 스크립트는 다시 UUID4 `requestId`를 생성해 출력한다.

문서 노후화 가설 확인: 현재 Nile 컨트롤러 `eip712Domain()`을 직접 디코딩하면 `GasFreeController`, `V1.0.0`, chainId `3448148188`, verifying contract `THQGuFzL87ZqhxkgqYEryRAd7gqFqL5rdc`로 문서 및 공식 SDK 1.1.2와 일치한다. 2026-09-23 04:04 UTC 실제 성공한 [`permitTransfer` 거래 `86c345ac79e8913004ff5428c598c95dce60f0e7ae7cc7c5e6bbf9987f99746c`](https://nile.tronscan.org/transaction/86c345ac79e8913004ff5428c598c95dce60f0e7ae7cc7c5e6bbf9987f99746c)를 디코딩한 결과 현재와 같은 selector `0x6f21b898`, Provider signer, USDT 컨트랙트, `receiver=user`, 수수료 상한 `300000`, version `1`, 65바이트 서명을 사용했다. 그 거래의 서명은 문서화된 TIP-712 메시지 스키마로 재검증해 `true`였다. 따라서 적어도 9월 23일 성공 시점의 온체인 서명/호출 규칙은 문서와 같았다. 이후 Provider 백엔드가 별도 변경됐는지는 공개 자료로 확정할 수 없다.

9월 23일 성공 거래 형식 재현(2026-09-28 18:17 UTC): 같은 USDT 컨트랙트, Provider, 함수 메시지 구조, `receiver=user`, `value=1` micro-USDT, `maxFee=300000`, 180초 deadline, version 1로 새 사용자 서명/nonce 0을 제출했다. 이전 성공 거래의 `value=1`, `maxFee=300000`, broadcast 시 deadline 잔여 177초와 사실상 같은 조건이다. 새 traceId `66575854-02e3-4fdd-a419-8caf2bd63de6`은 `FAILED`, `txnHash=null`, `txnState=null`, 실제 비용 필드 null이었다. Provider 예상 비용은 300001 micro-USDT였으나 발신 GasFree 잔액 3 USDT, 수취 EOA 잔액 996 USDT, 발신 nonce 0으로 변화가 없다. 성공 거래의 user/nonce/signature는 다른 계정에 묶여 있어 그대로 재사용할 수 없다.

9월 23일 성공 거래의 **실제 수취 주소** 재현: 성공 거래의 `receiver=TXxoKoA8ZHnVq5fjtCapXvxmiDPKhGNWSN`으로 1 micro-USDT, `maxFee=300000`, 180초 deadline, version 1을 제출했다. traceId `01636a4b-2595-4ae3-8a83-7a7721af0d98`은 `FAILED`, `txnHash=null`, `txnState=null`, 실제 비용 null이다. 발신 GasFree 잔액 3 USDT, 수취 주소 잔액 944.999965 USDT, 발신 nonce 0이 그대로다. 따라서 수취 주소 차이도 이번 실패를 설명하지 못한다. 남은 차이는 발신 사용자/계정, nonce, 서명, Provider 내부 실행 시점이다.

2026-09-28 18:22 UTC `rtk` 없이 새 요청 재실행: 성공 거래의 실제 수취 주소로 1 micro-USDT, `maxFee=300000` 요청을 새로 제출했고 traceId는 `5da92169-1081-4233-918e-f2a518466634`다. 18:23:12 UTC Provider API 직접 재조회 결과 `code=200`, `state=FAILED`, `txnHash=null`, `txnState=null`, `amount=1`, 예상 총비용 `300001` micro-USDT. 18:23:22 UTC Nile 체인 직접 재조회에서 발신 3 USDT, 수취 944.999965 USDT, nonce 0으로 변동이 없었다. 이 결과는 이전 저장 로그가 아니라 같은 시각 새로 호출한 API와 체인 응답이다.

현행 `https://gasfree.io/specification?lang=en-US` 비교: 새 문서의 Nile API 경로와 Permit 서명 필드는 기존 코드와 같다. 추가 차이는 선택 `requestId`(UUID4, 문제 조회용)이며, `GET /api/v1/gasfree/{traceId}` 상태 응답에도 상세 실패 사유 필드는 없다. 공개 테스트 사이트 `https://test.gasfree.io/`의 현재 프런트엔드 번들은 Nile `serviceProvider`를 `TCETRh3aED4kdkaYQY7CcxeTJtrQvwBpNT`로 하드코딩한다. 반면 Provider API `/config/provider/all`은 `TKtWbdzEq5ss9vTS9kwRhBp5mXmBfBns3E`를 반환하고, Nile 컨트롤러 `isServiceProviderAdmin`은 `TCET...=false`, `TKtW...=true`다. 따라서 테스트 사이트 UI 자체는 현재 API/온체인 상태와 불일치해 독립적인 정상 대조군으로 보기 어렵다. 이 불일치가 우리 API 호출의 `FAILED` 원인이라는 증거는 없다.

2026-09-28 19:02 UTC 사용자 요청으로 본인 EOA `TPCozYqnistWHH9VaoJtjXp5djKX4VJgai`에 최소 단위 1 micro-USDT를 한 번 더 제출했다. `requestId=259be4eb-e8a2-4f08-b027-7a491d2a8482`, `traceId=f617df37-b8b8-4bcf-b047-dec11c8dea0a`, `maxFee=300000` micro-USDT. Provider 재조회에서 `FAILED`, `txnHash=null`, `txnTotalCost=null`이었고, 발신 GasFree 계정은 `active=true`, `nonce=0`이다. Nile 토큰 컨트랙트 잔액 재조회에서 GasFree 3 USDT, 사용자 EOA 996 USDT로 변화가 없었다.

- 사용자 EOA Nile USDT: `996000000` base units (996 USDT)
- GasFree 계정 Nile USDT: `3000000` base units (3 USDT)
- 첫 BatchExecutor Nile USDT: `1000000` base units (1 USDT), `paid(0)=false`
- 수정본 BatchExecutor Nile USDT: `0`, `paid(0)=true`

첫 BatchExecutor는 불변 코드가 `false` 반환을 허용하지 않아 `execute`뿐 아니라 `refund`도 같은 이유로 실패할 것으로 예상된다. **그 1 테스트 USDT는 현재 코드로 회수할 수 없다.** 이는 Nile 테스트 자산이지만 실제 손실로 기록해야 한다. Provider의 `FAILED` 상세 원인 확인과 정상 EOA GasFree 송금 성공이 선행돼야 custom receiver 실증을 다시 해석할 수 있다. 재시험 때는 수정본 컨트랙트와 유효한 별도 릴레이어 키를 사용한다.
