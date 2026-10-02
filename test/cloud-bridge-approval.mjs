import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { startApprovalServer } from '../examples/cloud-bridge-approval-server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(ROOT, 'src/chrome/src/offscreen/cloud-bridge.js'), 'utf8');
const IDENTITY = { token: 'secret-token', browserId: 'browser-1', installationId: 'install-1', extensionVersion: '1.2.3' };
const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

function harness({ WebSocketImpl, sendMessage = async () => ({ runId: 'r1', status: 'running' }) } = {}) {
  const sockets = [];
  const timers = [];
  const runtimeCalls = [];
  let listener;
  class FakeWebSocket {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    constructor(url) { this.url = url; this.readyState = 0; this.listeners = new Map(); this.sent = []; sockets.push(this); }
    addEventListener(type, cb) { this.listeners.set(type, cb); }
    send(v) { this.sent.push(JSON.parse(v)); }
    close() { this.readyState = 2; this.emit('close'); }
    emit(type, value = {}) {
      if (type === 'open') this.readyState = 1;
      if (type === 'close') this.readyState = 3;
      this.listeners.get(type)?.(value);
    }
    receive(obj) { return this.emit('message', { data: JSON.stringify(obj) }); }
  }
  vm.runInNewContext(source, {
    URL,
    WebSocket: WebSocketImpl || FakeWebSocket,
    navigator: { userAgent: 'Mozilla/5.0 Chrome/126.0.1 Safari/537.36', platform: 'Linux x86_64' },
    chrome: { runtime: {
      onMessage: { addListener: cb => { listener = cb; } },
      sendMessage: async m => { runtimeCalls.push(m); return sendMessage(m); },
    } },
    setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    clearTimeout: () => {},
  });
  const start = (extra = IDENTITY, url = 'ws://127.0.0.1:17374/extension') => {
    let out; listener({ type: 'cloud-bridge-start', url, ...extra }, null, v => { out = v; }); return out;
  };
  const status = () => { let out; listener({ type: 'cloud-bridge-status' }, null, v => { out = v; }); return out; };
  return { sockets, timers, runtimeCalls, start, status };
}

const cmd = { id: 'c1', action: 'cloud_status', payload: { runId: 'r1' } };

test('hello carries identity, token, browser, version and platform', () => {
  const h = harness();
  h.start();
  h.sockets[0].emit('open');
  const hello = h.sockets[0].sent[0];
  assert.equal(hello.type, 'hello');
  assert.deepEqual(hello.auth, { type: 'bearer', token: 'secret-token' });
  assert.equal(hello.browserId, 'browser-1');
  assert.equal(hello.installationId, 'install-1');
  assert.deepEqual({ ...hello.browser }, { name: 'Chrome', version: '126.0.1' });
  assert.equal(hello.extensionVersion, '1.2.3');
  assert.equal(hello.platform, 'Linux x86_64');
  assert.deepEqual([...hello.capabilities], ['saved_workflows_v1', 'run_modes_v1', 'scheduled_jobs_v1']);
  assert.equal(JSON.stringify(hello.status).includes('secret-token'), false, 'status must not leak the token');
  assert.equal(JSON.stringify(h.status()).includes('secret-token'), false);
});

test('pending connection refuses cloud commands without calling the background', async () => {
  const h = harness();
  h.start();
  const s = h.sockets[0];
  s.emit('open');
  s.receive({ type: 'connection_pending', browserId: 'browser-1' });
  assert.equal(h.status().approval, 'pending');
  s.receive(cmd);
  await tick();
  const reply = s.sent.find(m => m.id === 'c1');
  assert.equal(reply.ok, false);
  assert.equal(reply.code, 'connection_not_approved');
  assert.equal(h.runtimeCalls.length, 0);
});

test('commands are refused before any approval message too', async () => {
  const h = harness();
  h.start();
  h.sockets[0].emit('open');
  h.sockets[0].receive(cmd);
  await tick();
  assert.equal(h.sockets[0].sent.find(m => m.id === 'c1').ok, false);
  assert.equal(h.runtimeCalls.length, 0);
});

test('approved connection runs commands with the unchanged payload format', async () => {
  const h = harness();
  h.start();
  const s = h.sockets[0];
  s.emit('open');
  s.receive({ type: 'connection_pending' });
  s.receive({ type: 'connection_approved', browserId: 'browser-1' });
  assert.equal(h.status().approval, 'approved');
  s.receive(cmd);
  await tick();
  assert.deepEqual({ ...h.runtimeCalls[0] }, { runId: 'r1', target: 'background', action: 'cloud_status' });
  const reply = s.sent.find(m => m.id === 'c1');
  assert.equal(reply.ok, true);
  assert.equal(reply.result.status, 'running');
});

test('approval for another browserId is ignored', async () => {
  const h = harness();
  h.start();
  h.sockets[0].emit('open');
  h.sockets[0].receive({ type: 'connection_approved', browserId: 'someone-else' });
  assert.equal(h.status().approval, 'pending');
});

test('rejected connection closes, blocks commands and does not reconnect', async () => {
  const h = harness();
  h.start();
  const s = h.sockets[0];
  s.emit('open');
  s.receive({ type: 'connection_rejected', reason: 'nope' });
  assert.equal(h.status().approval, 'rejected');
  assert.equal(h.status().lastError, 'nope');
  assert.equal(s.readyState, 3);
  assert.equal(h.timers.length, 0, 'no reconnect after rejection');
  s.receive(cmd);
  await tick();
  assert.equal(h.runtimeCalls.length, 0);
});

test('reconnect requires a fresh approval', async () => {
  const h = harness();
  h.start();
  const first = h.sockets[0];
  first.emit('open');
  first.receive({ type: 'connection_approved' });
  first.close();
  assert.equal(h.status().approval, 'pending');
  h.timers[0].callback();
  const second = h.sockets[1];
  second.emit('open');
  assert.equal(second.sent[0].type, 'hello');
  assert.equal(second.sent[0].auth.token, 'secret-token');
  second.receive(cmd);
  await tick();
  assert.equal(second.sent.find(m => m.id === 'c1').code, 'connection_not_approved');
  assert.equal(h.runtimeCalls.length, 0);
  second.receive({ type: 'connection_approved' });
  second.receive(cmd);
  await tick();
  assert.equal(h.runtimeCalls.length, 1);
});

test('without a token the legacy behaviour is unchanged', async () => {
  const h = harness();
  h.start({});
  const s = h.sockets[0];
  s.emit('open');
  assert.equal(s.sent[0].auth, undefined);
  assert.equal(h.status().approval, 'not_required');
  s.receive(cmd);
  await tick();
  assert.equal(h.runtimeCalls.length, 1);
});

test('end to end against the example server', async () => {
  const received = [];
  const server = await startApprovalServer({ port: 0, token: 'secret-token', onMessage: m => received.push(m) });
  const h = harness({ WebSocketImpl: WebSocket });
  try {
    h.start(IDENTITY, `ws://127.0.0.1:${server.port}/extension`);
    for (let i = 0; i < 50 && ![...server.sessions].some(s => s.state === 'pending'); i++) await tick(20);
    const session = [...server.sessions][0];
    assert.equal(session.state, 'pending');
    assert.equal(session.hello.browserId, 'browser-1');
    session.send(cmd);
    for (let i = 0; i < 50 && !received.some(m => m.id === 'c1'); i++) await tick(20);
    assert.equal(received.find(m => m.id === 'c1').code, 'connection_not_approved');
    session.approve();
    session.send({ ...cmd, id: 'c2' });
    for (let i = 0; i < 50 && !received.some(m => m.id === 'c2'); i++) await tick(20);
    assert.equal(received.find(m => m.id === 'c2').ok, true);
  } finally {
    await server.close();
  }
});
