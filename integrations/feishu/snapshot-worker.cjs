// Only the read-only evidence inputs cross into this worker; credentials never do.
const { parentPort, workerData } = require('node:worker_threads');
const { readFileSync } = require('node:fs');
const { readVaultSnapshot } = require('./vault.cjs');
const json = (file, fallback) => file ? JSON.parse(readFileSync(file, 'utf8')) : fallback;
try {
  const rules = json(workerData.rulesPath, []);
  if (!Array.isArray(rules)) throw Error('rules_invalid');
  const snapshot = readVaultSnapshot({ ...workerData, mappings: json(workerData.mappingsPath, []) });
  parentPort.postMessage({ ok: true, value: { snapshot, rules } });
} catch {
  parentPort.postMessage({ ok: false });
}
