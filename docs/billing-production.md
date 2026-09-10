# OKRI 결제 운영 연결

## 2026-09-10 확인 결과

- 출시 순서는 국내 Payple 우선, 해외 PayPal 후속으로 결정했다. 운영값이 없는 결제수단은 고객 화면에 표시하지 않는다.
- 운영 환경에는 Payple/PayPal 상점 키가 없었다. `BILLING_ENFORCEMENT_ENABLED=false`였다.
- Free의 활성 편집자 기준은 서버·화면·약관 모두 5명으로 변경했다.
- Team은 활성 편집 멤버 1명당 월 2,900원, Business는 4,900원(VAT 포함)으로 변경했다.
- Owner·Admin·Member 중 활성 상태만 과금하며 Viewer와 초대 대기자는 과금하지 않는다.
- Free는 월 Project 30개, 최근 3개월 활동·변경 기록, Project 이미지 1GB를 제공한다. Team은 편집 멤버당 5GB, Business는 20GB를 워크스페이스에서 합산해 사용하며 Project와 활동 기록 조회 기간은 제한하지 않는다.
- ChatGPT·Claude에서 OKRI를 사용하는 연결은 모든 플랜에서 OKRI 측 횟수 제한 없이 제공한다. 고객 가격표에는 MCP 대신 사용자가 아는 제품명을 표시한다.
- 고객 화면의 운영 설정/사전 배포 설명은 제거했다. 실제로 검증한 결제 옵션만 노출한다.
- PayPal REST 구독·거래 확인·서명 검증 webhook·해지·첫 결제 환불을 추가했다.
- PayPal 비즈니스 계정, 운영 REST 앱, 실제 상품 가격은 소유자가 연결해야 한다.
  모의 테스트 통과를 실결제 또는 상점 승인 완료로 보고하지 않는다.
- 기존 Payple 어댑터는 상점별 운영 API 계약 검증이 남아 있다. 키만 복사해서 활성화하지 않는다.

## PayPal 연결

PayPal 한국 비즈니스 계정으로 해외 구매자의 결제를 받는 경로다.
한국 계정 간 국내 거래는 지원되지 않는다. 웹의 Google 로그인/Google Pay는
Google Play 구독 결제가 아니다. 현재 저장소에는 Play 스토어에 배포된 Android 앱과
Play Billing 상품/구매 검증 구성이 없다.

Sites 런타임에 다음 값을 보관한다. 다른 서비스의 상점 키를 가져오지 않는다.

- `PAYPAL_ENVIRONMENT`: 운영은 `live`, 별도 검증 환경은 `sandbox`
- `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`(secret)
- `PAYPAL_TEAM_PLAN_ID`, `PAYPAL_BUSINESS_PLAN_ID`
- `PAYPAL_WEBHOOK_ID`
- `OKRI_PUBLIC_URL=https://okri.ai`

플랜은 ACTIVE, 고정 월간/무기한, 수량 사용 가능, 무료 체험/설정비 없음으로 만든다.
`payment_preferences.auto_bill_outstanding=false`로 설정한다. 별도 세금이 있으면
표시 가격에 포함되어야 한다. 금액은 사업자가 승인한 실제 통화/가격을 사용하며
코드에서 원화를 임의 환율로 환산하지 않는다. 화면의 금액과 승인 직전 서버 금액이
다르면 새 가격을 확인하도록 결제를 중단한다. 플랜의 고정 가격은 1인당 요금이고
구독 수량은 승인 시점의 활성 편집 멤버 수다. 이후 인원이 달라지면 Owner가 PayPal에서
다음 결제 금액 변경을 승인해야 하며, 승인 전에는 기존 수량을 유지한다.

웹훅 URL: `https://okri.ai/api/billing/paypal/webhook`

이벤트: `BILLING.SUBSCRIPTION.ACTIVATED`, `BILLING.SUBSCRIPTION.CANCELLED`,
`BILLING.SUBSCRIPTION.SUSPENDED`, `BILLING.SUBSCRIPTION.EXPIRED`,
`BILLING.SUBSCRIPTION.PAYMENT.FAILED`, `PAYMENT.SALE.COMPLETED`,
`PAYMENT.SALE.REFUNDED`, `PAYMENT.SALE.REVERSED`.

기존 Worker 예약 핸들러에 15분마다 PayPal 상태를 대조하는 경로를 연결했다.
운영 트리거의 실행 여부는 별도로 확인해야 한다. `/api/internal/billing/run`은
서명된 복구 경로이며 GitHub의 시간당 실행과 수동 실행에서도 호출한다.
실행당 가장 오래 확인하지 않은 5개 구독을 처리한다. 구독 수가 늘면 전용 큐로 확장한다. PayPal 구독은
기존 Payple 예약 청구에서 제외하여 이중 청구하지 않는다. 읽기에서도 유료 기간
만료를 확인하므로 webhook 누락만으로 유료 권한이 무기한 유지되지 않는다.
반대로 갱신 알림이 누락되어도 주기적 대조나 소유자의 '결제 상태 확인'으로 복구한다.

구독 생성은 워크스페이스별 잠금과 영속 요청 ID를 사용한다. 응답 유실 때 같은
ID로 재시도하며, 48시간이 지나도 생성 결과가 불분명하면 관리자 대조 전까지
새 구독을 만들지 않는다. 브라우저가 넘긴 구독 ID로 권한을 주지 않는다.
환불과 취소가 최종 확인되어야 권한을 변경하며, 워크스페이스 삭제 전에 갱신을 중단한다.
PayPal 거래 원문/이름/주소/카드는 저장하지 않고 식별번호·금액·통화·상태만 보관한다.
거래 기록은 워크스페이스 삭제와 분리해 보존한다.

검증 명령: `node --test --test-concurrency=1 tests/billing-paypal.test.mjs`
화면 검증: `OKRI_E2E_BASE_URL`을 로컬 서버에 지정하고
`playwright test tests/e2e/billing-checkout.spec.ts --workers=1`.
모든 쓰기는 모킹한다. 운영에서 테스트 고객/구독을 만들거나 실제 카드를 과금하지 않는다.

공식 근거:
- https://developer.paypal.com/subscriptions/integrate
- https://developer.paypal.com/api/subscriptions/v1
- https://developer.paypal.com/api/rest/webhooks/rest/
- https://www.paypal.com/kr/digital-wallet/system-enhancement-faq
- https://developer.android.com/google/play/billing

## 국내 Payple 검증

현재 코드는 결제와 한도 기능을 포함하지만 `BILLING_ENFORCEMENT_ENABLED` 기본값은 꺼짐이다. 아래 검증이 끝나기 전에 이 값을 켜지 않는다.

## 1. Payple 승인

1. 기존 Payple 계약에 `okri.ai`과 OKRI 월 구독 상품을 추가하거나 별도 상점키를 발급받는다.
2. 국내 카드 정기결제 `AUTH`, 결제, 전액 취소, 빌링키 해지를 모두 승인받는다.
3. 등록 도메인과 브라우저 `Referer`가 `https://okri.ai`으로 일치하는지 확인한다.
4. Orderflow의 상점키나 빌링키 암호화 키를 복사하지 않는다.

Sites 운영 보안값:

- `PAYPLE_CST_ID`
- `PAYPLE_CHECKOUT_VERIFIED=true`: 아래 승인·실제 API 계약 검증이 완료된 경우에만 설정
- `PAYPLE_CUST_KEY`
- `PAYPLE_AUTH_URL`: Payple이 제공한 운영 카드 등록 SDK URL
- `PAYPLE_API_URL`: Payple이 제공한 운영 정기결제 API 기준 URL
- `PAYPLE_REFUND_KEY`
- `PAYPLE_BILLING_KEY_ENCRYPTION_KEY`: 다른 서비스·OAuth와 분리된 무작위 키
- `RESEND_API_KEY`
- `OKRI_BILLING_FROM`
- `EMAIL_UNSUBSCRIBE_SECRET`
- `INTERNAL_BILLING_SECRET`
- `OKRI_PUBLIC_URL=https://okri.ai`
- `BILLING_ENFORCEMENT_ENABLED=false`
- `BILLING_ENFORCEMENT_STARTED_AT`: 한도 활성화 시각의 ISO 8601 값. 이 시각 이전에 만든 워크스페이스에는 여기서부터 30일간 편집자 정리 유예가 자동 적용된다.

## 2. 통제된 검증

1. 테스트 Owner로 Team 카드 등록을 하고 즉시 결제가 없는지 확인한다.
2. 동일 결제 Owner와 동일 Payple 결제자가 다른 무료 워크스페이스에서 체험을 다시 받지 못하는지 확인한다.
3. 통제된 Team 실결제 1건을 실행하고 거래번호·마스킹 카드·금액·상태·영수증 URL만 저장되는지 확인한다.
4. 결제 후 Project와 AI를 사용하지 않은 상태에서 전액 환불하고 Free로 즉시 복귀하는지 확인한다.
5. 실패 카드로 1·3·5·7일 재시도와 7일 유예를 가상 시간 테스트한다.
6. Team→Business 일할 상향과 Business→Team 다음 갱신 하향을 확인한다.
7. 해지 시 자동 갱신은 즉시 멈추고 데이터는 유지되는지 확인한다.
8. 결제기간 중 편집 멤버를 늘리고 줄인 뒤 다음 갱신 금액에 당시 활성 편집 멤버 수가 반영되는지 확인한다.

## 3. 예약 실행과 수동 복구

Worker 예약 실행과 별도로 GitHub의 시간당 복구 실행을 유지한다. 다음 Actions secret을 등록해야 한다.

- `OKRI_BILLING_RUN_URL=https://okri.ai/api/internal/billing/run`
- `OKRI_INTERNAL_BILLING_SECRET`: Sites의 `INTERNAL_BILLING_SECRET`과 동일한 값

`.github/workflows/billing-hourly.yml`은 매시 17분 실행과 수동 복구를 지원한다.
중복 실행은 서버 잠금으로 보호한다. 2026-09-06 보안 승인에서 전용 서명키 등록이
중단되었으므로, 운영 키 등록과 서명된 호출의 성공을 확인하기 전에는 이 경로를
활성화 완료로 보고하지 않는다.

## 4. 한도 활성화

Payple 운영 승인, 거래성 이메일, 시간당 실행, 취소·환불, 약관·개인정보처리방침을 모두 확인한 뒤에만 `BILLING_ENFORCEMENT_STARTED_AT`을 현재 시각으로 먼저 설정하고 `BILLING_ENFORCEMENT_ENABLED=true`로 변경한다. 이 값은 Free의 월 Project 30개, 이미지 1GB, AI 체험량과 편집 멤버 5명 제한을 함께 활성화한다. 시작 시각 이전에 생성된 팀은 결제 화면에 유예 종료일을 표시하며 30일 뒤에만 Free의 5명 초과 편집자를 읽기 전용으로 제한한다. 기존 Project·Task·Routine 본문과 이미지는 삭제하지 않는다.
