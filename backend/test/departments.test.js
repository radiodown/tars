import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'tars-departments-'));
process.env.TARS_DATA_DIR = directory;
const { Store } = await import('../src/store.js');
const { deleteDepartment } = await import('../src/departments.js');
const { syncShared } = await import('../src/guidance.js');
const { knowledgeTree } = await import('../src/knowledge.js');
after(() => rmSync(directory, { recursive: true, force: true }));

test('deleting an empty department updates SQLite, generated guidance and the document tree', async () => {
  const store = new Store();
  try {
    const department = store.put('departments', { name: '삭제할 부서' });
    await syncShared(store);
    const path = join(directory, 'departments', department.id);
    await writeFile(join(path, 'user-note.txt'), 'preserve');
    assert.equal((await readFile(join(path, 'instructions.md'), 'utf8')).includes(department.name), true);

    assert.deepEqual(deleteDepartment(store, department.id), { ok: true, id: department.id });
    await syncShared(store);

    assert.equal(store.get('departments', department.id), null);
    assert.equal(knowledgeTree(store).root.children.find(node => node.id === 'departments').children.length, 0);
    await assert.rejects(lstat(join(path, 'AGENTS.md')), { code: 'ENOENT' });
    await assert.rejects(lstat(join(path, 'instructions.md')), { code: 'ENOENT' });
    assert.equal(await readFile(join(path, 'user-note.txt'), 'utf8'), 'preserve');
  } finally { store.db.close(); }
});

test('a department with referenced records cannot be deleted', () => {
  const store = new Store();
  try {
    for (const kind of ['members', 'tasks', 'documents', 'sessions']) {
      const department = store.put('departments', { name: `${kind} 부서` });
      store.put(kind, { departmentId: department.id });
      assert.throws(() => deleteDepartment(store, department.id), /연결된/);
      assert.equal(store.get('departments', department.id)?.name, department.name);
    }
  } finally { store.db.close(); }
});
