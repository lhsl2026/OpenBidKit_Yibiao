const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const appPath = path.resolve(__dirname, '..', 'src', 'App.tsx');

function getTopLevelAppChildren() {
  const source = ts.createSourceFile(
    appPath,
    fs.readFileSync(appPath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const app = source.statements.find(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === 'App',
  );
  assert.ok(app?.body, 'App function should exist');

  const returnStatement = app.body.statements.find(ts.isReturnStatement);
  assert.ok(returnStatement?.expression, 'App should return its startup surface');
  const returned = ts.isParenthesizedExpression(returnStatement.expression)
    ? returnStatement.expression.expression
    : returnStatement.expression;
  assert.ok(ts.isJsxFragment(returned), 'App startup surface should be a JSX fragment');

  return returned.children
    .filter((child) => ts.isJsxSelfClosingElement(child) || ts.isJsxElement(child))
    .map((child) => (
      ts.isJsxSelfClosingElement(child)
        ? child.tagName.getText(source)
        : child.openingElement.tagName.getText(source)
    ));
}

test('startup surface mounts only operational prompts and the app shell', () => {
  assert.deepEqual(getTopLevelAppChildren(), [
    'GpuHardwareAccelerationPrompt',
    'RequiredOnlineServicesPrompt',
    'AppShell',
  ]);
});
