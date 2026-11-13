import { Boxes, Command, FileText, Gauge, LayoutDashboard, ListTodo, MessageSquare, Radio, Users } from 'lucide-react';

export const navigation = [
  ['/', '워크스페이스', LayoutDashboard],
  ['/ceo', 'TARS 상황실', Command],
  ['/projects', '프로젝트 관리', Boxes],
  ['/organization', 'AI 조직', Users],
  ['/consult', '팀장과 협의', MessageSquare],
  ['/tasks', '작업 보드', ListTodo],
  ['/sessions', '실행 세션', Radio],
  ['/library', '문서 & 스킬', FileText],
  ['/usage', '사용량', Gauge],
];

export const defaultMenuOrder = navigation.map(([path]) => path);
const entries = new Map(navigation.map(item => [item[0], item]));

export function normalizeMenuOrder(value) {
  const saved = Array.isArray(value) ? value.filter(path => entries.has(path)) : [];
  // Keep every current menu visible, including menus added after this order was saved.
  return [...new Set([...saved, ...defaultMenuOrder])];
}

export function orderedNavigation(value) {
  return normalizeMenuOrder(value).map(path => entries.get(path));
}
