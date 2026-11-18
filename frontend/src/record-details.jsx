import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { Markdown } from './ui';
export function useRecord(kind, record, enabled = true) {
  const query = useQuery({ queryKey: ['record', kind, record?.id, record?.updatedAt],
    queryFn: ({ signal }) => api(`/records/${kind}/${record.id}`, 'GET', undefined, { signal }),
    enabled: Boolean(record?.id) && enabled, staleTime: 60_000 });
  return { ...query, record: query.data || record };
}
export function RecordBody({ kind, record, field = 'content' }) {
  const detail = useRecord(kind, record);
  if (detail.isError) return <p role="alert">{detail.error.message}</p>;
  return <Markdown>{detail.record?.[field] || (detail.isPending ? '불러오는 중…' : '')}</Markdown>;
}
