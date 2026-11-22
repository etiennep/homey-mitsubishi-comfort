'use strict';

/*
 * Offline self-test: `npm test`
 *  - token matches the Python reference (pykumo / mitsubishi-comfort)
 *  - °F table matches the Comfort app mapping
 *  - a fake adapter that REJECTS bad signatures, driven by KumoUnit
 *  - the Homey device logic (capabilities, F rounding, auto setpoints) with a mocked Homey
 */

const assert = require('assert');
const http = require('http');
const Module = require('module');
const kumo = require('../lib/kumo');

// Vectors computed with the Python reference implementation.
const VECTORS = [
  ['dGVzdHBhc3N3b3Jk', '00112233445566778899', '{"c":{"indoorUnit":{"status":{}}}}', 'c18d5e9b5a9b10ec08c97fcf0f8ef713dd221e5186f04b74565614e0be0bb9d5'],
  ['b3RoZXJwYXNz', 'a1b2c3d4e5f60718293a', '{"c":{"indoorUnit":{"status":{"mode":"heat"}}}}', 'ffd0c4b0cf739807d18dd83458ae6c4c81a353f675cda1b7e05eedddc7a2697a'],
];
for (const [pw, cs, body, want] of VECTORS) {
  assert.strictEqual(kumo.computeToken(Buffer.from(pw, 'base64'), Buffer.from(cs, 'hex'), Buffer.from(body)), want);
}
console.log('✓ token matches Python reference');

assert.strictEqual(kumo.fahrenheitToSetpoint(70), 21.5);
assert.strictEqual(kumo.fahrenheitToSetpoint(67), 19.5);
assert.strictEqual(kumo.fahrenheitToSetpoint(69.4), 21.0);
assert.strictEqual(kumo.setpointToFahrenheit(21.5), 70);
assert.strictEqual(kumo.setpointToFahrenheit(19.0), 67);
for (let f = 61; f <= 80; f++) assert.strictEqual(kumo.setpointToFahrenheit(kumo.fahrenheitToSetpoint(f)), f);
console.log('✓ °F round-trip 61–80');

// ── Fake adapter ──────────────────────────────────────────────────────────
const PW = 'dGVzdHBhc3N3b3Jk';
const CS = '00112233445566778899';
const state = {
  mode: 'heat', standby: false, spHeat: 21.5, spCool: 24.0, roomTemp: 20.0,
  fanSpeed: 'quiet', vaneDir: 'auto', filterDirty: false, defrost: false,
};
const profile = {
  numberOfFanSpeeds: 5, hasFanSpeedAuto: true, hasVaneDir: true, hasVaneSwing: true,
  hasModeDry: true, hasModeHeat: true, hasModeVent: true,
  minimumSetPoints: { cool: 19.0, heat: 10.0, auto: 19.0 }, maximumSetPoints: { cool: 30.0, heat: 28.0, auto: 28.0 },
};
let rejected = 0;
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const m = new URL(req.url, 'http://x').searchParams.get('m');
    const want = kumo.computeToken(Buffer.from(PW, 'base64'), Buffer.from(CS, 'hex'), body);
    if (req.method !== 'PUT' || m !== want) {
      rejected++;
      res.end('{ _api_error: "device_authentication_error" }'); // real adapters return junk like this
      return;
    }
    const c = JSON.parse(body).c;
    let r = {};
    if (c.indoorUnit && c.indoorUnit.status) {
      Object.assign(state, c.indoorUnit.status);
      r = { indoorUnit: { status: { ...state } } };
    } else if (c.indoorUnit && c.indoorUnit.profile) r = { indoorUnit: { profile } };
    else if (c.adapter && c.adapter.status) r = { adapter: { status: { runState: 'normal', localNetwork: { stationMode: { RSSI: -36 } } } } };
    else if (c.adapter && c.adapter.info) r = { adapter: { info: { firmwareVersion: '02.06.26' } } };
    else if (c.sensors) r = { sensors: {} };
    else if (c.mhk2) r = { mhk2: null };
    // trailing 0xff padding like the real adapter
    res.end(Buffer.concat([Buffer.from(JSON.stringify({ r })), Buffer.from([])]));
  });
});

// ── Minimal Homey mock ────────────────────────────────────────────────────
const homeyMock = {
  App: class {},
  Driver: class {},
  Device: class {
    constructor() {
      this._caps = {};
      this._listeners = {};
      this._store = {};
      this._settings = {};
      this._available = true;
      this.homey = {
        setInterval: () => 0, clearInterval: () => {},
        setTimeout: () => 0, clearTimeout: () => {},
        i18n: { getUnits: () => 'imperial' },
      };
      this.driver = { modeChangedTrigger: { trigger: async (d, t) => { this.triggered.push(t); } }, fanChangedTrigger: { trigger: async () => {} } };
      this.triggered = [];
    }
    log() {} error(...a) { console.error('  device error:', ...a); }
    hasCapability(c) { return c in this._caps; }
    async addCapability(c) { this._caps[c] = null; }
    async removeCapability(c) { delete this._caps[c]; }
    getCapabilityValue(c) { return this._caps[c]; }
    async setCapabilityValue(c, v) { if (!(c in this._caps)) throw new Error(`no cap ${c}`); this._caps[c] = v; }
    registerCapabilityListener(c, fn) { this._listeners[c] = fn; }
    getStoreValue(k) { return this._store[k]; }
    async setStoreValue(k, v) { this._store[k] = v; }
    getSetting(k) { return this._settings[k]; }
    async setSettings(s) { Object.assign(this._settings, s); }
    getData() { return { id: 'TEST' }; }
    getAvailable() { return this._available; }
    async setAvailable() { this._available = true; }
    async setUnavailable(msg) { this._available = false; this.unavailableMsg = msg; }
  },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'homey' ? homeyMock : origLoad.call(this, req, ...rest); };

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.02, `${msg}: ${a} != ${b}`);

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const address = `127.0.0.1:${server.address().port}`;

  // Bad credentials are rejected cleanly
  const bad = new kumo.KumoUnit({ address, password: 'b3RoZXJwYXNz', cryptoSerial: CS });
  await assert.rejects(bad.getStatus(), /invalid JSON|Failed to read/);
  assert.ok(rejected > 0);
  console.log('✓ fake adapter rejects wrong key; client reports it');

  const unit = new kumo.KumoUnit({ address, password: PW, cryptoSerial: CS });
  const s = await unit.getStatus();
  assert.strictEqual(s.mode, 'heat');
  assert.strictEqual(s.wifiRssi, -36);
  assert.deepStrictEqual(unit.supportedModes(), ['off', 'cool', 'heat', 'dry', 'vent', 'auto']);
  assert.ok(unit.supportedVaneDirections().includes('swing'));
  await unit.setFanSpeed('low');
  assert.strictEqual(state.fanSpeed, 'low');
  await assert.rejects(unit.setHeatSetpoint(35), /above unit maximum/);
  // concurrent requests are serialized
  await Promise.all([unit.getStatus(), unit.setMode('cool'), unit.getStatus()]);
  assert.strictEqual(state.mode, 'cool');
  console.log('✓ local status/commands, limits, serialization');

  // ── Device logic ──
  const Device = require('../drivers/comfort/device');
  const caps = ['onoff', 'thermostat_mode', 'comfort_mode', 'target_temperature', 'measure_temperature', 'comfort_fan_speed',
    'comfort_vane', 'target_temperature.heat', 'target_temperature.cool', 'alarm_generic', 'comfort_rssi'];
  state.mode = 'heat';
  state.spHeat = 21.5; // 70 °F in the Comfort app
  const dev = new Device();
  caps.forEach((c) => { dev._caps[c] = null; });
  dev._settings = { address, poll_interval: 60, temp_units: 'auto' };
  dev._store = { password: PW, cryptoSerial: CS };
  await dev.onInit();
  await dev.poll();
  assert.strictEqual(dev._caps.comfort_mode, 'heat');
  assert.strictEqual(dev._caps.onoff, true);
  near(dev._caps.target_temperature, (70 - 32) / 1.8, 'heat setpoint shows as exactly 70°F');
  assert.strictEqual(dev._settings.firmware, '02.06.26');
  console.log('✓ device poll → capabilities (21.5 °C shows as 70 °F)');

  // User drags thermostat to 72 °F in Homey → Homey sends 22.222 °C → unit gets 22.5 (Comfort app's 72)
  await dev._listeners.target_temperature((72 - 32) / 1.8);
  assert.strictEqual(state.spHeat, 22.5);
  // 68 °F → 20.0
  await dev._listeners.target_temperature((68 - 32) / 1.8);
  assert.strictEqual(state.spHeat, 20.0);
  console.log('✓ °F setpoints follow the Comfort app table');

  // Off / on restores last mode
  await dev._listeners.onoff(false);
  assert.strictEqual(state.mode, 'off');
  await dev._listeners.onoff(true);
  assert.strictEqual(state.mode, 'heat');

  // Dry mode: thermostat_mode untouched, comfort_mode=dry, target maps to spCool
  await dev._listeners.comfort_mode('dry');
  await dev.poll();
  assert.strictEqual(dev._caps.comfort_mode, 'dry');
  assert.strictEqual(dev._caps.thermostat_mode, 'heat');
  await dev._listeners.target_temperature((76 - 32) / 1.8);
  assert.strictEqual(state.spCool, 24.5);
  console.log('✓ on/off restore, dry mode mapping');

  // Auto: target shifts both setpoints keeping the gap
  await dev.applyAutoSetpoints(68, 76); // Flow card in °F
  assert.strictEqual(state.spHeat, 20.0);
  assert.strictEqual(state.spCool, 24.5);
  await dev.applyMode('auto');
  await dev.poll();
  near(dev._caps.target_temperature, (72 - 32) / 1.8, 'auto midpoint 72°F');
  await dev._listeners.target_temperature((74 - 32) / 1.8); // +2 °F
  assert.strictEqual(state.spHeat, 21.5); // 70 °F
  assert.strictEqual(state.spCool, 25.5); // 78 °F
  await assert.rejects(dev.applyAutoSetpoints(78, 70), /at or below/);
  assert.ok(dev.triggered.some((t) => t.mode === 'auto'), 'mode_changed trigger fired');
  console.log('✓ auto mode setpoints + mode-changed trigger');

  // Celsius preference
  await dev.setSettings({ temp_units: 'celsius' });
  await dev.applyModeAndTemperature('heat', 21.3);
  assert.strictEqual(state.spHeat, 21.5);
  console.log('✓ Celsius rounding');

  // Unreachable → unavailable after 3 failures
  await dev.setSettings({ address: '127.0.0.1:1' });
  await dev.onSettings({ newSettings: dev._settings, changedKeys: ['address'] });
  for (let i = 0; i < 3; i++) await dev.poll().catch(() => {});
  assert.strictEqual(dev._available, false);
  console.log('✓ goes unavailable when the adapter is unreachable:', dev.unavailableMsg);


  // ── Cloud mode against a fake Mitsubishi V3 cloud ──
  const cloudState = { power: 1, operationMode: 'heat', spHeat: 20, spCool: 24, roomTemp: 19.5, fanSpeed: 'auto', airDirection: 'swing', humidity: 41, rssi: -35, connected: true };
  let tokenN = 0;
  let commandsSeen = [];
  const cloudSrv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
      const auth = req.headers.authorization || '';
      const send = (code, obj) => { res.statusCode = code; res.end(obj === undefined ? '' : JSON.stringify(obj)); };
      if (req.url === '/v3/login') {
        if (body.password !== 'pw') return send(401, { error: 'bad' });
        tokenN++;
        return send(200, { token: { access: `a${tokenN}`, refresh: `r${tokenN}` } });
      }
      if (req.url === '/v3/refresh') { tokenN++; return send(200, { access: `a${tokenN}`, refresh: `r${tokenN}` }); }
      if (auth !== `Bearer a${tokenN}`) return send(401, { error: 'expired' });
      if (req.url === '/v3/sites/') return send(200, [{ id: 'site1' }]);
      if (req.url === '/v3/sites/site1/zones') return send(200, [{ name: 'Bedroom', adapter: { deviceSerial: 'SER1' } }]);
      if (req.url === '/v3/devices/SER1/status') return send(200, { firmwareVersion: '02.06.26', mac: 'a0:cd' });
      if (req.url === '/v3/devices/SER1/profile') return send(200, [{ hasModeCool: true, hasModeHeat: true, hasModeDry: true, hasModeFan: true, hasVaneDir: true, hasVaneSwing: true, numberOfFanSpeeds: 5, hasFanSpeedAuto: true, minimumSetPoints: { heat: 10, cool: 19, auto: 17 }, maximumSetPoints: { heat: 28, cool: 30, auto: 28 } }]);
      if (req.url === '/v3/devices/SER1') return send(200, cloudState);
      if (req.url === '/v3/devices/send-command') {
        if (body.deviceSerial !== 'SER1') return send(400, { error: 'serial' });
        const c = body.commands;
        for (const k of ['spHeat', 'spCool']) if (k in c && (c[k] * 2) % 1 !== 0) return send(400, { error: { commands: 'invalidSpHeatIncrement' } });
        commandsSeen.push(c);
        if (c.operationMode === 'off') cloudState.power = 0;
        else if (c.operationMode) { cloudState.power = 1; cloudState.operationMode = c.operationMode; }
        Object.assign(cloudState, Object.fromEntries(Object.entries(c).filter(([k]) => k !== 'operationMode')));
        return send(200, { success: true });
      }
      return send(404, {});
    });
  });
  await new Promise((r) => cloudSrv.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${cloudSrv.address().port}`;

  // Fake Engine.IO v4 polling server
  const sio = { queue: [], waiting: null, posts: [], pongs: 0, handshakes: 0 };
  const flush = () => {
    if (sio.waiting && sio.queue.length) {
      const res = sio.waiting; sio.waiting = null;
      res.end(sio.queue.splice(0).join('\x1e'));
    }
  };
  sio.push = (pkt) => { sio.queue.push(pkt); flush(); };
  const sioSrv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.headers.authorization !== `Bearer a${tokenN}`) { res.statusCode = 401; return res.end(); }
    if (!u.searchParams.get('sid')) {
      sio.handshakes++;
      return res.end('0' + JSON.stringify({ sid: 'S1', pingInterval: 300, pingTimeout: 200, upgrades: [] }));
    }
    if (req.method === 'POST') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        for (const pkt of Buffer.concat(chunks).toString().split('\x1e')) {
          sio.posts.push(pkt);
          if (pkt === '40') sio.push('40{"sid":"N1"}');
          if (pkt === '3') sio.pongs++;
        }
        res.end('ok');
      });
      return undefined;
    }
    sio.waiting = res;
    flush();
    setTimeout(() => { if (sio.waiting === res) { sio.waiting = null; res.end('2'); } }, 300);
    return undefined;
  });
  await new Promise((r) => sioSrv.listen(0, '127.0.0.1', r));
  const socketUrl = `http://127.0.0.1:${sioSrv.address().port}`;
  const waitFor = async (fn, ms = 3000) => {
    const t0 = Date.now();
    while (!fn()) {
      if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition');
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  const badCloud = new kumo.KumoCloud('me@x', 'nope', { baseUrl });
  await assert.rejects(badCloud.login(), kumo.KumoAuthError);

  const cloud = new kumo.KumoCloud('me@x', 'pw', { baseUrl, socketUrl });
  const found = await cloud.discoverUnits({ socket: false });
  assert.strictEqual(found[0].serial, 'SER1');
  assert.strictEqual(found[0].complete, false);
  const cu = new kumo.KumoCloudUnit({ cloud, serial: 'SER1' });
  let cs = await cu.getStatus();
  assert.strictEqual(cs.mode, 'heat');
  assert.strictEqual(cs.vaneDir, 'swing');
  assert.ok(cu.supportedModes().includes('vent'));
  tokenN++; // simulate token expiry: next call gets 401 → refresh → retry
  await cu.setVaneDirection('auto');
  assert.deepStrictEqual(commandsSeen.pop(), { airDirection: 'auto' });
  await cu.setMode('off');
  cs = await cu.getStatus();
  assert.strictEqual(cs.mode, 'off');
  await cu.setHeatSetpoint(21.3); // snapped to 0.5 for the cloud
  assert.deepStrictEqual(commandsSeen.pop(), { spHeat: 21.5 });
  console.log('✓ cloud: login, discovery, token refresh, field mapping, 0.5° snapping');

  // Cloud device through the Homey device logic
  const cdev = new Device();
  caps.forEach((c) => { cdev._caps[c] = null; });
  cdev._settings = { address: '', poll_interval: 60, temp_units: 'auto' };
  cdev._store = { connection: 'cloud', username: 'me@x', password: 'pw' };
  cdev.getData = () => ({ id: 'SER1' });
  cdev.homey.app = { getCloud: () => cloud };
  await cdev.onInit();
  await cdev.poll();
  assert.strictEqual(cdev._available, true);
  assert.strictEqual(cdev._caps.onoff, false);
  await cdev._listeners.onoff(true);
  assert.strictEqual(cloudState.operationMode, 'heat');
  assert.strictEqual(cloudState.power, 1);
  await cdev._listeners.target_temperature((70 - 32) / 1.8);
  assert.strictEqual(cloudState.spHeat, 21.5);
  await cdev._listeners.comfort_fan_speed('quiet');
  assert.strictEqual(cloudState.fanSpeed, 'quiet');
  await cdev.poll();
  assert.strictEqual(cdev._caps.measure_humidity, 41);
  assert.strictEqual(cdev._settings.firmware, '02.06.26');
  console.log('✓ cloud device: on/off, °F setpoint, fan, humidity');

  // Live updates: device subscribes, answers pings, applies pushed device_update
  await waitFor(() => cloud.getStream().connected);
  assert.ok(sio.posts.includes('42["subscribe","SER1"]'), 'subscribed to unit');
  await waitFor(() => sio.pongs > 0, 2000);
  sio.push('42["device_update",{"deviceSerial":"SER1","roomTemp":23.5,"fanSpeed":"powerful"}]');
  await waitFor(() => cdev._caps.comfort_fan_speed === 'powerful');
  assert.strictEqual(cdev._caps.measure_temperature, 23.5);
  sio.push('42["device_update",{"deviceSerial":"OTHER","fanSpeed":"low"}]');
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(cdev._caps.comfort_fan_speed, 'powerful', 'ignores other units');
  // interval poll is skipped while the stream is healthy
  const before = cdev._lastPoll;
  await cdev.poll();
  assert.strictEqual(cdev._lastPoll, before);
  // server drops the session → stream reconnects
  const hs = sio.handshakes;
  sio.push('1');
  cloud.getStream()._backoff = 50;
  await waitFor(() => sio.handshakes > hs && cloud.getStream().connected, 8000);
  cdev.onDeleted();
  assert.strictEqual(cloud.getStream()._running, false);
  console.log('✓ live updates: subscribe, ping/pong, device_update, reconnect');
  cloudSrv.close();
  sioSrv.close();

  server.close();
  console.log('\nAll self-tests passed.');
})().catch((err) => {
  console.error('✗', err);
  server.close();
  process.exit(1);
});
