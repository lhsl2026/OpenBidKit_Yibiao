const Docxtemplater = require('docxtemplater');
const PizZip = require('pizzip');

const MANUAL_VALUE = '待人工填写';
const MISSING_VALUE = '待核实';
const SIMPLE_FIELD = /^[\p{L}\p{N}_().\- ]+$/u;
const MANUAL_FIELD = /(报价|价格|金额|单价|总价|费用|税率|税额|折扣|付款|支付|签字|签名|签章|盖章|印章|公章)/u;
const ENGLISH_MANUAL_FIELD = /\b(price|amount|unit price|total price|cost|fee|tax|discount|payment|signature|seal|stamp)\b/iu;

function inspectBusinessTemplate(buffer) {
  return { fields: readTemplateFields(buffer) };
}

function renderBusinessTemplate(buffer, values) {
  const fields = readTemplateFields(buffer);
  const missingFields = [];
  const blockedFields = [];
  const renderValues = {};

  for (const field of fields) {
    if (isManualField(field)) {
      renderValues[field] = MANUAL_VALUE;
      blockedFields.push(field);
      continue;
    }

    const value = values && Object.prototype.hasOwnProperty.call(values, field) ? values[field] : undefined;
    if (value === undefined || value === null || String(value).trim() === '') {
      renderValues[field] = MISSING_VALUE;
      missingFields.push(field);
    } else {
      renderValues[field] = String(value);
    }
  }

  let doc;
  try {
    doc = new Docxtemplater(new PizZip(Buffer.from(buffer)), {
      linebreaks: true,
      paragraphLoop: false,
      parser(tag) {
        const field = tag.trim();
        if (!isSimpleField(field)) {
          throw unsupportedFieldError(field);
        }
        return { get: (scope) => scope[field] };
      },
    });
    doc.render(renderValues);
  } catch (error) {
    throw formatTemplateError(error);
  }

  return {
    buffer: doc.getZip().generate({ type: 'nodebuffer' }),
    missingFields,
    blockedFields,
  };
}

function readTemplateFields(buffer) {
  const zip = openDocx(buffer);
  const fields = [];
  const seen = new Set();

  for (const fileName of templatePartNames(zip)) {
    const xml = zip.file(fileName).asText();
    for (const text of paragraphTexts(xml)) {
      const matches = text.matchAll(/\{([^{}]*)\}/gu);
      for (const match of matches) {
        const field = match[1].trim();
        if (!isSimpleField(field)) {
          throw unsupportedFieldError(field);
        }
        if (!seen.has(field)) {
          seen.add(field);
          fields.push(field);
        }
      }

      if (/[{}]/u.test(text.replace(/\{[^{}]*\}/gu, ''))) {
        throw new Error('Word 模板中的占位符不完整，请使用成对的大括号，例如 {公司名称}。');
      }
    }
  }

  if (!fields.length) {
    throw new Error('Word 模板未找到可填写占位符，请使用简单文本标记，例如 {公司名称}。');
  }
  return fields;
}

function openDocx(buffer) {
  if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) {
    throw new Error('Word 模板必须是 DOCX 文件。');
  }
  try {
    const zip = new PizZip(Buffer.from(buffer));
    if (!zip.file('[Content_Types].xml') || !zip.file('word/document.xml')) {
      throw new Error('missing DOCX parts');
    }
    return zip;
  } catch (error) {
    throw new Error('无法读取 Word 模板：文件不是有效的 DOCX，或文件已经损坏。');
  }
}

function templatePartNames(zip) {
  return Object.keys(zip.files)
    .filter((name) => /^word\/(document|header\d+|footer\d+)\.xml$/u.test(name))
    .sort((left, right) => {
      if (left === 'word/document.xml') return -1;
      if (right === 'word/document.xml') return 1;
      return left.localeCompare(right);
    });
}

function paragraphTexts(xml) {
  const texts = [];
  for (const paragraph of xml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/gu)) {
    const text = [...paragraph[1].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/gu)]
      .map((match) => decodeXml(match[1]))
      .join('');
    texts.push(text);
  }
  return texts;
}

function decodeXml(value) {
  return value
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&amp;/gu, '&');
}

function isSimpleField(field) {
  return Boolean(field) && SIMPLE_FIELD.test(field) && !/[#/@|:=!?\[\]]/u.test(field);
}

function isManualField(field) {
  return MANUAL_FIELD.test(field) || ENGLISH_MANUAL_FIELD.test(field);
}

function unsupportedFieldError(field) {
  return new Error(`不支持占位符“${field || '空内容'}”：仅支持简单文本字段，例如 {公司名称}；循环、表达式和代码均不可用。`);
}

function formatTemplateError(error) {
  if (error && /不支持占位符/u.test(error.message)) return error;
  return new Error(`无法渲染 Word 模板，请检查占位符格式：${error && error.message ? error.message : '未知错误'}`);
}

module.exports = {
  inspectBusinessTemplate,
  renderBusinessTemplate,
};
