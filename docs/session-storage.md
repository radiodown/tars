# 세션 저장과 호환성

제품의 세션은 SQLite `conversations` 레코드로 저장한다. 기존 `sessions` 컬렉션과 `/api/sessions/:id/*`는 **실행 기록**을 뜻하는 호환 이름으로 유지한다. 기존 실행 ID, 작업·승인·로그 참조는 변경하지 않는다.

| 필드 또는 컬렉션 | 의미 |
| --- | --- |
| `conversations.id` | 문맥을 공유하는 TARS 세션 ID |
| `conversations.memberId` | 해당 세션의 AI |
| `provider`, `codexAccount`, `projectId`, `workspace` | 재개 범위 |
| `providerSessionId` | Codex thread ID 또는 Claude session ID |
| `conversations.lastRunId` | 최근 실행 ID |
| `sessions.id` | 기존 이름을 유지하는 실행 ID |
| `sessions.conversationId` | 실행이 속한 TARS 세션 |
| `sessions.providerTurnId` | 제공사가 반환하는 턴 ID |
| `chatQueue.conversationId` | 대기 메시지를 처리할 세션 |
| `members.currentSessionId` | 현재 실행 ID를 뜻하는 호환 필드. 사용자가 선택한 대화 세션이 아님 |
| `settings.maxSessionMinutes` | 개별 실행의 시간 제한을 뜻하는 호환 필드 |

## API

- `GET /api/conversations?memberId=...`: 세션 목록
- `GET /api/conversations/:id`: 세션 정보
- `GET /api/conversations/:id/runs`: 해당 세션의 실행 요약 목록
- `POST /api/members/:id/conversations`: 새 세션 생성. 선택 인수는 `projectId`, `title`
- `POST /api/conversations/:id/resume`: 소유 AI·제공사·계정을 검증하고 세션 선택. 모델 호출 없음
- `POST /api/members/:id/chat`: `prompt`와 `conversationId`를 전달해 해당 세션에 메시지 전송. `conversationId`를 생략하면 새 세션 생성
- `POST /api/ceo/chat`: 위와 동일한 CEO 대화 규칙
- 기존 `chat/clear`: 기존 기록을 지우지 않고 새 세션을 만드는 호환 API

새 메시지는 별도의 실행 ID를 갖는다. 대기 메시지도 생성 시 세션 ID를 고정하고 대기열 처리 시 그대로 사용한다. 같은 AI의 다른 세션을 실행 중일 때 추가 지시가 그 실행에 잘못 들어가지 않도록 화면에서도 선택한 세션의 실행만 제어한다.

## 문맥 생성

`memberConversationContext`는 같은 `memberId`와 `conversationId`의 기록만 사용한다. 실행용 Markdown은 `.tars-data/conversations/<conversationId>.md`에 SQLite 원본으로부터 생성한다. 생성 파일을 직접 편집하지 않는다. 최근 기록 발췌는 최대 8건·24,000자로 제한한다. 제공사 문맥을 재개할 때는 마지막 재개 대상 이후의 기록만 추가한다.

AI별 조직 현황과 공용 지침은 대화 이력과 별개의 자료다. 새로운 세션에 다른 세션의 메시지를 자동 주입하지 않지만, 사용자의 업무 요청에 따라 관리 API로 업무 자료를 조회할 수 있다.

## 기존 기록 이관

백엔드 초기화 시 트랜잭션으로 실행 기록에 세션 연결을 추가한다. 알려진 제공사 ID와 AI·계정·프로젝트·경로가 같으면 같은 세션으로 묶는다. 제공사 ID가 없는 기록은 기존 대화 ID와 범위를 사용하고, 그 정보도 없으면 독립 세션으로 보존한다. 원래 업무의 `sourceSessionId`를 기준으로 업무의 세션 참조를 갱신하며 실행 ID는 보존한다. 이관은 반복 실행해도 이미 연결한 기록을 다시 만들지 않는다.

자동 수행·검토·보고도 별도 세션을 가진다. 같은 작업·업무의 같은 담당자와 실행 종류는 기존 세션을 재사용할 수 있다. 기존 승인 후속 처리의 명시적 새 문맥 재시도는 새 세션을 만들고 원래 실행 참조를 보존한다.
