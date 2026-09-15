const assert = require('node:assert/strict');
const test = require('node:test');
const PizZip = require('pizzip');

const {
  inspectBusinessTemplate,
  renderBusinessTemplate,
} = require('./businessBidTemplate.cjs');

function createDocx(parts) {
  const zip = new PizZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
      <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
      <Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
    </Types>`);
  zip.folder('_rels').file('.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
    </Relationships>`);
  zip.folder('word').file('document.xml', parts.documentXml);
  zip.folder('word').file('styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:style w:type="paragraph" w:styleId="Custom"><w:name w:val="Custom"/></w:style>
    </w:styles>`);
  zip.folder('word').folder('_rels').file('document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
    </Relationships>`);
  zip.folder('word').file('header1.xml', parts.headerXml || emptyHeaderXml());
  for (const [fileName, content] of Object.entries(parts.extraFiles || {})) {
    zip.file(fileName, content);
  }
  return zip.generate({ type: 'nodebuffer' });
}

function emptyHeaderXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p/></w:hdr>`;
}

function paragraph(text) {
  return `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
}

function documentXml(body) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
      xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <w:body>${body}<w:sectPr><w:headerReference w:type="default" r:id="rId1"/></w:sectPr></w:body>
    </w:document>`;
}

function readPart(buffer, partName) {
  return new PizZip(buffer).file(partName).asText();
}

test('检出正文表格页眉和跨 run 的简单字段，同时保留样式定义', () => {
  const buffer = createDocx({
    documentXml: documentXml(
      `<w:p><w:pPr><w:pStyle w:val="Custom"/></w:pPr><w:r><w:t>{公司</w:t></w:r><w:r><w:t>名称}</w:t></w:r></w:p>
      <w:tbl><w:tr><w:tc>${paragraph('{联系人}')}</w:tc></w:tr></w:tbl>`,
    ),
    headerXml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${paragraph('{项目名称}')}</w:hdr>`,
    extraFiles: { 'word/media/logo.png': Buffer.from([0, 1, 2, 3]) },
  });

  assert.deepEqual(inspectBusinessTemplate(buffer), {
    fields: ['公司名称', '联系人', '项目名称'],
  });
  assert.match(readPart(buffer, 'word/styles.xml'), /styleId="Custom"/);
  assert.deepEqual(new PizZip(buffer).file('word/media/logo.png').asNodeBuffer(), Buffer.from([0, 1, 2, 3]));
});

test('渲染重复字段并转义 XML，缺失字段显示待核实', () => {
  const buffer = createDocx({
    documentXml: documentXml(`${paragraph('{公司名称}')}${paragraph('{公司名称}')}${paragraph('{联系人}')}`),
  });

  const result = renderBusinessTemplate(buffer, { 公司名称: '甲&乙<公司>', 联系人: '' });
  const xml = readPart(result.buffer, 'word/document.xml');

  assert.deepEqual(result.missingFields, ['联系人']);
  assert.deepEqual(result.blockedFields, []);
  assert.match(xml, /甲&amp;乙&lt;公司&gt;/);
  assert.equal((xml.match(/甲&amp;乙&lt;公司&gt;/g) || []).length, 2);
  assert.match(xml, /待核实/);
});

test('渲染后保留模板中的媒体文件', () => {
  const buffer = createDocx({
    documentXml: documentXml(paragraph('{公司名称}')),
    extraFiles: { 'word/media/logo.png': Buffer.from([7, 8, 9]) },
  });

  const result = renderBusinessTemplate(buffer, { 公司名称: '甲公司' });

  assert.deepEqual(new PizZip(result.buffer).file('word/media/logo.png').asNodeBuffer(), Buffer.from([7, 8, 9]));
});

test('渲染结果替换页眉字段，并保留样式和媒体文件', () => {
  const buffer = createDocx({
    documentXml: documentXml(`<w:p><w:pPr><w:pStyle w:val="Custom"/></w:pPr><w:r><w:t>{公司名称}</w:t></w:r></w:p>`),
    headerXml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${paragraph('{项目名称}')}</w:hdr>`,
    extraFiles: { 'word/media/logo.png': Buffer.from([5, 6, 7]) },
  });

  const result = renderBusinessTemplate(buffer, { 公司名称: '甲公司', 项目名称: '测试项目' });

  assert.match(readPart(result.buffer, 'word/header1.xml'), /测试项目/);
  assert.match(readPart(result.buffer, 'word/styles.xml'), /styleId="Custom"/);
  assert.deepEqual(new PizZip(result.buffer).file('word/media/logo.png').asNodeBuffer(), Buffer.from([5, 6, 7]));
});

test('报价金额和签字盖章字段始终待人工填写，法定代表人姓名仍可自动填写', () => {
  const buffer = createDocx({
    documentXml: documentXml(`${paragraph('{报价金额}')}${paragraph('{法定代表人签字}')}${paragraph('{盖章}')}${paragraph('{法定代表人姓名}')}`),
  });

  const result = renderBusinessTemplate(buffer, {
    报价金额: '100 万元',
    法定代表人签字: '张三',
    盖章: '已盖章',
    法定代表人姓名: '张三',
  });
  const xml = readPart(result.buffer, 'word/document.xml');

  assert.deepEqual(result.missingFields, []);
  assert.deepEqual(result.blockedFields, ['报价金额', '法定代表人签字', '盖章']);
  assert.equal((xml.match(/待人工填写/g) || []).length, 3);
  assert.match(xml, /张三/);
  assert.doesNotMatch(xml, /100 万元|已盖章/);
});

test('英文报价金额与签章字段始终待人工填写，Representative Name 仍可自动填写', () => {
  const blocked = ['Price', 'Amount', 'Unit Price', 'Total Price', 'Cost', 'Fee', 'Tax', 'Discount', 'Payment', 'Actual Signature', 'Seal', 'Stamp'];
  const buffer = createDocx({
    documentXml: documentXml(`${blocked.map((field) => paragraph(`{${field}}`)).join('')}${paragraph('{Representative Name}')}`),
  });
  const values = Object.fromEntries([...blocked, 'Representative Name'].map((field) => [field, `value-${field}`]));

  const result = renderBusinessTemplate(buffer, values);
  const xml = readPart(result.buffer, 'word/document.xml');

  assert.deepEqual(result.blockedFields, blocked);
  assert.equal((xml.match(/待人工填写/g) || []).length, blocked.length);
  assert.match(xml, /value-Representative Name/);
  for (const field of blocked) assert.doesNotMatch(xml, new RegExp(`value-${field}`));
});

test('拒绝损坏包、无字段模板和不支持的循环或表达式', () => {
  assert.throws(() => inspectBusinessTemplate(Buffer.from('not a docx')), /DOCX|模板|损坏/);

  const noFields = createDocx({ documentXml: documentXml(paragraph('无占位符')) });
  assert.throws(() => inspectBusinessTemplate(noFields), /占位符/);

  const loop = createDocx({ documentXml: documentXml(`${paragraph('{#投标人}')}${paragraph('{/投标人}')}`) });
  assert.throws(() => inspectBusinessTemplate(loop), /不支持|循环/);

  const expression = createDocx({ documentXml: documentXml(paragraph('{公司名称 | upper}')) });
  assert.throws(() => renderBusinessTemplate(expression, {}), /不支持|表达式/);
});
