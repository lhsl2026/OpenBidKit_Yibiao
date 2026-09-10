'use strict';
const path = require('node:path');
const { createRequire } = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const [sourceRoot, databasePath, since = '2026-09-10T06:19:00Z'] = process.argv.slice(2);
const localRequire = createRequire(path.join(path.resolve(sourceRoot), 'package.json'));
const parser = localRequire('./dist/server/modules/preread/preread-parser.service.js');
const db = new DatabaseSync(databasePath, { readOnly: true });
const rows = db.prepare("select key, value from settings where key like 'codex-bridge-request:%'").all();
const summaries = [];
for (const row of rows) {
  const cache = JSON.parse(row.value);
  if (cache.state !== 'completed' || cache.createdAt < Date.parse(since)) continue;
  let raw;
  try { raw = JSON.parse(cache.content); } catch { summaries.push({ suffix: row.key.slice(-10), json: false }); continue; }
  const score = raw && Object.hasOwn(raw, '评分办法');
  const result = { suffix: row.key.slice(-10), kind: score ? 'score' : 'fact', arrays: {}, problems: [] };
  try { (score ? parser.normalizeScoreFacts : parser.normalizeExtractedFacts)(raw); result.accepted = true; }
  catch (error) { result.accepted = false; result.error = error.message; }
  for (const [kind, records] of Object.entries(raw)) {
    if (!Array.isArray(records)) { result.arrays[kind] = typeof records; continue; }
    result.arrays[kind] = records.length;
    records.forEach((item, index) => {
      let retained;
      try { const normalized = (score ? parser.normalizeScoreFacts : parser.normalizeExtractedFacts)({ [kind]: [item] }); retained = Object.values(normalized).some(arr => arr.length > 0); } catch { retained = false; }
      if (retained) return;
      const fields = {};
      for (const [key, value] of Object.entries(item ?? {})) {
        fields[key] = { type: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value, ...(typeof value === 'string' ? { length: value.length, blank: !value.trim() } : {}) };
        if (['page', 'row', 'confidence'].includes(key) && ['number', 'string', 'undefined'].includes(typeof value)) fields[key].value = value;
      }
      result.problems.push({ kind, index, fields });
    });
  }
  summaries.push(result);
}
db.close();
console.log(JSON.stringify({ since, count: summaries.length, accepted: summaries.filter(item => item.accepted).length, summaries: summaries.map(item => ({ ...item, problems: item.problems?.map(problem => ({ kind: problem.kind, index: problem.index, confidence: problem.fields.confidence ?? 'missing', page: problem.fields.page, missingRequired: ['statement', 'quote'].filter(key => !problem.fields[key] || problem.fields[key].blank), extraFields: Object.keys(problem.fields).filter(key => !['statement','section','page','quote','confidence'].includes(key)) })) })) }, null, 2));
