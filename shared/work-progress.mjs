// Targets are fixed by the manager's approved plan. Cancelling a task does not
// remove its target; reported work is distinct from independently reviewed work.
export function workProgress(request, tasks = []) {
  const plan = request.progressPlan;
  if (!plan?.goals?.length) return { planned: false, goals: [], percent: null, reportedPercent: null, complete: false };
  const work = tasks.filter(task => task.requestId === request.id && task.status !== 'cancelled');
  const goals = plan.goals.map(goal => {
    const assigned = work.filter(task => task.goalId === goal.id);
    const verified = assigned.reduce((sum, task) => sum + (task.status === 'done' && task.acceptedReportId ? task.plannedUnits || 0 : 0), 0);
    const reported = assigned.reduce((sum, task) => sum + (task.status === 'done' && task.acceptedReportId ? task.plannedUnits || 0
      : Math.min(task.plannedUnits || 0, Math.max(0, task.completedUnits || 0))), 0);
    const allocated = assigned.reduce((sum, task) => sum + (task.plannedUnits || 0), 0);
    return { ...goal, tasks: assigned, allocated, verified: Math.min(goal.target, verified), reported: Math.min(goal.target, reported),
      unassigned: Math.max(0, goal.target - allocated), complete: verified >= goal.target };
  });
  // Floor avoids displaying 100% for a partially achieved target after rounding.
  const percent = field => Math.floor(goals.reduce((sum, goal) => sum + goal[field] / goal.target * goal.weight, 0) + 1e-8);
  return { planned: true, goals, percent: Math.min(100, percent('verified')), reportedPercent: Math.min(100, percent('reported')),
    complete: goals.every(goal => goal.complete), achievedGoals: goals.filter(goal => goal.complete).length,
    unassignedGoals: goals.filter(goal => goal.unassigned > 0).length };
}

export function progressSummary(request, tasks) {
  const progress = workProgress(request, tasks);
  return { percent: progress.percent, reportedPercent: progress.reportedPercent, achievedGoals: progress.achievedGoals,
    goals: progress.goals.map(({ id, title, target, unit, verified, reported, unassigned }) => ({ id, title, target, unit, verified, reported, unassigned })) };
}
