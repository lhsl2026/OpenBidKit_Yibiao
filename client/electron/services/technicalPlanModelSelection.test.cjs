const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSqliteDatabase, schemaVersion } = require('./sqliteDatabase.cjs');
const { createTechnicalPlanStore } = require('./technicalPlanStore.cjs');

test('persists the selected text model in the technical plan workspace', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-model-selection-'));
  const app = { getPath: () => root, once: () => {} };
  const sqlite = createSqliteDatabase(app);
  t.after(() => {
    sqlite.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const store = createTechnicalPlanStore({
    app,
    db: sqlite.db,
    fileService: {},
    agentService: {
      deletePersistentTask: () => {},
      getPrimarySession: () => null,
    },
    taskLogStore: { list: () => [], sync: () => {}, clear: () => {} },
  });

  assert.equal(schemaVersion, 24);
  store.saveTextModelSelection({ provider: 'custom', modelName: 'gpt-6-astra', label: 'Codex · gpt-6-astra' });
  assert.deepEqual(store.loadTechnicalPlan().textModelSelection, {
    provider: 'custom',
    modelName: 'gpt-6-astra',
    label: 'Codex · gpt-6-astra',
  });
});
