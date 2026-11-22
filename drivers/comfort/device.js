'use strict';

const Homey = require('homey');
const { KumoUnit, KumoCloudUnit, fahrenheitToSetpoint, setpointToFahrenheit } = require('../../lib/kumo');

const THERMOSTAT_MODES = ['off', 'heat', 'cool', 'auto'];
const MAX_FAILURES_BEFORE_UNAVAILABLE = 3;
const POST_COMMAND_POLL_MS = 2500;
const POST_COMMAND_POLL_CLOUD_MS = 8000;
const MIN_CLOUD_POLL_S = 60;
const STREAM_SAFETY_POLL_MS = 5 * 60 * 1000; // full poll at least this often while live updates are flowing

const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

class ComfortDevice extends Homey.Device {
  async onInit() {
    this._failures = 0;
    this._status = null;
    this._buildUnit();

    this.registerCapabilityListener('onoff', (v) => this.applyOnOff(v));
    this.registerCapabilityListener('thermostat_mode', (v) => this.applyMode(v));
    this.registerCapabilityListener('comfort_mode', (v) => this.applyMode(v));
    this.registerCapabilityListener('target_temperature', (v) => this._setTargetFromHomey(v));
    this.registerCapabilityListener('comfort_fan_speed', (v) => this.applyFanSpeed(v));
    if (this.hasCapability('comfort_vane')) this.registerCapabilityListener('comfort_vane', (v) => this.applyVane(v));
    if (this.hasCapability('target_temperature.heat')) {
      this.registerCapabilityListener('target_temperature.heat', (v) => this._setAutoFromHomey({ heat: v }));
      this.registerCapabilityListener('target_temperature.cool', (v) => this._setAutoFromHomey({ cool: v }));
    }

    try {
      this.log(`Homey units: ${this.homey.i18n.getUnits()} · setpoint rounding: ${this.getSetting('temp_units')}`);
    } catch (e) {
      this.log('Homey units: unavailable');
    }
    this._startPolling();
    this.poll().catch(() => {});
  }

  onDeleted() {
    this._stopPolling();
    this._detachStream();
  }

  onUninit() {
    this._stopPolling();
    this._detachStream();
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('address') && !this._isCloud()) {
      this.unit.address = String(newSettings.address || '').trim();
      this.unit.profile = null;
    }
    if (changedKeys.includes('poll_interval')) this._startPolling(newSettings.poll_interval);
    if (changedKeys.includes('address') || changedKeys.includes('temp_units')) {
      this.homey.setTimeout(() => this.poll().catch(() => {}), 500);
    }
  }

  async switchToCloud({ username, password }) {
    await this.setStoreValue('connection', 'cloud');
    await this.setStoreValue('username', username);
    await this.setStoreValue('password', password);
    await this.setStoreValue('cryptoSerial', null);
    await this.setSettings({ connection: 'Mitsubishi cloud' });
    this._buildUnit();
    this._startPolling();
    await this.poll();
  }

  async updateCredentials({ password, cryptoSerial, address }) {
    await this.setStoreValue('connection', 'local');
    await this.setStoreValue('username', null);
    await this.setStoreValue('password', password);
    await this.setStoreValue('cryptoSerial', cryptoSerial);
    await this.setSettings({ connection: 'Local (LAN)', ...(address ? { address } : {}) });
    this._buildUnit();
    this._startPolling();
    await this.poll();
  }

  // ── Plumbing ────────────────────────────────────────────────────────────

  _isCloud() {
    return this.getStoreValue('connection') === 'cloud';
  }

  _buildUnit() {
    if (this._isCloud()) {
      const cloud = this.homey.app.getCloud(this.getStoreValue('username'), this.getStoreValue('password'));
      this.unit = new KumoCloudUnit({ cloud, serial: this.getData().id, log: (...a) => this.log(...a) });
      this._attachStream(cloud);
      return;
    }
    this._detachStream();
    this.unit = new KumoUnit({
      address: String(this.getSetting('address') || '').trim(),
      password: this.getStoreValue('password'),
      cryptoSerial: this.getStoreValue('cryptoSerial'),
      log: (...a) => this.log(...a),
    });
  }

  _attachStream(cloud) {
    this._detachStream();
    const stream = cloud.getStream();
    const serial = this.getData().id;
    this._onStreamUpdate = (s, data) => {
      if (s !== serial || !(this.unit instanceof KumoCloudUnit)) return;
      const status = this.unit.applyUpdate(data);
      if (status) this._applyStatus(status).catch((e) => this.error('live update:', e.message));
    };
    this._onStreamConnected = () => this.poll(true).catch(() => {});
    stream.on('device_update', this._onStreamUpdate);
    stream.on('connected', this._onStreamConnected);
    stream.addSerial(serial);
    this._stream = stream;
  }

  _detachStream() {
    if (!this._stream) return;
    this._stream.off('device_update', this._onStreamUpdate);
    this._stream.off('connected', this._onStreamConnected);
    this._stream.removeSerial(this.getData().id);
    this._stream = null;
  }

  _startPolling(seconds) {
    this._stopPolling();
    const s = Math.max(this._isCloud() ? MIN_CLOUD_POLL_S : 15, Number(seconds || this.getSetting('poll_interval') || 60));
    this._pollTimer = this.homey.setInterval(() => this.poll().catch(() => {}), s * 1000);
  }

  _stopPolling() {
    if (this._pollTimer) this.homey.clearInterval(this._pollTimer);
    this._pollTimer = null;
    if (this._kickTimer) this.homey.clearTimeout(this._kickTimer);
    this._kickTimer = null;
  }

  _kickPoll() {
    if (this._kickTimer) this.homey.clearTimeout(this._kickTimer);
    const ms = this._isCloud() ? POST_COMMAND_POLL_CLOUD_MS : POST_COMMAND_POLL_MS;
    this._kickTimer = this.homey.setTimeout(() => {
      this.poll(true).catch(() => {});
      // The cloud can lag the adapter; confirm once more unless live updates are flowing.
      if (this._isCloud() && !(this._stream && this._stream.connected)) {
        this._kickTimer = this.homey.setTimeout(() => this.poll(true).catch(() => {}), 15000);
      }
    }, ms);
  }

  _fahrenheit() {
    const pref = this.getSetting('temp_units') || 'auto';
    if (pref === 'fahrenheit') return true;
    if (pref === 'celsius') return false;
    try {
      return this.homey.i18n.getUnits() === 'imperial';
    } catch (e) {
      return false;
    }
  }

  /** Device °C setpoint → value Homey should show (°C), so °F users see the Comfort app's number. */
  _toHomey(c) {
    if (c == null || !Number.isFinite(Number(c))) return null;
    if (!this._fahrenheit()) return Number(c);
    return round((setpointToFahrenheit(Number(c)) - 32) / 1.8);
  }

  /** Homey °C value → device °C setpoint. */
  _fromHomey(c) {
    if (this._fahrenheit()) return fahrenheitToSetpoint(c * 1.8 + 32);
    return Math.round(c * 2) / 2;
  }

  /** A Flow-card number in the user's units → device °C setpoint. */
  _fromUserUnits(x) {
    if (this._fahrenheit()) return fahrenheitToSetpoint(x);
    return Math.round(x * 2) / 2;
  }

  async _set(cap, value) {
    if (!this.hasCapability(cap)) return;
    if (value === undefined) return;
    if (this.getCapabilityValue(cap) === value) return;
    await this.setCapabilityValue(cap, value).catch((e) => this.error(`set ${cap}:`, e.message));
  }

  async _ensureCapability(cap, wanted) {
    if (wanted && !this.hasCapability(cap)) {
      await this.addCapability(cap).catch((e) => this.error(e));
      if (cap === 'comfort_vane') this.registerCapabilityListener('comfort_vane', (v) => this.applyVane(v));
      if (cap === 'target_temperature.heat') this.registerCapabilityListener(cap, (v) => this._setAutoFromHomey({ heat: v }));
      if (cap === 'target_temperature.cool') this.registerCapabilityListener(cap, (v) => this._setAutoFromHomey({ cool: v }));
    } else if (!wanted && this.hasCapability(cap)) {
      await this.removeCapability(cap).catch((e) => this.error(e));
    }
  }

  // ── Polling ─────────────────────────────────────────────────────────────

  async poll(force = false) {
    if (this._polling) return this._polling;
    // With live updates connected, the interval poll is only a periodic safety net.
    if (!force && this._stream && this._stream.connected && this._lastPoll
        && Date.now() - this._lastPoll < STREAM_SAFETY_POLL_MS) return undefined;
    this._polling = this._doPoll().finally(() => { this._polling = null; });
    return this._polling;
  }

  async _doPoll() {
    if (!this._isCloud() && !this.unit.address) {
      await this.setUnavailable('Set the adapter IP address in device settings').catch(() => {});
      return;
    }
    let s;
    try {
      const firstProfile = !this.unit.profile;
      s = await this.unit.getStatus();
      if (firstProfile) await this._onProfile();
    } catch (err) {
      this._failures += 1;
      this.error(`poll failed (${this._failures}):`, err.message);
      if (this._failures >= MAX_FAILURES_BEFORE_UNAVAILABLE) {
        await this.setUnavailable(err.message).catch(() => {});
      }
      throw err;
    }
    this._failures = 0;
    this._lastPoll = Date.now();
    if (!this.getAvailable()) await this.setAvailable().catch(() => {});
    await this._applyStatus(s);
  }

  async _onProfile() {
    const u = this.unit;
    this.log('profile:', JSON.stringify({
      modes: u.supportedModes(), fan: u.supportedFanSpeeds(), vane: u.supportedVaneDirections(),
      min: u.profile.minimumSetPoints, max: u.profile.maximumSetPoints,
    }));
    await this._ensureCapability('comfort_vane', u.supportedVaneDirections().length > 0);
    const auto = u.supportedModes().includes('auto');
    await this._ensureCapability('target_temperature.heat', auto);
    await this._ensureCapability('target_temperature.cool', auto);
    try {
      const info = await u.getAdapterInfo();
      const extra = {};
      if (info.firmwareVersion) extra.firmware = String(info.firmwareVersion);
      if (info.mac) extra.mac = String(info.mac);
      if (Object.keys(extra).length) await this.setSettings(extra);
    } catch (e) { /* optional */ }
    if (this._isCloud()) {
      // Log every profile flag the cloud reports (looking for e.g. sleep/econo features).
      this.log('cloud profile keys:', Object.keys(u.profile || {}).join(', '));
    }
  }

  async _applyStatus(s) {
    const prev = this._status;
    this._status = s;
    const mode = s.mode;

    if (mode && mode !== 'off') await this.setStoreValue('lastActiveMode', mode);

    await this._set('onoff', mode !== 'off');
    await this._set('comfort_mode', mode);
    // thermostat_mode only knows off/heat/cool/auto; leave it alone in dry/fan.
    if (THERMOSTAT_MODES.includes(mode)) await this._set('thermostat_mode', mode);

    await this._set('measure_temperature', s.roomTemp != null ? Number(s.roomTemp) : null);
    await this._set('target_temperature', this._displayTarget(s));
    await this._set('target_temperature.heat', this._toHomey(s.spHeat));
    await this._set('target_temperature.cool', this._toHomey(s.spCool));
    if (s.fanSpeed) await this._set('comfort_fan_speed', s.fanSpeed);
    if (s.vaneDir) await this._set('comfort_vane', s.vaneDir);
    await this._set('alarm_generic', Boolean(s.filterDirty));
    if (s.wifiRssi != null) await this._set('comfort_rssi', Number(s.wifiRssi));

    if (s.humidity != null) {
      await this._ensureCapability('measure_humidity', true);
      await this._set('measure_humidity', Number(s.humidity));
    }

    if (prev) {
      if (prev.mode !== mode) {
        this.driver.modeChangedTrigger.trigger(this, { mode: String(mode) }).catch(this.error);
      }
      if (prev.fanSpeed !== s.fanSpeed && s.fanSpeed) {
        this.driver.fanChangedTrigger.trigger(this, { fan_speed: String(s.fanSpeed) }).catch(this.error);
      }
    }
  }

  _effectiveMode(s = this._status) {
    const mode = s && s.mode;
    if (mode && mode !== 'off' && mode !== 'vent') return mode;
    const last = this.getStoreValue('lastActiveMode');
    return last && last !== 'vent' ? last : 'heat';
  }

  _displayTarget(s) {
    const mode = this._effectiveMode(s);
    if (mode === 'heat') return this._toHomey(s.spHeat);
    if (mode === 'cool' || mode === 'dry') return this._toHomey(s.spCool);
    if (mode === 'auto' && s.spHeat != null && s.spCool != null) {
      return round((this._toHomey(s.spHeat) + this._toHomey(s.spCool)) / 2);
    }
    return this._toHomey(s.spHeat != null ? s.spHeat : s.spCool);
  }

  // ── Commands (used by capability listeners and Flow cards) ─────────────

  async _command(fn) {
    if (!this.unit.profile) await this.unit.getProfile();
    await fn();
    this._kickPoll();
  }

  async applyOnOff(on) {
    if (!on) return this.applyMode('off');
    const last = this.getStoreValue('lastActiveMode') || 'heat';
    return this.applyMode(last);
  }

  async applyMode(mode) {
    await this._command(() => this.unit.setMode(mode));
    // Optimistic UI update; the follow-up poll confirms.
    await this._set('comfort_mode', mode);
    await this._set('onoff', mode !== 'off');
    if (THERMOSTAT_MODES.includes(mode)) await this._set('thermostat_mode', mode);
    if (mode !== 'off') await this.setStoreValue('lastActiveMode', mode);
  }

  async applyFanSpeed(speed) {
    await this._command(() => this.unit.setFanSpeed(speed));
    await this._set('comfort_fan_speed', speed);
  }

  async applyVane(dir) {
    await this._command(() => this.unit.setVaneDirection(dir));
    await this._set('comfort_vane', dir);
  }

  async _setTargetFromHomey(value) {
    const s = this._status || {};
    const mode = this._effectiveMode();
    if (mode === 'heat') return this._command(() => this.unit.setHeatSetpoint(this._fromHomey(value)));
    if (mode === 'cool' || mode === 'dry') return this._command(() => this.unit.setCoolSetpoint(this._fromHomey(value)));
    // auto: shift both setpoints, keeping the gap between them.
    const heatShown = this._toHomey(s.spHeat);
    const coolShown = this._toHomey(s.spCool);
    if (heatShown == null || coolShown == null) {
      return this._command(() => this.unit.setHeatSetpoint(this._fromHomey(value)));
    }
    const delta = value - (heatShown + coolShown) / 2;
    const spHeat = this._fromHomey(heatShown + delta);
    const spCool = this._fromHomey(coolShown + delta);
    return this._command(() => this.unit.setStatus({ spHeat, spCool }));
  }

  async _setAutoFromHomey({ heat, cool }) {
    const fields = {};
    if (heat != null) fields.spHeat = this.unit._checkSetpoint('heat', this._fromHomey(heat));
    if (cool != null) fields.spCool = this.unit._checkSetpoint('cool', this._fromHomey(cool));
    return this._command(() => this.unit.setStatus(fields));
  }

  async applyModeAndTemperature(mode, temperature) {
    const sp = this._fromUserUnits(temperature);
    const fields = { mode };
    if (mode === 'heat') fields.spHeat = this.unit._checkSetpoint('heat', sp);
    else fields.spCool = this.unit._checkSetpoint('cool', sp);
    await this._command(() => this.unit.setStatus(fields));
    await this.setStoreValue('lastActiveMode', mode);
  }

  async applyAutoSetpoints(heat, cool) {
    const spHeat = this._fromUserUnits(heat);
    const spCool = this._fromUserUnits(cool);
    if (spHeat > spCool) throw new Error('Heat setpoint must be at or below the cool setpoint');
    return this._command(() => this.unit.setStatus({
      spHeat: this.unit._checkSetpoint('heat', spHeat),
      spCool: this.unit._checkSetpoint('cool', spCool),
    }));
  }
}

module.exports = ComfortDevice;
