import { useWorkspace } from './App';
import { MemberChat } from './MemberChat';

export function CeoChat() {
  const { data } = useWorkspace();
  const member = data.members.find(item => item.role === 'ceo');
  return member ? <MemberChat key={member.id} member={member} /> : null;
}
