import { fail } from './contracts.js';

export function validateProgressAllocation(store, request, task, excludeId = null) {
  if (!request.progressPlan) return;
  const goal = request.progressPlan.goals.find(goal => goal.id === task.goalId);
  if (!goal || !Number.isInteger(task.plannedUnits) || task.plannedUnits < 1) fail('작업에는 업무 목표의 goalId와 배정 수량 plannedUnits가 필요합니다.', 400);
  if (!task.acceptance?.trim()) fail('작업 단위별 완료 기준(acceptance)을 입력하세요.', 400);
  const allocated = store.list('tasks').filter(item => item.requestId === request.id && item.id !== excludeId
    && item.goalId === goal.id && item.status !== 'cancelled').reduce((sum, item) => sum + (item.plannedUnits || 0), 0);
  if (allocated + task.plannedUnits > goal.target) fail(`목표 '${goal.title}'의 배정 수량이 ${goal.target}${goal.unit}를 초과합니다. 목표 변경은 재승인이 필요합니다.`, 400);
}

export function validateProgressPlanChange(store, request, plan) {
  if (request.status === 'accepted') fail('완료한 업무의 목표는 변경할 수 없습니다. 새 업무로 등록하세요.');
  const tasks = store.list('tasks').filter(task => task.requestId === request.id && task.status !== 'cancelled');
  for (const task of tasks) {
    const goal = plan.goals.find(goal => goal.id === task.goalId);
    if (!goal) fail('배정된 작업이 있는 목표는 삭제할 수 없습니다. 작업의 목표 연결을 먼저 정리하세요.', 400);
    const previous = request.progressPlan?.goals.find(item => item.id === goal.id);
    if (previous && (previous.unit !== goal.unit || previous.acceptance !== goal.acceptance)) fail('이미 배정한 목표의 단위·완료 기준은 바꿀 수 없습니다. 새 목표와 작업으로 재협의하세요.', 400);
    const allocated = tasks.filter(item => item.goalId === goal.id).reduce((sum, item) => sum + (item.plannedUnits || 0), 0);
    if (goal.target < allocated) fail('목표 수량은 이미 배정한 수량보다 작을 수 없습니다.', 400);
  }
}

export const WORK_PROGRESS_GUIDE_TITLE = '업무 목표·진행률·UI 작성 규칙';
export const WORK_PROGRESS_GUIDE = `# 업무 목표와 진행률 작성 규칙

팀장·CEO는 새 업무를 등록하거나 목표를 변경하고 팀원에게 작업을 배정할 때 이 규칙을 적용합니다. 팀원은 진행 수량을 보고할 때 적용합니다.

## 화면에 보이는 형식
- 제목: 결과를 설명하는 짧은 이름. 60자 안팎으로 작성합니다.
- progressPlan.summary: 사용자가 바로 이해할 한 문장, 최대 160자. 지시 전문이나 로그를 넣지 않습니다.
- progressPlan.goal: 어떤 상태가 되면 업무 목표를 달성한 것인지, 최대 240자.
- progressPlan.goals: 서로 겹치지 않는 측정 목표 1~12개(권장 3~5개). 각 목표에 id, title(60자), target(양의 정수), unit(20자), weight(비중), acceptance(검증 기준, 500자)를 적습니다. weight의 합은 100입니다.
- UI는 한 문장 요약, 검토된 달성률, 팀원 수행 보고율, 진행·검토·차단 건수, 다음 할 일을 기본으로 표시합니다. 목표별 수량, 완료 기준, 문서·승인·실행 기록은 펼쳐서 봅니다.

## 계획과 배정
1. 사용자와 범위를 합의한 뒤 tars_register_work에 title, instruction, acceptance, progressPlan을 전달합니다. 일반 질문이나 현황 조회에는 업무를 만들지 않습니다.
2. 업무 단위는 확인 가능한 산출물로 나눕니다. 예: API 3개, 검증 시나리오 8개. '열심히 진행', 시간 경과, 임의의 퍼센트는 단위가 아닙니다. 서로 다른 단위의 중요도는 weight로 정합니다.
3. 각 TASK는 requestId, goalId, plannedUnits, 담당자, acceptance를 갖습니다. description에 실제 맡은 단위의 이름·범위를 열거해 중복 작업을 피합니다. 한 TASK가 여러 목표를 섞지 않도록 분리합니다. 같은 목표의 배정 수량 합은 target을 넘을 수 없습니다.
4. 목표·수량·비중 변경은 PATCH /api/requests/<id>의 progressPlan으로 저장하고 새 협의안을 제출합니다. 이미 배정한 목표의 단위와 완료 기준을 바꾸려면 별도 목표·작업으로 재협의합니다. 승인된 목표 범위 안의 추가 배정은 기존 승인 정책을 따릅니다.

등록 예시(progressPlan):
\`\`\`json
{"summary":"로그인 오류를 수정하고 회귀 검증을 마칩니다.","goal":"대상 API 3개와 회귀 시나리오 8개를 검토 완료합니다.","goals":[{"id":"api","title":"로그인 API 수정","target":3,"unit":"개","weight":60,"acceptance":"각 API의 오류 수정과 정상·실패 응답 검증"},{"id":"tests","title":"회귀 시나리오 검증","target":8,"unit":"건","weight":40,"acceptance":"각 시나리오의 통과 결과와 재현 가능한 검증 기록"}]}
\`\`\`
TASK 예시(기존 필수 필드와 함께): goalId="api", plannedUnits=1, description="로그인 토큰 갱신 API 담당", acceptance="정상 갱신·만료 토큰·잘못된 서명 응답을 검증".

## 진행 보고와 완료
- 팀원은 tars_log_progress에 message(무엇을 끝냈는지), next(다음 할 일), completedUnits(그 TASK에서 수행한 누적 정수 수량)를 전달합니다. 증거를 message에 적고 필요하면 낮은 수량으로 정정합니다. 배정량을 넘을 수 없습니다.
- 차단 시 tars_block에 같은 형식으로 차단 사유와 남은 일을 기록합니다. 질문은 tars_ask를 사용합니다. 미검증 단위를 완료 수량으로 부풀리지 않습니다.
- 수행 보고는 팀원 주장입니다. 달성률에는 독립 검토를 통과해 acceptedReportId가 있는 done TASK의 배정 수량만 반영됩니다. 일부만 검토 완료할 필요가 있으면 계획 시 TASK를 작게 나눕니다.
- 달성률 = 각 목표의 (검토 완료 수량 / 목표 수량 × 비중)의 합. 취소·미배정 수량은 목표에 남으며, 재시도·보완은 중복 합산하지 않습니다. 보완 재실행은 수행 보고량을 다시 0부터 기록합니다.
- 달성 100%와 사용자 최종 승인은 구분합니다. 목표 수량에 못 미치면 최종 완료로 보고하지 말고 미배정·미검증·차단 사항을 설명합니다.
- 일반 대화는 자연스럽게 답합니다. 화면에 넣을 짧은 요약과 수량만 API 필드로 저장하고 생성된 .tars-data 파일을 직접 수정하지 않습니다.
`;
