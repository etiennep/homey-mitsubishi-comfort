'use strict';

/*
 * Mitsubishi Comfort / Kumo client — no Homey dependencies, so the same file
 * powers the Homey app and the standalone test script (tools/kumo-test.js).
 *
 * Protocol ported from:
 *   - pykumo (https://github.com/dlarrick/pykumo, MIT, (c) 2019 dlarrick)
 *   - mitsubishi-comfort (the library behind Home Assistant's
 *     mitsubishi_comfort integration), which derives from pykumo.
 *
 * Two halves:
 *   1. KumoCloud — used ONCE at pairing to fetch each unit's local credentials
 *      (serial, base64 password, cryptoSerial) from the Comfort cloud.
 *   2. KumoUnit  — local-only control: signed HTTP PUTs to http://<ip>/api.
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');
const http = require('http');
const https = require('https');

// ── Constants ──────────────────────────────────────────────────────────────

const W_PARAM = Buffer.from(
  '44c73283b498d432ff25f5c8e06a016aef931e68f0a00ea710e36e6338fb22db',
  'hex',
);
const S_PARAM = 0;
const CRYPTO_SERIAL_MIN_BYTES = 9;

const V3_BASE_URL = 'https://app-prod.kumocloud.com';
const V3_SOCKET_URL = 'https://socket-prod.kumocloud.com';
const V3_APP_VERSION = '3.2.4';
const V2_LOGIN_URL = 'https://geo-c.kumocloud.com/login';
const V2_APP_VERSION = '2.2.0';

const LOCAL_TIMEOUT_MS = 8000;
const CLOUD_TIMEOUT_MS = 30000;

const MODES = ['off', 'heat', 'cool', 'auto', 'dry', 'vent'];
const FAN_SPEEDS_BY_COUNT = {
  3: ['quiet', 'low', 'powerful'],
  4: ['quiet', 'low', 'powerful', 'superPowerful'],
  5: ['superQuiet', 'quiet', 'low', 'powerful', 'superPowerful'],
};
const VANE_DIRECTIONS = ['horizontal', 'midhorizontal', 'midpoint', 'midvertical', 'vertical', 'auto'];

// ── Errors ─────────────────────────────────────────────────────────────────

class KumoError extends Error {}
class KumoAuthError extends KumoError {}
class KumoConnectionError extends KumoError {}

// ── Local API token ───────────────────────────────────────────────────────

/**
 * SHA-256 token for one local API request (port of pykumo PyKumoBase._token).
 * @param {Buffer} password  decoded (from base64) device password
 * @param {Buffer} cryptoSerial  cryptoSerial bytes (>= 9 bytes)
 * @param {Buffer} postData  exact request body bytes
 */
function computeToken(password, cryptoSerial, postData) {
  if (cryptoSerial.length < CRYPTO_SERIAL_MIN_BYTES) {
    throw new KumoError(`cryptoSerial too short (${cryptoSerial.length} bytes, need ${CRYPTO_SERIAL_MIN_BYTES})`);
  }
  const dataHash = crypto.createHash('sha256').update(Buffer.concat([password, postData])).digest();
  const intermediate = Buffer.alloc(88);
  W_PARAM.copy(intermediate, 0, 0, 32);
  dataHash.copy(intermediate, 32, 0, 32);
  intermediate[64] = 0x08;
  intermediate[65] = 0x40;
  intermediate[66] = S_PARAM;
  intermediate[79] = cryptoSerial[8];
  cryptoSerial.copy(intermediate, 80, 4, 8);
  cryptoSerial.copy(intermediate, 84, 0, 4);
  return crypto.createHash('sha256').update(intermediate).digest('hex');
}

// ── Comfort-app °F ↔ setpoint mapping (from mitsubishi-comfort) ───────────

const F_TO_SETPOINT = {
  61: 16.0, 62: 16.5, 63: 17.0, 64: 17.5, 65: 18.0, 66: 18.5, 67: 19.5, 68: 20.0,
  69: 21.0, 70: 21.5, 71: 22.0, 72: 22.5, 73: 23.0, 74: 23.5, 75: 24.0, 76: 24.5,
  77: 25.0, 78: 25.5, 79: 26.0, 80: 26.5,
};
const SETPOINT_TO_F = {};
for (const [f, c] of Object.entries(F_TO_SETPOINT)) SETPOINT_TO_F[c] = Number(f);
SETPOINT_TO_F[19.0] = 67;
SETPOINT_TO_F[20.5] = 69;

function fahrenheitToSetpoint(f) {
  if (!Number.isFinite(f)) throw new KumoError('Temperature must be finite');
  const whole = Math.floor(f + 0.5);
  if (F_TO_SETPOINT[whole] !== undefined) return F_TO_SETPOINT[whole];
  return Math.round(((whole - 32) / 1.8) * 2) / 2;
}

function setpointToFahrenheit(c) {
  if (!Number.isFinite(c)) throw new KumoError('Temperature must be finite');
  if (SETPOINT_TO_F[c] !== undefined) return SETPOINT_TO_F[c];
  return Math.round(c * 1.8 + 32);
}

// ── Tiny HTTP helper (no fetch: works on any Homey Node version) ──────────

function httpRequest(url, { method = 'GET', headers = {}, body = null, timeout = CLOUD_TIMEOUT_MS, agent } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    if (body != null && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-length')) {
      headers = { ...headers, 'Content-Length': Buffer.byteLength(body) };
    }
    const req = lib.request(u, { method, headers, agent, timeout }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error(`timeout after ${timeout} ms`), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function parseJson(buf) {
  // Adapter echoes EEPROM strings with 0xff padding — decode leniently.
  return JSON.parse(buf.toString('utf8'));
}

/** Structure of a JSON value with secrets/values redacted (for debugging). */
function shape(v, depth = 0) {
  if (depth > 6) return '…';
  if (Array.isArray(v)) return v.length ? [shape(v[0], depth + 1), `(${v.length} items)`] : [];
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (x && typeof x === 'object') o[k] = shape(x, depth + 1);
      else if (/password|token|crypto|secret/i.test(k)) o[k] = x ? `<${typeof x}, len ${String(x).length}>` : x;
      else o[k] = typeof x === 'string' ? (x.length > 40 ? `<string len ${x.length}>` : x) : x;
    }
    return o;
  }
  return v;
}

// ── Cloud (pairing only) ──────────────────────────────────────────────────

class KumoCloud {
  constructor(username, password, { log = () => {}, baseUrl = V3_BASE_URL, socketUrl = V3_SOCKET_URL } = {}) {
    this.baseUrl = baseUrl;
    this.socketUrl = socketUrl;
    this.username = username;
    this.password = password;
    this.log = log;
    this.accessToken = null;
    this.refreshToken = null;
    this._retryAfter = 0;
  }

  _headers(extra = {}) {
    const h = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'x-app-version': V3_APP_VERSION,
      ...extra,
    };
    if (this.accessToken) h.Authorization = `Bearer ${this.accessToken}`;
    return h;
  }

  async _json(url, opts) {
    let res;
    try {
      res = await httpRequest(url, opts);
    } catch (err) {
      throw new KumoConnectionError(`Cannot reach Mitsubishi cloud: ${err.message}`);
    }
    if (res.status === 401 || res.status === 403) throw new KumoAuthError(`Mitsubishi cloud rejected the login (HTTP ${res.status})`);
    if (res.status === 429) throw new KumoConnectionError('Mitsubishi cloud rate limit hit — wait a minute and retry');
    if (res.status < 200 || res.status >= 300) {
      throw new KumoConnectionError(`Mitsubishi cloud error HTTP ${res.status}: ${res.body.toString('utf8').slice(0, 200)}`);
    }
    if (res.status === 204 || res.body.length === 0) return null;
    try {
      return parseJson(res.body);
    } catch (err) {
      throw new KumoConnectionError('Mitsubishi cloud returned invalid JSON');
    }
  }

  async login() {
    const body = JSON.stringify({ username: this.username, password: this.password, appVersion: V3_APP_VERSION });
    this.accessToken = null;
    const data = await this._json(`${this.baseUrl}/v3/login`, { method: 'POST', headers: this._headers(), body });
    this.accessToken = data && data.token && data.token.access;
    this.refreshToken = data && data.token && data.token.refresh;
    if (!this.accessToken) throw new KumoAuthError('Login response missing access token');
  }

  async refresh() {
    if (!this.refreshToken) throw new KumoAuthError('No refresh token');
    const headers = { ...this._headers(), Authorization: `Bearer ${this.refreshToken}` };
    const data = await this._json(`${this.baseUrl}/v3/refresh`, {
      method: 'POST', headers, body: JSON.stringify({ refresh: this.refreshToken }),
    });
    if (!data || !data.access) throw new KumoAuthError('Refresh response missing access token');
    this.accessToken = data.access;
    if (data.refresh) this.refreshToken = data.refresh;
  }

  /** Authenticated call; on 401 refreshes the token, then falls back to a full login. */
  async _authed(method, path, body) {
    if (Date.now() < this._retryAfter) throw new KumoConnectionError('Mitsubishi cloud rate limit in effect; will retry later');
    if (!this.accessToken) await this.login();
    const call = () => this._json(`${this.baseUrl}${path}`, {
      method, headers: this._headers(), body: body == null ? null : JSON.stringify(body),
    });
    try {
      return await call();
    } catch (err) {
      if (err instanceof KumoConnectionError && /rate limit/.test(err.message)) {
        this._retryAfter = Date.now() + 120000;
        throw err;
      }
      if (!(err instanceof KumoAuthError)) throw err;
    }
    try {
      await this.refresh();
    } catch (e) {
      await this.login();
    }
    return call();
  }

  _get(path) {
    return this._authed('GET', path);
  }

  /** Shared live-update stream for this account (created lazily). */
  getStream() {
    if (!this._stream) this._stream = new KumoCloudStream(this, { log: this.log, socketUrl: this.socketUrl });
    return this._stream;
  }

  async getDeviceDetails(serial) {
    const d = await this._get(`/v3/devices/${serial}`);
    if (!d || typeof d !== 'object') throw new KumoConnectionError('Cloud returned no device state');
    return d;
  }

  async getDeviceProfile(serial) {
    let d = await this._get(`/v3/devices/${serial}/profile`);
    if (Array.isArray(d)) d = d[0];
    if (!d || typeof d !== 'object') throw new KumoConnectionError('Cloud returned no device profile');
    return d;
  }

  async sendCommand(serial, commands) {
    const r = await this._authed('POST', '/v3/devices/send-command', { deviceSerial: serial, commands });
    if (r && typeof r === 'object' && (r.success === false || r.error || r.errors)) {
      throw new KumoError(`Cloud rejected the command: ${JSON.stringify(r.error || r.errors || r).slice(0, 200)}`);
    }
    return r;
  }

  async _v2Credentials() {
    // V3 stopped returning cryptoSerial/password for newer accounts; the legacy
    // V2 login still returns both (keyed by serial) — same fallback HA uses.
    const body = JSON.stringify({ username: this.username, password: this.password, appVersion: V2_APP_VERSION });
    let data;
    try {
      const res = await httpRequest(V2_LOGIN_URL, {
        method: 'POST',
        headers: { Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json' },
        body,
      });
      if (res.status < 200 || res.status >= 300) {
        this.log(`V2 login failed: HTTP ${res.status}`);
        return {};
      }
      data = parseJson(res.body);
      this._v2Raw = data;
    } catch (err) {
      this.log(`V2 login error: ${err.message}`);
      return {};
    }
    const creds = {};
    if (!Array.isArray(data) || data.length < 3 || typeof data[2] !== 'object' || !data[2]) return creds;
    const harvest = (node) => {
      const table = node.zoneTable;
      if (table && typeof table === 'object') {
        for (const raw of Object.values(table)) {
          if (raw && raw.serial) {
            creds[raw.serial] = {
              password: raw.password || '',
              cryptoSerial: raw.cryptoSerial || '',
              mac: raw.mac || '',
              label: raw.label || '',
              address: raw.address || '',
            };
          }
        }
      }
      for (const child of node.children || []) if (child && typeof child === 'object') harvest(child);
    };
    harvest(data[2]);
    return creds;
  }

  _userIdFromToken() {
    try {
      const part = this.accessToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const payload = JSON.parse(Buffer.from(part, 'base64').toString('utf8'));
      return payload.id != null ? String(payload.id) : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Socket.IO (Engine.IO v4 long-polling) password retrieval, as in pykumo v0.4+.
   * The cloud pushes `adapter_update` events that carry the adapter's local
   * password (and sometimes cryptoSerial). Returns serial -> { password, cryptoSerial }.
   */
  async socketCredentials(serials, timeoutMs = 45000) {
    const found = {};
    const need = new Set(serials);
    const cookies = {};
    const seenEvents = {};
    const base = `${V3_SOCKET_URL}/socket.io/?EIO=4&transport=polling`;
    let url = base;

    const req = async (method, body, timeout = 15000) => {
      const headers = { Authorization: `Bearer ${this.accessToken}`, Accept: '*/*' };
      if (body != null) headers['Content-Type'] = 'text/plain;charset=UTF-8';
      const cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookie) headers.Cookie = cookie;
      const res = await httpRequest(`${url}&t=${Date.now().toString(36)}`, { method, headers, body, timeout });
      for (const sc of [].concat(res.headers['set-cookie'] || [])) {
        const [kv] = sc.split(';');
        const i = kv.indexOf('=');
        if (i > 0) cookies[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
      }
      return { status: res.status, text: res.body.toString('utf8') };
    };
    const post = (data) => req('POST', data, 10000);
    const poll = (timeout = 10000) => req('GET', null, timeout);

    const extract = (text) => {
      for (let msg of String(text || '').split('\x1e')) {
        const colon = msg.indexOf(':');
        if (colon > 0 && /^\d+$/.test(msg.slice(0, colon))) msg = msg.slice(colon + 1);
        if (!msg.startsWith('42')) continue;
        let payload;
        try { payload = JSON.parse(msg.slice(2)); } catch (e) { continue; }
        if (!Array.isArray(payload) || payload.length < 2) continue;
        const [event, data] = payload;
        if (data && typeof data === 'object') {
          seenEvents[event] = seenEvents[event] || new Set();
          for (const k of Object.keys(data)) seenEvents[event].add(k);
          const serial = data.deviceSerial || data.serial;
          if (serial && need.has(serial)) {
            found[serial] = found[serial] || {};
            if (data.password) found[serial].password = data.password;
            if (data.cryptoSerial) found[serial].cryptoSerial = data.cryptoSerial;
          }
        }
      }
    };
    const done = () => [...need].every((s) => found[s] && found[s].password);

    try {
      const hs = await poll(15000);
      if (hs.status !== 200 || !hs.text.startsWith('0')) {
        this.log(`Socket.IO handshake unexpected: HTTP ${hs.status} ${hs.text.slice(0, 120)}`);
        return { found, seenEvents };
      }
      const sid = JSON.parse(hs.text.slice(1)).sid;
      url = `${base}&sid=${encodeURIComponent(sid)}`;

      await post('40');
      let r = await poll();
      if (r.text.startsWith('44')) {
        this.log('Socket.IO namespace rejected the token');
        return { found, seenEvents };
      }
      extract(r.text);

      const userId = this._userIdFromToken();
      if (userId) {
        await post(`42["subscribe","","${userId}"]`);
        r = await poll();
        extract(r.text);
      } else {
        this.log('Could not read user id from token; adapter_update events may not arrive');
      }

      await post([...need].map((s) => `42["subscribe","${s}"]`).join('\x1e'));
      r = await poll();
      extract(r.text);

      await post([...need].map((s) => `42["force_adapter_request","${s}","adapterStatus"]`).join('\x1e'));
      await post(['42["device_status_v2",""]', ...[...need].map((s) => `42["device_status_v2","${s}"]`)].join('\x1e'));

      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline && !done()) {
        try {
          r = await poll(Math.min(25000, deadline - Date.now() + 1000));
        } catch (e) {
          if (e.code === 'ETIMEDOUT') continue;
          break;
        }
        if (r.status !== 200) break;
        extract(r.text);
        if (r.text.split('\x1e').includes('2')) await post('3').catch(() => {});
      }
    } catch (err) {
      this.log(`Socket.IO error: ${err.message}`);
    }
    this.log(`Socket.IO: password for ${Object.values(found).filter((f) => f.password).length}/${need.size} unit(s)`);
    return { found, seenEvents };
  }

  /**
   * Returns [{ serial, label, mac, password, cryptoSerial, address, complete }]
   */
  async discoverUnits({ debug = false, socket = true } = {}) {
    const dbg = {};
    if (!this.accessToken) await this.login();
    const units = {};
    const sites = (await this._get('/v3/sites/')) || [];
    for (const site of Array.isArray(sites) ? sites : []) {
      if (!site.id) continue;
      const zones = (await this._get(`/v3/sites/${site.id}/zones`)) || [];
      for (const zone of Array.isArray(zones) ? zones : []) {
        const adapter = zone.adapter || {};
        if (!adapter.deviceSerial || adapter.isHeadless) continue;
        units[adapter.deviceSerial] = {
          serial: adapter.deviceSerial,
          label: zone.name || adapter.deviceSerial,
          mac: '',
          password: '',
          cryptoSerial: '',
          address: '',
        };
      }
    }

    dbg.zones = Object.values(units).map((u) => ({ serial: u.serial, label: u.label }));

    for (const unit of Object.values(units)) {
      try {
        const status = await this._get(`/v3/devices/${unit.serial}/status`);
        dbg[`v3 status ${unit.serial}`] = shape(status);
        if (status && status.cryptoSerial) unit.cryptoSerial = status.cryptoSerial;
        if (status && status.mac) unit.mac = status.mac;
        if (status && status.password) unit.password = status.password;
      } catch (err) {
        this.log(`V3 status fetch failed for ${unit.serial}: ${err.message}`);
      }
    }
    const report = (step) => {
      for (const u of Object.values(units)) {
        this.log(`after ${step}: ${u.serial} password=${u.password ? 'yes' : 'no'} cryptoSerial=${u.cryptoSerial ? 'yes' : 'no'}`);
      }
    };
    report('V3 status');

    const missing = () => Object.values(units).filter((u) => !(u.password && u.cryptoSerial));
    if (missing().length || Object.keys(units).length === 0) {
      const v2 = await this._v2Credentials();
      dbg.v2 = this._v2Raw === undefined ? '(no response)' : shape(this._v2Raw);
      this.log(`V2 login returned ${Object.keys(v2).length} unit(s): ${Object.keys(v2).join(', ') || '-'}`);
      for (const [serial, c] of Object.entries(v2)) {
        if (!units[serial]) units[serial] = { serial, label: c.label || serial, mac: '', password: '', cryptoSerial: '', address: '' };
        const u = units[serial];
        for (const k of ['password', 'cryptoSerial', 'mac', 'address']) if (!u[k] && c[k]) u[k] = c[k];
      }
      report('V2 login');
    }

    if (socket && missing().length) {
      this.log('Trying Socket.IO adapter_update (can take up to ~45 s)…');
      const { found, seenEvents } = await this.socketCredentials(missing().map((u) => u.serial));
      dbg.socketEvents = Object.fromEntries(Object.entries(seenEvents).map(([k, v]) => [k, [...v]]));
      for (const [serial, c] of Object.entries(found)) {
        const u = units[serial];
        if (!u.password && c.password) u.password = c.password;
        if (!u.cryptoSerial && c.cryptoSerial) u.cryptoSerial = c.cryptoSerial;
      }
      report('Socket.IO');
    }

    if (debug) this.debugInfo = dbg;
    return Object.values(units).map((u) => ({ ...u, complete: Boolean(u.password && u.cryptoSerial) }));
  }
}

// ── Local unit ────────────────────────────────────────────────────────────

class KumoUnit {
  /**
   * @param {object} o
   * @param {string} o.address  LAN IP of the Wi-Fi adapter
   * @param {string} o.password base64 password from the cloud
   * @param {string} o.cryptoSerial hex cryptoSerial from the cloud
   */
  constructor({ address, password, cryptoSerial, log = () => {} }) {
    this.address = address;
    this.log = log;
    this._password = Buffer.from(password || '', 'base64');
    this._cryptoSerial = Buffer.from(cryptoSerial || '', 'hex');
    // The adapters have a tiny connection table: no keep-alive, one request at a time.
    this._agent = new http.Agent({ keepAlive: false, maxSockets: 1 });
    this._queue = Promise.resolve();
    this.profile = null;
    this._hasMhk2 = true;
  }

  validate() {
    if (!this.address) throw new KumoError('No IP address set');
    if (!this._password.length) throw new KumoError('Missing device password');
    if (this._cryptoSerial.length < CRYPTO_SERIAL_MIN_BYTES) throw new KumoError('Missing or invalid cryptoSerial');
  }

  /** Signed PUT to the adapter; serialized so polls and commands never overlap. */
  request(payload) {
    const run = () => this._requestNow(payload);
    const p = this._queue.then(run, run);
    this._queue = p.catch(() => {});
    return p;
  }

  async _requestNow(payload) {
    this.validate();
    const body = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
    const token = computeToken(this._password, this._cryptoSerial, body);
    const url = `http://${this.address}/api?m=${token}`;
    const opts = {
      method: 'PUT',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'Content-Length': body.length,
      },
      body,
      timeout: LOCAL_TIMEOUT_MS,
      agent: this._agent,
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await httpRequest(url, opts);
        const data = parseJson(res.body);
        if (data && typeof data === 'object' && !Array.isArray(data)) return data;
        return {};
      } catch (err) {
        // Only retry a connection dropped mid-flight (commands are absolute, so idempotent).
        if (attempt === 0 && (err.code === 'ECONNRESET' || err.code === 'EPIPE')) continue;
        if (err instanceof SyntaxError) throw new KumoConnectionError(`Unit returned invalid JSON — check credentials (${err.message})`);
        throw new KumoConnectionError(`Cannot reach unit at ${this.address}: ${err.code || err.message}`);
      }
    }
    throw new KumoConnectionError(`Cannot reach unit at ${this.address}`);
  }

  async _query(path) {
    // path like ['indoorUnit','status']
    let q = {};
    const root = { c: q };
    for (const key of path) {
      q[key] = {};
      q = q[key];
    }
    const res = await this.request(root);
    let r = res && res.r;
    for (const k of path) r = r && r[k];
    return r;
  }

  async getProfile(force = false) {
    if (this.profile && !force) return this.profile;
    const profile = await this._query(['indoorUnit', 'profile']);
    if (!profile || typeof profile !== 'object') throw new KumoConnectionError('Failed to read unit profile (bad credentials?)');
    const adapter = (await this._query(['adapter', 'status'])) || {};
    const p = { ...profile };
    const minSp = p.minimumSetPoints || {};
    const maxSp = p.maximumSetPoints || {};
    p.hasModeAuto = !adapter.autoModePrevention || 'auto' in minSp || 'auto' in maxSp;
    if (adapter.userHasModeDry === false) p.hasModeDry = false;
    if (adapter.userHasModeHeat === false) p.hasModeHeat = false;
    this.profile = p;
    return p;
  }

  supportedModes() {
    const p = this.profile || {};
    const modes = ['off', 'cool'];
    if (p.hasModeHeat) modes.push('heat');
    if (p.hasModeDry) modes.push('dry');
    if (p.hasModeVent) modes.push('vent');
    if (p.hasModeAuto) modes.push('auto');
    return modes;
  }

  supportedFanSpeeds() {
    const p = this.profile || {};
    const speeds = [...(FAN_SPEEDS_BY_COUNT[p.numberOfFanSpeeds] || FAN_SPEEDS_BY_COUNT[5])];
    if (p.hasFanSpeedAuto) speeds.push('auto');
    return speeds;
  }

  supportedVaneDirections() {
    const p = this.profile || {};
    if (!p.hasVaneDir) return [];
    const dirs = [...VANE_DIRECTIONS];
    if (p.hasVaneSwing) dirs.push('swing');
    return dirs;
  }

  /** Full status snapshot (one serialized burst). */
  async getStatus() {
    const raw = await this._query(['indoorUnit', 'status']);
    if (!raw || typeof raw !== 'object') throw new KumoConnectionError('Failed to read unit status (bad credentials?)');
    if (!this.profile) await this.getProfile();

    let humidity = null;
    let sensorBattery = null;
    for (let i = 0; i < 4; i++) {
      const res = await this.request(`{"c":{"sensors":{"${i}":{}}}}`);
      const s = res && res.r && res.r.sensors && res.r.sensors[String(i)];
      if (!s || typeof s !== 'object' || !s.uuid) break;
      if (humidity === null && s.humidity != null) humidity = s.humidity;
      if (sensorBattery === null && s.battery != null) sensorBattery = s.battery;
    }
    if (humidity === null && this._hasMhk2) {
      const mhk2 = await this._query(['mhk2', 'status']).catch(() => null);
      if (mhk2 && mhk2.indoorHumid != null) humidity = mhk2.indoorHumid;
      else this._hasMhk2 = false;
    }

    const adapter = (await this._query(['adapter', 'status']).catch(() => null)) || {};
    const rssi = adapter.localNetwork && adapter.localNetwork.stationMode && adapter.localNetwork.stationMode.RSSI;

    return {
      mode: raw.mode,
      standby: raw.standby,
      spHeat: raw.spHeat,
      spCool: raw.spCool,
      roomTemp: raw.roomTemp,
      fanSpeed: raw.fanSpeed,
      vaneDir: raw.vaneDir,
      filterDirty: raw.filterDirty,
      defrost: raw.defrost,
      humidity,
      sensorBattery,
      wifiRssi: rssi != null ? rssi : null,
      runState: adapter.runState || null,
      raw,
    };
  }

  async getAdapterInfo() {
    return (await this._query(['adapter', 'info'])) || {};
  }

  /** Send one or more indoorUnit.status fields, e.g. { mode: 'heat', spHeat: 21.5 } */
  async setStatus(fields) {
    const res = await this.request({ c: { indoorUnit: { status: fields } } });
    if (!res || !('r' in res)) throw new KumoError(`Unit rejected command ${JSON.stringify(fields)}`);
    return res;
  }

  async setMode(mode) {
    if (!MODES.includes(mode)) throw new KumoError(`Unknown mode ${mode}`);
    if (this.profile && !this.supportedModes().includes(mode)) throw new KumoError(`This unit does not support ${mode} mode`);
    return this.setStatus({ mode });
  }

  _checkSetpoint(kind, c) {
    if (!Number.isFinite(c)) throw new KumoError('Setpoint must be a number');
    const p = this.profile || {};
    const lows = [p.minimumSetPoints && p.minimumSetPoints[kind], p.minimumSetPoints && p.minimumSetPoints.auto].filter((x) => x != null).map(Number);
    const highs = [p.maximumSetPoints && p.maximumSetPoints[kind], p.maximumSetPoints && p.maximumSetPoints.auto].filter((x) => x != null).map(Number);
    if (lows.length && c < Math.min(...lows)) throw new KumoError(`${kind} setpoint ${c}°C below unit minimum ${Math.min(...lows)}°C`);
    if (highs.length && c > Math.max(...highs)) throw new KumoError(`${kind} setpoint ${c}°C above unit maximum ${Math.max(...highs)}°C`);
    return Math.round(c * 10) / 10;
  }

  async setHeatSetpoint(c) {
    return this.setStatus({ spHeat: this._checkSetpoint('heat', c) });
  }

  async setCoolSetpoint(c) {
    return this.setStatus({ spCool: this._checkSetpoint('cool', c) });
  }

  async setFanSpeed(speed) {
    if (this.profile && !this.supportedFanSpeeds().includes(speed)) {
      throw new KumoError(`Fan speed ${speed} not supported (unit supports: ${this.supportedFanSpeeds().join(', ')})`);
    }
    return this.setStatus({ fanSpeed: speed });
  }

  async setVaneDirection(dir) {
    const supported = this.supportedVaneDirections();
    if (this.profile && !supported.includes(dir)) {
      throw new KumoError(supported.length ? `Vane ${dir} not supported (unit supports: ${supported.join(', ')})` : 'This unit does not report vane control');
    }
    return this.setStatus({ vaneDir: dir });
  }
}


// ── Live cloud updates (Socket.IO / Engine.IO v4 long-polling) ────────────

/**
 * One long-lived connection per Comfort account. Emits:
 *   'device_update' (serial, data)  — partial state pushed by the cloud
 *   'connected' / 'disconnected'
 * Reconnects with exponential backoff; refreshes the token when the namespace is rejected.
 */
class KumoCloudStream extends EventEmitter {
  constructor(cloud, { socketUrl = V3_SOCKET_URL, log = () => {} } = {}) {
    super();
    this.setMaxListeners(50);
    this.cloud = cloud;
    this.socketUrl = socketUrl;
    this.log = log;
    this.serials = new Set();
    this.connected = false;
    this._running = false;
    this._cookies = {};
    this._url = null;
    this._backoff = 5000;
  }

  addSerial(serial) {
    if (this.serials.has(serial)) return;
    this.serials.add(serial);
    if (this.connected) this._post(`42["subscribe","${serial}"]`).catch(() => {});
    this.start();
  }

  removeSerial(serial) {
    this.serials.delete(serial);
    if (!this.serials.size) this.stop();
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._loop().catch((e) => this.log(`stream loop ended: ${e.message}`));
  }

  stop() {
    this._running = false;
    if (this._req) this._req.destroy();
    this._setConnected(false);
  }

  _setConnected(v) {
    if (this.connected === v) return;
    this.connected = v;
    this.emit(v ? 'connected' : 'disconnected');
  }

  async _loop() {
    while (this._running) {
      const started = Date.now();
      try {
        await this._session();
      } catch (err) {
        if (this._running) this.log(`live updates disconnected: ${err.message}`);
      }
      this._setConnected(false);
      if (!this._running) break;
      if (Date.now() - started > 120000) this._backoff = 5000;
      const wait = this._backoff;
      this._backoff = Math.min(this._backoff * 2, 300000);
      await new Promise((r) => { this._sleepTimer = setTimeout(r, wait); });
    }
  }

  _http(method, body, timeout) {
    const headers = { Authorization: `Bearer ${this.cloud.accessToken}`, Accept: '*/*' };
    if (body != null) headers['Content-Type'] = 'text/plain;charset=UTF-8';
    const cookie = Object.entries(this._cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.Cookie = cookie;
    const url = `${this._url}&t=${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    return httpRequest(url, { method, headers, body, timeout }).then((res) => {
      for (const sc of [].concat(res.headers['set-cookie'] || [])) {
        const [kv] = sc.split(';');
        const i = kv.indexOf('=');
        if (i > 0) this._cookies[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
      }
      return { status: res.status, text: res.body.toString('utf8') };
    });
  }

  async _post(data) {
    const r = await this._http('POST', data, 10000);
    if (r.status !== 200) throw new Error(`POST HTTP ${r.status}`);
  }

  async _session() {
    if (!this.cloud.accessToken) await this.cloud.login();
    this._cookies = {};
    this._url = `${this.socketUrl}/socket.io/?EIO=4&transport=polling`;
    const hs = await this._http('GET', null, 15000);
    if (hs.status === 401 || hs.status === 403) {
      await this._renewToken();
      throw new Error(`handshake rejected (HTTP ${hs.status}); token renewed`);
    }
    if (hs.status !== 200 || !hs.text.startsWith('0')) throw new Error(`handshake HTTP ${hs.status}`);
    const open = JSON.parse(hs.text.slice(1));
    const pollTimeout = (open.pingInterval || 25000) + (open.pingTimeout || 20000) + 5000;
    this._url += `&sid=${encodeURIComponent(open.sid)}`;

    await this._post('40');
    const userId = this.cloud._userIdFromToken();
    let subscribed = false;

    while (this._running) {
      const r = await this._http('GET', null, pollTimeout);
      if (r.status !== 200) throw new Error(`poll HTTP ${r.status}`);
      for (let pkt of r.text.split('\x1e')) {
        const colon = pkt.indexOf(':');
        if (colon > 0 && /^\d+$/.test(pkt.slice(0, colon))) pkt = pkt.slice(colon + 1);
        if (pkt === '2') { await this._post('3'); continue; }
        if (pkt === '1') throw new Error('server closed the session');
        if (pkt.startsWith('44')) {
          await this._renewToken();
          throw new Error('namespace rejected the token; token renewed');
        }
        if (pkt.startsWith('41')) throw new Error('namespace disconnected');
        if (pkt.startsWith('40') && !subscribed) {
          subscribed = true;
          const msgs = [];
          if (userId) msgs.push(`42["subscribe","","${userId}"]`);
          for (const s of this.serials) msgs.push(`42["subscribe","${s}"]`);
          if (msgs.length) await this._post(msgs.join('\x1e'));
          this._setConnected(true);
          this.log(`live updates connected (${this.serials.size} unit(s))`);
          continue;
        }
        if (pkt.startsWith('42')) {
          let payload;
          try { payload = JSON.parse(pkt.slice(2)); } catch (e) { continue; }
          if (!Array.isArray(payload)) continue;
          const [event, data] = payload;
          if (event === 'device_update' && data && typeof data === 'object') {
            const serial = data.deviceSerial || data.serial;
            if (serial) this.emit('device_update', serial, data);
          }
        }
      }
    }
  }

  async _renewToken() {
    try {
      await this.cloud.refresh();
    } catch (e) {
      await this.cloud.login();
    }
  }
}

// ── Cloud-controlled unit (same interface as KumoUnit) ────────────────────

const TO_CLOUD_FIELD = { mode: 'operationMode', vaneDir: 'airDirection' };

class KumoCloudUnit extends KumoUnit {
  constructor({ cloud, serial, log = () => {} }) {
    super({ address: 'cloud', password: '', cryptoSerial: '', log });
    this.cloud = cloud;
    this.serial = serial;
    this.isCloud = true;
    this._polls = 0;
  }

  validate() {
    if (!this.cloud) throw new KumoError('No cloud account');
  }

  async getProfile(force = false) {
    if (this.profile && !force) return this.profile;
    const p = { ...(await this.cloud.getDeviceProfile(this.serial)) };
    p.hasModeVent = p.hasModeVent != null ? p.hasModeVent : Boolean(p.hasModeFan);
    this.profile = p;
    return p;
  }

  supportedModes() {
    const p = this.profile || {};
    const max = p.maximumSetPoints || {};
    const modes = ['off'];
    for (const [mode, flag] of [['cool', 'hasModeCool'], ['heat', 'hasModeHeat'], ['dry', 'hasModeDry'], ['vent', 'hasModeVent'], ['auto', 'hasModeAuto']]) {
      if (p[flag] || mode in max) modes.push(mode);
    }
    return modes;
  }

  supportedFanSpeeds() {
    const p = this.profile || {};
    if (!p.numberOfFanSpeeds) return ['auto', 'superQuiet', 'quiet', 'low', 'powerful', 'superPowerful'];
    return super.supportedFanSpeeds();
  }

  async getStatus() {
    if (!this.profile || this._polls >= 60) {
      await this.getProfile(true);
      this._polls = 0;
    }
    this._polls += 1;
    const raw = await this.cloud.getDeviceDetails(this.serial);
    if (raw.connected === false || raw.connected === 0) throw new KumoConnectionError('Unit is offline in the Mitsubishi cloud');
    this._raw = { ...raw };
    return KumoCloudUnit.statusFromRaw(this._raw);
  }

  /** Merge a pushed device_update into the last known state; returns the new status (or null before the first poll). */
  applyUpdate(data) {
    if (!this._raw) return null;
    Object.assign(this._raw, data);
    return KumoCloudUnit.statusFromRaw(this._raw);
  }

  static statusFromRaw(raw) {
    const num = (x) => (x == null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));
    return {
      mode: raw.power === 0 ? 'off' : raw.operationMode,
      standby: null,
      spHeat: num(raw.spHeat),
      spCool: num(raw.spCool),
      roomTemp: num(raw.roomTemp),
      fanSpeed: raw.fanSpeed,
      vaneDir: raw.airDirection,
      filterDirty: raw.filterDirty != null ? Boolean(raw.filterDirty) : null,
      defrost: raw.defrost != null ? Boolean(raw.defrost) : null,
      humidity: num(raw.humidity),
      sensorBattery: null,
      wifiRssi: num(raw.rssi),
      runState: null,
      raw,
    };
  }

  async getAdapterInfo() {
    const s = await this.cloud._get(`/v3/devices/${this.serial}/status`).catch(() => null);
    return s || {};
  }

  async setStatus(fields) {
    const commands = {};
    for (const [k, v] of Object.entries(fields)) {
      // The V3 cloud only accepts 0.5 °C setpoint increments.
      commands[TO_CLOUD_FIELD[k] || k] = (k === 'spHeat' || k === 'spCool') ? Math.round(v * 2) / 2 : v;
    }
    return this.cloud.sendCommand(this.serial, commands);
  }
}

module.exports = {
  KumoCloudUnit,
  KumoCloudStream,
  computeToken,
  fahrenheitToSetpoint,
  setpointToFahrenheit,
  KumoCloud,
  KumoUnit,
  KumoError,
  KumoAuthError,
  KumoConnectionError,
  MODES,
  VANE_DIRECTIONS,
};
