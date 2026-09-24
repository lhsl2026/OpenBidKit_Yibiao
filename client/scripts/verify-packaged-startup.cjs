const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const executable = path.resolve(__dirname, '..', 'release-complete', 'win-unpacked', '联智标.exe');

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : null;
  await new Promise((resolve) => server.close(resolve));
  assert.ok(port, 'A debugging port should be available');
  return port;
}

async function waitForPage(port) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // Electron may still be starting.
    }
    await delay(250);
  }
  throw new Error('Timed out waiting for the packaged renderer');
}

async function evaluate(webSocketDebuggerUrl, expression) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('Timed out reading the packaged renderer'));
    }, 15_000);

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true },
      }));
    });
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      if (message.error || message.result?.exceptionDetails) {
        reject(new Error(JSON.stringify(message.error || message.result.exceptionDetails)));
        return;
      }
      resolve(message.result.result.value);
    });
    socket.addEventListener('error', reject);
  });
}

async function main() {
  assert.ok(fs.existsSync(executable), `Packaged executable not found: ${executable}`);
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-startup-check-'));
  const port = await reservePort();
  const app = spawn(executable, [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    '--disable-gpu',
  ], { stdio: 'ignore' });

  try {
    const page = await waitForPage(port);
    await delay(4_000);
    const state = await evaluate(page.webSocketDebuggerUrl, `(() => ({
      title: document.title,
      readyState: document.readyState,
      bodyText: document.body?.innerText || '',
      dialogs: Array.from(document.querySelectorAll('[role="dialog"]')).map((node) => node.innerText),
      toasts: Array.from(document.querySelectorAll('[data-radix-toast-viewport] *')).map((node) => node.innerText).filter(Boolean),
    }))()`);

    assert.equal(state.title, '联智标');
    assert.equal(state.readyState, 'complete');
    for (const forbiddenText of ['客户端授权提醒', '插件更新可用', '远程公告', '发现新版本']) {
      assert.equal(state.bodyText.includes(forbiddenText), false, `Unexpected startup text: ${forbiddenText}`);
    }
    console.log(JSON.stringify({
      title: state.title,
      readyState: state.readyState,
      dialogCount: state.dialogs.length,
      toastCount: state.toasts.length,
      forbiddenStartupNotices: false,
    }, null, 2));
  } finally {
    try {
      execFileSync('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      app.kill();
    }
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
