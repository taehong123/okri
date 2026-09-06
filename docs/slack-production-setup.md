# OKRI Slack 데일리 봇 운영 체크리스트

이 문서는 OKRI 서비스 운영자가 최초 한 번만 진행하는 설정이다. 일반 고객은 이 절차를 수행하지 않으며, OKRI의 **앱 연동 → Slack에 연결**에서 Slack 승인만 하면 된다.

## 1. 공용 Slack 앱 자동 준비

1. Slack의 **App Configuration Tokens**에서 `apps:write` 설정 토큰을 한 번 발급한다. 토큰은 12시간 뒤 만료되며 DB·로그·저장소에 남기지 않는다.
2. 운영 자동화에 토큰을 일회성으로 전달한다. 자동화는 `apps.manifest.validate`로 `slack-app-manifest.yml`을 검증하고 `apps.manifest.create`로 공용 OKRI 앱을 만든다.
3. 자동화가 다음 URL과 권한을 검증한다.
   - OAuth Redirect: `/api/slack/callback`
   - Slash Command: `/api/slack/commands`
   - Interactivity: `/api/slack/interactions`
   - Options Load URL: `/api/slack/interactions` (`settings.interactivity.message_menu_options_url`)
   - Events API: `/api/slack/events`
4. Bot Token Scopes에 `commands`, `chat:write`, `im:write`, `im:history`, `users:read`, `users:read.email`, `channels:read`, `channels:join`, `groups:read`가 있는지 확인한다.
5. Event Subscription에 `message.im`이 있는지 확인한다.

## 2. 운영 보안 값 등록

`apps.manifest.create` 응답의 자격 증명과 새 암호화 키는 자동화가 곧바로 Sites 운영 환경의 보안 값으로 등록하고 재배포한다. 응답 본문과 값은 저장소, DB, 문서, 스크린샷에 남기지 않는다.

- `SLACK_CLIENT_ID`
- `SLACK_CLIENT_SECRET`
- `SLACK_SIGNING_SECRET`
- `SLACK_TOKEN_ENCRYPTION_KEY`: 기존 운영 값을 유지한다. 운영 중 변경하면 저장된 Bot Token을 복호화할 수 없다.
- `SLACK_OAUTH_REDIRECT_URI=https://okri.ai/api/slack/callback`

환경 값을 바꾼 뒤에는 저장된 Sites 버전을 다시 배포해야 새 설정이 적용된다. 운영 `/api/slack/status`가 `workspace_disconnected`를 반환하면 서비스 측 준비가 끝난 것이다.

## 3. 최초 워크스페이스 설치

1. OKRI에서 Owner 또는 Admin으로 로그인한다.
2. **앱 연동 → Slack 연결**을 누르고 설치할 Slack 워크스페이스를 승인한다.
3. 돌아온 초기 설정 화면에서 요일·시간·시간대·대상 멤버·공유 채널을 정한다.
4. **설정 완료**를 누르면 공개 채널 자동 참여, DM 예약, 설치자 테스트 DM, 채널 테스트가 한 번에 실행된다.
5. 실패한 테스트만 고급 설정에서 다시 시도한다. 미연결 사용자는 Slack에서 `/okri daily`의 일회용 링크로 연결한다.

## 4. 데일리 작동 확인

1. 공개 채널은 초기 설정에서 선택해 봇이 자동 참여하는지 확인한다. 비공개 채널은 먼저 봇을 초대해야 선택지에 나타난다.
2. 설정 완료 결과에서 사용자 예약과 설치자 테스트 DM, 선택 채널 테스트를 확인한다.
5. Slack에서 `/okri daily`를 실행해 모달이 열리는지 확인한다.
6. Task를 선택해 제출하고 지정 채널에 개인 카드가 게시되는지 확인한다.
7. 같은 날짜에 다시 제출해 새 메시지가 아니라 기존 카드가 갱신되는지 확인한다.
8. 스킵의 `본업 과중 / 휴가 / 개인 일정 / 기타`를 각각 확인하고, `기타`에서 상세 사유가 필수인지 확인한다.

## 5. 모든 고객 워크스페이스의 직접 설치 허용

테스트 워크스페이스 A에서 기본 흐름을 확인한 뒤 Slack 앱의 **Manage Distribution**에서 배포 체크리스트를 완료하고 비공개 목록 방식의 Public Distribution을 활성화한다. 이어서 별도의 테스트 워크스페이스 B에서도 OKRI의 연결 버튼만으로 설치되는지 확인한다.

고객은 OKRI의 **Slack 연결** 버튼으로 OAuth 설치를 시작한다. Slack 승인 화면에서 자기 워크스페이스를 선택하며 훅 URL, Client ID, Signing Secret 같은 개발자 설정은 입력하지 않는다.

관리봇의 `정보 입력·수정`은 추가 OAuth 권한 없이 기존 연결을 사용한다.
100개 이하의 담당자·속성 선택지는 Slack 안에서 바로 검색하며, 더 큰 목록은
위 Options Load URL을 사용한다. 운영자는 기존 공용 앱에도 이 URL이 지정됐는지
확인해야 한다. 매니페스트 파일 수정만으로 설치된 Slack 앱 설정이 바뀌지는 않는다.
([Slack 매니페스트 규격](https://docs.slack.dev/reference/app-manifest/))
검증은 모의 API로 수행하며 운영 레코드나 실제 발송으로 테스트하지 않는다.

한 OKRI 워크스페이스에는 Slack 워크스페이스 하나만 연결한다. 같은 Slack 워크스페이스를 다른 OKRI 워크스페이스로 옮기려면 기존 연결을 먼저 해제한다.

권한을 추가하면 기존 워크스페이스에는 자동으로 권한이 생기지 않는다. OKRI에서 **권한 업데이트**를 눌러 한 번 다시 승인해야 한다.

## 6. 장애 확인

- **서비스 설정 확인 필요**: 운영 환경의 Client ID, Client Secret, Signing Secret을 확인하고 재배포한다.
- **권한 업데이트 필요**: 매니페스트의 Bot Token Scopes를 반영한 뒤 OKRI에서 다시 승인한다.
- **Slack 미연결 사용자**: 이메일 대소문자와 활성 멤버 여부를 확인하거나 `/okri daily` 일회용 링크를 사용한다.
- **Slack 관리자 승인 필요**: 고객 Slack의 앱 설치 정책에 따른 상태이므로 해당 Slack의 Owner/Admin 승인 후 다시 연결한다.
- **이미 다른 OKRI에 연결됨**: 기존 OKRI 워크스페이스에서 Slack 연결을 해제한 뒤 다시 시도한다.
- **비공개 공유 채널이 보이지 않음**: Slack에서 OKRI 봇을 해당 비공개 채널에 초대한 뒤 재동기화한다. 공개 채널은 자동 참여한다.
- **DM 또는 채널 전송 실패**: 앱 연동의 오류 항목에서 재시도하고 Sites Worker 오류 로그에서 Slack API 오류 코드를 확인한다.
