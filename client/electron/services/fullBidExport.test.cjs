const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const PizZip = require('pizzip');

const originalLoad = Module._load;
Module._load = function loadWithElectronStub(request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: null,
      dialog: {},
      nativeImage: {},
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { buildDocxBuffer } = require('./exportService.cjs');
Module._load = originalLoad;

test('full bid export renders a professional cover and an updatable Word table of contents', async () => {
  const buffer = await buildDocxBuffer({
    project_name: '测试项目_完整投标文件',
    document_title: '测试项目',
    document_subtitle: '投标文件',
    cover_lines: ['投标人：隆创信息有限公司', '商务标与技术标合并稿'],
    include_toc: true,
    outline: [
      { id: 'business', title: '第一部分 商务标', children: [{ id: 'business-1', title: '投标函', content: '商务正文' }] },
      { id: 'technical', title: '第二部分 技术标', children: [{ id: 'technical-1', title: '实施方案', content: '技术正文' }] },
      { id: 'delivery', title: '待补资料与交付前检查', content: '请核对签字盖章。' },
    ],
  });

  const xml = new PizZip(buffer).file('word/document.xml').asText();
  assert.match(xml, /测试项目/);
  assert.match(xml, /投标文件/);
  assert.match(xml, /投标人：隆创信息有限公司/);
  assert.match(xml, /商务标与技术标合并稿/);
  assert.match(xml, /目录/);
  assert.match(xml, /TOC/);
  assert.match(xml, /\\o &quot;1-6&quot;/);
  assert.match(xml, /\\h/);
  assert.match(xml, /\\u/);
  assert.match(xml, /第一部分 商务标/);
  assert.match(xml, /第二部分 技术标/);
  assert.match(xml, /待补资料与交付前检查/);
  assert.equal((xml.match(/第一部分 商务标/g) || []).length, 2, '目录应包含可见的缓存条目，首次打开不能是空白页');
});
