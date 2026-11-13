import { Boxes, Command, FileText, Gauge, Inbox, LayoutDashboard, ListTodo, MessageSquare, Route, Users } from 'lucide-react';

export const navigation = [
  ['/inbox', '확인할 일', Inbox],
  ['/ceo', 'TARS 상황실', Command],
  ['/requests', '업무 흐름', Route],
  ['/', '워크스페이스', LayoutDashboard],
  ['/consult', '팀장과 협의', MessageSquare],
  ['/tasks', 'AI 작업 기록', ListTodo],
  ['/organization', 'AI 조직', Users],
  ['/projects', '소스 프로젝트', Boxes],
  ['/library', '문서 & 스킬', FileText],
  ['/usage', '사용량', Gauge],
];

export const defaultMenuOrder = navigation.map(([path]) => path);
const entries = new Map(navigation.map(item => [item[0], item]));

export function normalizeMenuOrder(value) {
  const saved = Array.isArray(value) ? value.filter(path => entries.has(path)) : [];
  // Keep every current menu visible, including menus added after this order was saved.
  const ordered = [...new Set([...saved, ...defaultMenuOrder])];
  if (saved.length && !saved.includes('/requests')) {
    ordered.splice(ordered.indexOf('/requests'), 1);
    ordered.splice(ordered.indexOf('/ceo') + 1, 0, '/requests');
  }
  return ordered;
}

export function orderedNavigation(value) {
  return normalizeMenuOrder(value).map(path => entries.get(path));
}
