# AI 연결 사용 안내

앱의 **AI 연결**에서 ChatGPT / Claude / Claude Code를 선택합니다. 모바일에서는 **더보기 → AI 연결**입니다. 별도 Claude API 키나 고객별 앱을 만들 필요가 없습니다.

Ticket의 **클라이언트 관리 → 외부 연동**은 고객 시스템 push와 OAuth 미지원 MCP 도구를 위한 별도 화면입니다. 고객 API 키는 `okri:clients:write`만 가지며 고객 upsert 외의 조회, 일반 수정, MCP 호출에는 사용할 수 없습니다. 개인 MCP 키는 현재 사용자와 워크스페이스에 묶이고 `okri:read` 또는 `okri:read okri:write`를 사용합니다. 두 키 모두 원문은 생성 직후 한 번만 표시되며 목록에는 prefix, 생성 시각, 최근 사용 시각만 남습니다.

## ChatGPT

1. **ChatGPT 연결 문구 복사**를 누릅니다.
2. 강조 상자의 안내처럼 복사한 내용을 **ChatGPT 대화창에 붙여넣고 전송**합니다. 브라우저를 제어할 수 있는 대화에서 진행하세요.
3. 로그인 등 본인 확인이 필요하면 직접 처리합니다. 문구 복사 자체는 연결 완료가 아닙니다.

기존 연결 문구와 `OKRI 연결이 완료되었습니다.` 안내는 유지합니다. 복사 실패가 표시되면 클립보드 권한을 확인하고 재시도하세요.

## Claude 웹·앱

1. **Claude에 연결**을 누릅니다. Claude의 공식 설정에 `OKRI`과 `https://okri.ai/api/mcp`가 미리 입력됩니다.
2. 내용을 확인하고 OKRI 계정으로 로그인합니다.
3. 승인 화면의 **계정·워크스페이스·역할·권한**을 확인한 후 연결을 승인합니다. 취소하면 연결 키는 발급되지 않습니다.
4. Claude 대화에서 OKRI을 활성화하고 조회 도구로 확인합니다.

Claude Free는 커스텀 커넥터 1개 제한이 있습니다. 조직 정책에 따라 Claude Team/Enterprise 조직 소유자의 추가 설정이 필요할 수 있습니다. **OKRI 관리자와 Claude 조직 관리자는 별개**입니다. 수동 주소 복사와 조직 관리자용 링크는 보조 안내를 펼치면 나옵니다. 외부 계정 상태를 추측해 연결 버튼을 막지 않습니다.

## Claude Code

기본 흐름은 **Claude에 연결 → 같은 Claude 구독 계정으로 Code 로그인 → `/mcp`에서 확인**입니다. 이 재사용은 Claude 구독 로그인 방식의 지원 환경에 한정되며 API 키, Bedrock 등 다른 로그인 방식에는 적용되지 않습니다. Claude 웹 연결이 있어도 Code에서 실제 확인하기 전까지 Code 연결 완료로 간주하지 않습니다.

직접 등록을 원하면 안내를 펼쳐 다음 명령을 복사해 직접 실행합니다.

```sh
claude mcp add --transport http --scope user okri https://okri.ai/api/mcp
```

이후 Code의 `/mcp`에서 OKRI 인증을 선택합니다. 같은 이름이 이미 있으면 기존 설정을 확인하세요. 앱은 명령을 자동 실행하거나 기존 연결을 삭제하지 않습니다. 승인 화면의 `localhost` 또는 `127.0.0.1` 콜백이 자신의 컴퓨터에서 시작한 연결인지 확인하세요.

## 상태와 해제

- **연결 없음:** 해당 제공자의 유효한 연결 키가 없습니다.
- **연결 대기 · 첫 사용 전:** 인증 키는 발급됐지만 인증된 API/MCP 사용 기록이 아직 없습니다.
- **연결됨:** 해당 제공자의 인증된 요청을 확인했습니다. 복사·설치 버튼 클릭만으로 이 상태가 되지 않습니다.
- **상태 확인 실패:** 현재 상태를 읽을 수 없습니다. 기존 연결을 자동 삭제하지 않습니다.

해제는 현재 계정·워크스페이스의 선택한 제공자에만 적용됩니다. 제공자별 활성 연결은 최대 10개이며 초과하면 가장 오래된 연결부터 해제됩니다. 기존 `ChatGPT OAuth` 기록은 ChatGPT로 표시하고 그 밖의 과거 기록은 보존합니다.

## 운영·검증

새 D1 마이그레이션 `0035_ai_connections.sql`을 코드와 함께 배포해야 합니다. `provider`/`scopes` 열과 10분짜리 일회용 승인 저장소를 추가하며 기존 키와 데이터는 삭제하지 않습니다. 신규 스키마를 런타임 초기화에서 중복 생성하지 않습니다.

Claude/Code는 DCR·S256 PKCE를 사용합니다. 콜백은 공식 Claude 주소 또는 정확한 로컬 `/callback`만 허용합니다. 로컬 포트만 변할 수 있으며 실제 요청 포트는 승인 코드에 고정됩니다. 코드·리소스·클라이언트·CSRF·현재 사용자·워크스페이스를 검증합니다. Viewer와 읽기 전용 범위의 연결에는 변경 작업을 허용하지 않습니다. OAuth 토큰 소유자도 현재 역할 이상의 관리자 권한을 얻지 않습니다.

배포 후에는 사용자 로그인 및 필요한 승인을 거쳐 Claude 웹, Code 직접 등록, 계정 연결 재사용을 각각 검증해야 합니다. `tools/list`와 조회 도구만 사용하고 고객 Task를 임의로 생성하지 않습니다. 자동 계약/화면 테스트 통과는 외부 제품에서의 실인증 성공을 대신하지 않습니다.

공식 규격: [Claude 설치 링크](https://claude.com/docs/connectors/building/directory-vs-custom), [Claude 인증](https://claude.com/docs/connectors/building/authentication), [지원 플랜](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp), [Code 계정 연결 재사용](https://code.claude.com/docs/en/mcp#use-mcp-servers-from-claudeai).
