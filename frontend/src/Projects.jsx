import { FolderGit2, Pencil, Plus } from 'lucide-react';
import { useWorkspace } from './App';
import { Empty } from './ui';
import './projects.css';

export function Projects() {
  const { data, open } = useWorkspace();
  return <div className="page projects-page">
    <div className="page-heading"><h1>프로젝트</h1><button type="button" className="button secondary" onClick={() => open('project')}><Plus size={15} />프로젝트 등록</button></div>
    {data.projects.length ? <ul className="source-project-list" aria-label="프로젝트 목록">
      {data.projects.map(project => <li key={project.id}>
        <button type="button" className="source-project" aria-label={`${project.name} 수정`} onClick={() => open('project', project)}>
          <FolderGit2 size={20} className="source-project-icon" aria-hidden="true" />
          <span className="source-project-info">
            <strong>{project.name}</strong>
            {project.description && <span className="source-project-description">{project.description}</span>}
            <code>{project.path || '소스 경로 미등록'}</code>
          </span>
          <Pencil size={15} className="source-project-edit" aria-hidden="true" />
        </button>
      </li>)}
    </ul> : <div className="panel"><Empty title="등록된 프로젝트가 없습니다" description="프로젝트를 등록해 시작하세요." /></div>}
  </div>;
}
