'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function canonicalRoot(root) {
  fs.mkdirSync(path.resolve(root), { recursive: true });
  return fs.realpathSync.native(path.resolve(root));
}
function lockAddress(root) {
  const canonical = canonicalRoot(root);
  const hash = createHash('sha256').update(process.platform === 'win32' ? canonical.toLowerCase() : canonical).digest('hex').slice(0, 32);
  if (process.platform === 'win32') return '\\\\.\\pipe\\openbidkit-feishu-' + hash;
  // Linux abstract sockets, like Windows named pipes, disappear when the owner exits.
  if (process.platform === 'linux') return '\0openbidkit-feishu-' + hash;
  throw Error('supervisor_platform_unsupported');
}
async function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'win32') {
      const command = '$p=Get-CimInstance Win32_Process -Filter ("ProcessId="+$env:OPENBIDKIT_INSPECT_PID); if($p){ @{pid=[int]$p.ProcessId;executable=$p.ExecutablePath;commandLine=$p.CommandLine;birth=$p.CreationDate.ToUniversalTime().ToString("o")} | ConvertTo-Json -Compress }';
      const result = await exec('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
        windowsHide: true, timeout: 10000, env: { ...process.env, OPENBIDKIT_INSPECT_PID: String(pid) }, maxBuffer: 128 * 1024
      });
      return result.stdout.trim() ? JSON.parse(result.stdout) : null;
    }
    const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
    return { pid, executable: fs.readlinkSync('/proc/' + pid + '/exe'), commandLine: fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0').filter(Boolean), birth: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] };
  } catch (error) {
    // A missing process is different from a process we could not inspect safely.
    try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') return null; }
    throw Error('process_identity_unavailable');
  }
}
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
function matchesEntry(identity, executable, entry) {
  if (!identity || !samePath(identity.executable, executable)) return false;
  if (Array.isArray(identity.commandLine)) return samePath(identity.commandLine[1], entry);
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Only our Node invocation forms: optional env-file flag followed by the exact script.
  const pattern = '^\\s*(?:"' + escape(executable) + '"|' + escape(executable) + ')(?:\\s+(?:"--env-file-if-exists=[^"]*"|--env-file-if-exists=\\S+))?\\s+(?:"' + escape(entry) + '"|' + escape(entry) + ')(?=\\s|$)';
  return new RegExp(pattern, 'i').test(identity.commandLine ?? '');
}
async function stopVerified(pid, birth, executable, entry, graceMs = 10000) {
  const identity = await processIdentity(pid);
  if (!identity) return;
  if (identity.birth !== birth || !matchesEntry(identity, executable, entry)) throw Error('process_identity_mismatch');
  if (process.platform === 'win32') {
    // SIGTERM on Windows is also forceful; taskkill additionally contains Electron descendants.
    await exec('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: graceMs, maxBuffer: 128 * 1024 }).catch(async () => {
      if (await processIdentity(pid)) throw Error('child_stop_failed');
    });
  } else {
    process.kill(pid, 'SIGTERM');
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    const current = await processIdentity(pid);
    if (!current || current.birth !== birth) return;
    await delay(100);
  }
  if (process.platform !== 'win32') {
    const current = await processIdentity(pid);
    if (current?.birth === birth && matchesEntry(current, executable, entry)) process.kill(pid, 'SIGKILL');
    for (let n = 0; n < 30; n++) { if (!await processIdentity(pid)) return; await delay(100); }
  }
  throw Error('child_stop_timeout');
}
function requestControl(dataRoot, command) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(lockAddress(dataRoot)); let raw = '';
    socket.setTimeout(5000, () => socket.destroy(Error('supervisor_control_timeout')));
    socket.once('connect', () => socket.write(JSON.stringify({ command }) + '\n'));
    socket.on('data', bytes => { raw += bytes; if (raw.length > 32768) socket.destroy(Error('supervisor_control_invalid')); if (raw.includes('\n')) { try { resolve(JSON.parse(raw)); } catch { reject(Error('supervisor_control_invalid')); } socket.destroy(); } });
    socket.once('error', () => reject(Error('supervisor_unavailable')));
    socket.once('end', () => { if (!raw) reject(Error('supervisor_unavailable')); });
  });
}
async function cleanupRecorded({ dataRoot, mainPath, supervisorPath, executable }) {
  const root = canonicalRoot(dataRoot), pidFile = path.join(root, 'supervisor.pid.json');
  const lock = net.createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => { lock.once('error', () => reject(Error('supervisor_still_running'))); lock.listen(lockAddress(root), resolve); });
  try {
    let record; try { record = JSON.parse(fs.readFileSync(pidFile, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return { ok: true }; throw Error('pid_metadata_invalid'); }
    if (!samePath(record.dataRoot, root) || !samePath(record.supervisorPath, supervisorPath) || !samePath(record.childPath, mainPath) || !samePath(record.executable, executable)) throw Error('pid_metadata_mismatch');
    const supervisor = await processIdentity(record.pid);
    if (supervisor) throw Error('recorded_supervisor_pid_active');
    if (record.childPid) await stopVerified(record.childPid, record.childBirth, executable, mainPath);
    if (JSON.parse(fs.readFileSync(pidFile, 'utf8')).instance !== record.instance) throw Error('pid_metadata_changed');
    fs.unlinkSync(pidFile); return { ok: true };
  } finally { await new Promise(resolve => lock.close(resolve)); }
}
function createSupervisor({ dataRoot, entryPath = path.join(__dirname, 'main.cjs'), healthUrl, startupGraceMs = 90000, pollMs = 5000, restartDelayMs = 3000, probeTimeoutMs = 3000, stopGraceMs = 15000 }) {
  if (!Number.isFinite(startupGraceMs) || startupGraceMs < 70000) throw Error('startup_grace_too_short');
  for (const n of [pollMs, restartDelayMs, probeTimeoutMs, stopGraceMs]) if (!Number.isFinite(n) || n < 20) throw Error('supervisor_timing_invalid');
  const root = canonicalRoot(dataRoot), entry = fs.realpathSync.native(entryPath), supervisorPath = fs.realpathSync.native(process.argv[1]);
  const url = new URL(healthUrl);
  const localAddresses = new Set(['127.0.0.1', 'localhost', '::1', ...Object.values(os.networkInterfaces()).flat().filter(Boolean).map(item => item.address)]);
  if (url.protocol !== 'http:' || !localAddresses.has(url.hostname.replace(/^\[|\]$/g, '')) || url.pathname !== '/health' || url.username || url.password || url.search || url.hash) throw Error('health_url_invalid');
  const logs = path.join(root, 'logs'); fs.mkdirSync(logs, { recursive: true });
  const pidFile = path.join(root, 'supervisor.pid.json'), instance = randomUUID();
  let stopping = false, currentChild = null, owner = null, started = false;
  const wake = new AbortController();
  const event = code => fs.appendFileSync(path.join(logs, 'supervisor.jsonl'), JSON.stringify({ time: new Date().toISOString(), code }) + '\n');
  function persist() { const temp = pidFile + '.' + instance; fs.writeFileSync(temp, JSON.stringify(owner), { mode: 0o600 }); fs.renameSync(temp, pidFile); }
  const server = net.createServer(socket => {
    let raw = ''; socket.setTimeout(5000, () => socket.destroy());
    socket.on('data', bytes => {
      raw += bytes; if (raw.length > 1024) return socket.destroy(); if (!raw.includes('\n')) return;
      try {
        const { command } = JSON.parse(raw);
        if (command === 'status') socket.end(JSON.stringify({ ok: true, ...owner }) + '\n');
        else if (command === 'stop') { socket.end('{"ok":true}\n'); stopping = true; wake.abort(); }
        else socket.end('{"ok":false}\n');
      } catch { socket.destroy(); }
    });
    socket.on('error', () => {});
  });
  async function pause(ms) { if (stopping) return; await new Promise(resolve => { const timer = setTimeout(done, ms); function done() { clearTimeout(timer); wake.signal.removeEventListener('abort', done); resolve(); } wake.signal.addEventListener('abort', done, { once: true }); }); }
  async function monitor(child, exited) {
    const since = Date.now(); let healthy = false, failures = 0;
    while (!stopping && child.exitCode === null && child.signalCode === null) {
      try {
        const response = await fetch(url, { redirect: 'error', signal: AbortSignal.any([wake.signal, AbortSignal.timeout(probeTimeoutMs)]) });
        await response.body?.cancel();
        if (response.status === 503) return 'health_ownership_lost';
        if (response.ok) { healthy = true; failures = 0; } else failures++;
      } catch { failures++; }
      if ((healthy || Date.now() - since >= startupGraceMs) && failures >= 3) return 'health_probe_failed';
      await Promise.race([exited, pause(pollMs)]);
    }
    return stopping ? 'stopping' : 'child_exited';
  }
  async function start() {
    if (started) throw Error('supervisor_already_started'); started = true;
    await new Promise((resolve, reject) => { server.once('error', () => reject(Error('supervisor_already_running'))); server.listen(lockAddress(root), resolve); });
    const signalStop = () => { stopping = true; wake.abort(); };
    process.on('SIGINT', signalStop); process.on('SIGTERM', signalStop);
    try {
      const self = await processIdentity(process.pid); if (!self) throw Error('supervisor_identity_missing');
      let old; try { old = JSON.parse(fs.readFileSync(pidFile, 'utf8')); } catch {}
      if (old?.childPid && samePath(old.dataRoot, root) && samePath(old.supervisorPath, supervisorPath) && samePath(old.childPath, entry) && samePath(old.executable, process.execPath)) {
        const orphan = await processIdentity(old.childPid);
        if (orphan) {
          if (!old.childBirth || orphan.birth !== old.childBirth || !matchesEntry(orphan, process.execPath, entry)) throw Error('orphan_identity_uncertain');
          await stopVerified(old.childPid, old.childBirth, process.execPath, entry, stopGraceMs);
        }
      }
      owner = { schema: 1, instance, pid: process.pid, birth: self.birth, executable: process.execPath, supervisorPath, dataRoot: root, childPath: entry, childPid: null, childBirth: null };
      persist(); event('supervisor_started');
      while (!stopping) {
        const out = fs.openSync(path.join(logs, 'main.stdout.log'), 'a'), err = fs.openSync(path.join(logs, 'main.stderr.log'), 'a');
        let child;
        try { child = spawn(process.execPath, [entry], { cwd: __dirname, env: { ...process.env, BID_DATA_ROOT: root }, windowsHide: true, stdio: ['ignore', out, err] }); }
        finally { fs.closeSync(out); fs.closeSync(err); }
        currentChild = child;
        const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
        await new Promise(resolve => { child.once('spawn', resolve); child.once('error', resolve); });
        owner.childPid = child.pid ?? null; owner.childBirth = null; persist();
        let identity;
        try { identity = child.pid ? await processIdentity(child.pid) : null; }
        catch (error) { child.kill(); await exited; currentChild = null; throw error; }
        owner.childBirth = identity?.birth ?? null; persist(); event('child_started');
        const reason = identity ? await monitor(child, exited) : 'child_spawn_failed';
        event(reason);
        if (child.exitCode === null && child.signalCode === null && identity) await stopVerified(child.pid, identity.birth, process.execPath, entry, stopGraceMs);
        await exited; currentChild = null;
        owner.childPid = null; owner.childBirth = null; persist(); event('child_exit_confirmed');
        if (!stopping) await pause(restartDelayMs);
      }
    } catch (error) {
      event(currentChild ? 'child_stop_uncertain' : 'supervisor_start_failed'); throw error;
    } finally {
      process.removeListener('SIGINT', signalStop); process.removeListener('SIGTERM', signalStop);
      // On an uncertain stop, retain metadata so the operator can identify the exact original process.
      if (!currentChild) { try { if (JSON.parse(fs.readFileSync(pidFile)).instance === instance) fs.unlinkSync(pidFile); } catch {} }
      await new Promise(resolve => server.close(resolve)); event('supervisor_stopped');
    }
  }
  return { start };
}
function description(args = process.argv.slice(2), env = process.env) {
  const index = args.indexOf('--data-root');
  if (index >= 0 && !args[index + 1]) throw Error('data_root_missing');
  const dataRoot = canonicalRoot(index >= 0 ? args[index + 1] : env.BID_DATA_ROOT || path.join(__dirname, 'data'));
  const port = Number(env.BID_PORT || 4381); if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('port_invalid');
  const boundHost = env.BID_HOST || '127.0.0.1', host = boundHost === '0.0.0.0' ? '127.0.0.1' : boundHost === '::' ? '::1' : boundHost;
  return { dataRoot, pidFile: path.join(dataRoot, 'supervisor.pid.json'), supervisorPath: __filename, mainPath: path.join(__dirname, 'main.cjs'), executable: process.execPath, healthUrl: 'http://' + (host.includes(':') ? '[' + host + ']' : host) + ':' + port + '/health' };
}
if (require.main === module) {
  (async () => {
    const d = description(), command = process.argv[2] || 'run';
    if (command === 'describe') return console.log(JSON.stringify(d));
    if (command === 'cleanup') return console.log(JSON.stringify(await cleanupRecorded(d)));
    if (command === 'status' || command === 'stop') return console.log(JSON.stringify(await requestControl(d.dataRoot, command)));
    if (command !== 'run') throw Error('command_invalid');
    await createSupervisor(d).start();
  })().catch(() => { console.error('supervisor_failed'); process.exitCode = 1; });
}
module.exports = { createSupervisor, requestControl, processIdentity, matchesEntry, stopVerified, cleanupRecorded, description };
