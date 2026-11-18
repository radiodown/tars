import { Boxes, Command, FileText, Inbox, ListTodo, MessageSquare, Users } from 'lucide-react';

export const navigation = [
  ['/inbox', '확인할 일', Inbox], ['/ceo', '대화', MessageSquare], ['/requests', '업무', ListTodo],
  ['/projects', '프로젝트', Boxes], ['/sessions', '세션', Command], ['/organization', '조직', Users], ['/library', '자료', FileText],
];

export const defaultMenuOrder = navigation.map(([path]) => path);
const entries = new Map(navigation.map(item => [item[0], item]));

export function normalizeMenuOrder(value) {
  const saved = Array.isArray(value) ? value.filter(path => entries.has(path)) : [];
  // Keep every current menu visible, including menus added after this order was saved.
  const ordered = [...new Set([...saved, ...defaultMenuOrder])];
  return ordered;
}

export function orderedNavigation(value) {
  return normalizeMenuOrder(value).map(path => entries.get(path));
}
