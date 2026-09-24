const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const supervisorPath = path.resolve(__dirname, '../supervisor.cjs');

async function waitFor(check, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(r => setTimeout(r, 60)); }
  throw Error('condition_timeout');
}
async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bid-supervisor-'));
  const childPath = path.join(root, 'helper.cjs'), harness = path.join(root, 'harness.cjs');
  const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r));
  fs.writeFileSync(childPath, `const fs=require('node:fs'),http=require('node:http');
const f=process.env.EVENT_FILE;const old=fs.existsSync(f)?fs.readFileSync(f,'utf8').trim().split('\\n').map(JSON.parse).filter(x=>x.type==='start').at(-1):null;
let overlap=false;if(old)try{process.kill(old.pid,0);overlap=true;}catch{}
fs.appendFileSync(f,JSON.stringify({type:'start',pid:process.pid,overlap})+'\\n');
http.createServer((req,res)=>{let bad=false;try{bad=fs.readFileSync(process.env.BAD_FILE,'utf8')===String(process.pid);}catch{}res.statusCode=req.url==='/ready'?503:bad?503:200;res.end('{}');}).listen(Number(process.env.HELPER_PORT),'127.0.0.1');
`);
  fs.writeFileSync(harness, `const api=require(${JSON.stringify(supervisorPath)});const fs=require('node:fs');
const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
if(config.failFirstStop){let calls=0;config.stopChild=async(...args)=>{fs.appendFileSync(config.stopAttemptFile,String(++calls)+'\\n');if(calls===1)throw Error('simulated_stop_uncertain');return api.stopVerified(...args);};}
if(config.failFirstInspect){let calls=0;config.inspectProcess=async pid=>{fs.appendFileSync(config.inspectAttemptFile,String(++calls)+'\\n');if(calls===1)throw Error('simulated_identity_unavailable');return api.processIdentity(pid);};}
delete config.failFirstStop;delete config.failFirstInspect;const supervisor=api.createSupervisor(config);
supervisor.start().catch(()=>process.exit(1));
`);
  const eventFile = path.join(root, 'events.jsonl'), badFile = path.join(root, 'bad-pid'), stopAttemptFile = path.join(root, 'stop-attempts'), inspectAttemptFile = path.join(root, 'inspect-attempts');
  const config = { dataRoot: path.join(root, 'data'), entryPath: childPath, healthUrl: 'http://127.0.0.1:' + port + '/health', startupGraceMs: 70000, pollMs: 80, restartDelayMs: 80, probeTimeoutMs: 500, stopGraceMs: 5000, stopAttemptFile, inspectAttemptFile, ...options };
  const configPath = path.join(root, 'config.json'); fs.writeFileSync(configPath, JSON.stringify(config));
  const processes = [];
  function launch() {
    const child = spawn(process.execPath, [harness, configPath], { windowsHide: true, env: { ...process.env, EVENT_FILE: eventFile, BAD_FILE: badFile, HELPER_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    const exit = new Promise(r => child.once('exit', (code, signal) => r({ code, signal }))); let output = '';
    child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
    const handle = { child, exit, output: () => output }; processes.push(handle); return handle;
  }
  t.after(async () => {
    if (fs.existsSync(supervisorPath)) {
      const { requestControl } = require(supervisorPath);
      await requestControl(config.dataRoot, 'stop').catch(() => {});
    }
    for (const p of processes) { if (p.child.exitCode === null) p.child.kill(); await p.exit; }
    if (fs.existsSync(supervisorPath)) {
      const { processIdentity, matchesEntry, stopVerified } = require(supervisorPath);
      for (const event of events()) {
        const identity = await processIdentity(event.pid);
        if (identity && matchesEntry(identity, process.execPath, config.entryPath)) await stopVerified(event.pid, identity.birth, process.execPath, config.entryPath, 5000);
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const events = () => { try { return fs.readFileSync(eventFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };
  const stopAttempts = () => { try { return fs.readFileSync(stopAttemptFile, 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; } };
  const inspectAttempts = () => { try { return fs.readFileSync(inspectAttemptFile, 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; } };
  return { root, config, badFile, events, stopAttempts, inspectAttempts, launch, childPath: config.entryPath, harness };
}

test('unhealthy child exits before replacement; readiness 503 alone never causes restart', { timeout: 40000 }, async t => {
  const f = await fixture(t); const p = f.launch();
  const first = await waitFor(() => f.events()[0]); await new Promise(r => setTimeout(r, 500));
  assert.equal(f.events().length, 1);
  fs.writeFileSync(f.badFile, String(first.pid));
  const second = await waitFor(() => f.events()[1]).catch(error => { throw Error(error.message + '\n' + p.output() + '\n' + fs.readFileSync(path.join(f.config.dataRoot, 'logs/supervisor.jsonl'), 'utf8')); }); assert.equal(second.overlap, false); assert.notEqual(second.pid, first.pid);
  const { requestControl } = require(supervisorPath); await requestControl(f.config.dataRoot, 'stop'); await p.exit;
  assert.throws(() => process.kill(second.pid, 0));
  assert.equal(fs.existsSync(path.join(f.config.dataRoot, 'supervisor.pid.json')), false);
});

test('an uncertain health-restart stop is retried without exiting or overlapping children', { timeout: 40000 }, async t => {
  const f = await fixture(t, { failFirstStop: true }); const p = f.launch();
  const first = await waitFor(() => f.events()[0]); fs.writeFileSync(f.badFile, String(first.pid));
  await waitFor(() => f.stopAttempts() >= 1);
  assert.equal(p.child.exitCode, null);
  const second = await waitFor(() => f.events()[1]).catch(error => { throw Error(error.message + '\n' + p.output() + '\n' + fs.readFileSync(path.join(f.config.dataRoot, 'logs/supervisor.jsonl'), 'utf8')); });
  assert.ok(f.stopAttempts() >= 2);
  assert.equal(second.overlap, false);
  assert.notEqual(second.pid, first.pid);
  const log = fs.readFileSync(path.join(f.config.dataRoot, 'logs/supervisor.jsonl'), 'utf8');
  assert.match(log, /"code":"child_stop_uncertain"/);
});

test('a transient spawned-child identity lookup is retried without exiting the supervisor', { timeout: 40000 }, async t => {
  const f = await fixture(t, { failFirstInspect: true });
  const p = f.launch();
  const first = await waitFor(() => f.events()[0]);
  await waitFor(() => f.inspectAttempts() >= 2);
  assert.equal(first.overlap, false);
  assert.equal(p.child.exitCode, null);
  const { requestControl } = require(supervisorPath);
  await requestControl(f.config.dataRoot, 'stop');
  await p.exit;
});

test('a second supervisor for the same root exits without replacing or stopping the active child', { timeout: 40000 }, async t => {
  const f = await fixture(t); const first = f.launch(); const event = await waitFor(() => f.events()[0]);
  const duplicate = f.launch(); const result = await duplicate.exit;
  assert.equal(result.code, 1); assert.equal(first.child.exitCode, null); assert.doesNotThrow(() => process.kill(event.pid, 0));
  assert.equal(f.events().length, 1);
});

test('PID metadata records exact process identity and unrelated stale PIDs are never killed', { timeout: 40000 }, async t => {
  const f = await fixture(t); fs.mkdirSync(f.config.dataRoot, { recursive: true });
  fs.writeFileSync(path.join(f.config.dataRoot, 'supervisor.pid.json'), JSON.stringify({ pid: process.pid, supervisorPath: 'unrelated.cjs', birth: 'wrong', childPid: process.pid, childPath: 'unrelated.cjs', childBirth: 'wrong' }));
  f.launch(); await waitFor(() => f.events()[0]);
  const meta = await waitFor(() => { try { const m = JSON.parse(fs.readFileSync(path.join(f.config.dataRoot, 'supervisor.pid.json'))); return m.childBirth ? m : null; } catch { return null; } });
  assert.equal(meta.childPath, path.join(f.root, 'helper.cjs')); assert.ok(meta.birth); assert.notEqual(meta.pid, process.pid);
  assert.doesNotThrow(() => process.kill(process.pid, 0));
});

test('orphan cleanup verifies the recorded child and confirms exit after supervisor termination', { timeout: 40000 }, async t => {
  const f = await fixture(t); const p = f.launch();
  const meta = await waitFor(() => { try { const m = JSON.parse(fs.readFileSync(path.join(f.config.dataRoot, 'supervisor.pid.json'))); return m.childBirth ? m : null; } catch { return null; } });
  p.child.kill(); await p.exit;
  const { cleanupRecorded } = require(supervisorPath);
  await cleanupRecorded({ dataRoot: f.config.dataRoot, mainPath: f.childPath, supervisorPath: f.harness, executable: process.execPath });
  assert.throws(() => process.kill(meta.childPid, 0));
  assert.equal(fs.existsSync(path.join(f.config.dataRoot, 'supervisor.pid.json')), false);
});

test('copied PID metadata from another data root cannot stop its live child using the same entry', { timeout: 40000 }, async t => {
  const first = await fixture(t); first.launch();
  const meta = await waitFor(() => { try { const m = JSON.parse(fs.readFileSync(path.join(first.config.dataRoot, 'supervisor.pid.json'))); return m.childBirth ? m : null; } catch { return null; } });
  const second = await fixture(t, { entryPath: first.childPath }); fs.mkdirSync(second.config.dataRoot, { recursive: true });
  fs.writeFileSync(path.join(second.config.dataRoot, 'supervisor.pid.json'), JSON.stringify(meta));
  second.launch(); await waitFor(() => second.events()[0]);
  assert.doesNotThrow(() => process.kill(meta.childPid, 0));
});
