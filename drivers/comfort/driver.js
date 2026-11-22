'use strict';

const Homey = require('homey');
const { KumoUnit, KumoCloudUnit } = require('../../lib/kumo');

const RUNNING_MODES = ['heat', 'cool', 'auto', 'dry'];

class ComfortDriver extends Homey.Driver {
  async onInit() {
    const card = (id) => this.homey.flow.getActionCard(id);

    card('set_mode').registerRunListener(({ device, mode }) => device.applyMode(mode));
    card('set_fan_speed').registerRunListener(({ device, fan_speed }) => device.applyFanSpeed(fan_speed));
    card('set_vane').registerRunListener(({ device, vane }) => device.applyVane(vane));
    card('set_mode_and_temperature').registerRunListener(({ device, mode, temperature }) => device.applyModeAndTemperature(mode, temperature));
    card('set_auto_setpoints').registerRunListener(({ device, heat, cool }) => device.applyAutoSetpoints(heat, cool));

    this.homey.flow.getConditionCard('mode_is')
      .registerRunListener(({ device, mode }) => device.getCapabilityValue('comfort_mode') === mode);
    this.homey.flow.getConditionCard('is_running')
      .registerRunListener(({ device }) => RUNNING_MODES.includes(device.getCapabilityValue('comfort_mode')));

    this.modeChangedTrigger = this.homey.flow.getDeviceTriggerCard('mode_changed');
    this.fanChangedTrigger = this.homey.flow.getDeviceTriggerCard('fan_speed_changed');
  }

  _registerCommonHandlers(session) {
    let units = [];
    let account = null;

    session.setHandler('login', async ({ username, password }) => {
      const cloud = this.homey.app.getCloud(username, password);
      units = await cloud.discoverUnits({ socket: false });
      account = { username, password };
      this.log(`Cloud returned ${units.length} unit(s)`);
      // Never send passwords back to the view; it references units by serial.
      return units.map((u) => ({
        serial: u.serial, label: u.label, mac: u.mac, address: u.address, complete: u.complete,
      }));
    });

    const credsFor = ({ serial, password, cryptoSerial }) => {
      if (password && cryptoSerial) return { serial, password, cryptoSerial, mac: '' };
      const u = units.find((x) => x.serial === serial);
      if (!u) throw new Error('Unknown unit — log in again');
      if (!u.complete) throw new Error('The cloud did not return local credentials for this unit');
      return u;
    };

    const accountFor = () => {
      if (!account) throw new Error('Log in with your Comfort account first');
      return account;
    };

    session.setHandler('test', async (args) => {
      let unit;
      if (args.cloud) {
        const a = accountFor();
        unit = new KumoCloudUnit({ cloud: this.homey.app.getCloud(a.username, a.password), serial: args.serial });
      } else {
        const c = credsFor(args);
        unit = new KumoUnit({ address: args.address, password: c.password, cryptoSerial: c.cryptoSerial });
      }
      const s = await unit.getStatus();
      return { mode: s.mode, roomTemp: s.roomTemp, spHeat: s.spHeat, spCool: s.spCool, fanSpeed: s.fanSpeed };
    });

    return { credsFor, accountFor, unitLabel: (serial) => (units.find((u) => u.serial === serial) || {}).label };
  }

  async onPair(session) {
    const { credsFor, accountFor, unitLabel } = this._registerCommonHandlers(session);

    session.setHandler('getMode', async () => ({ mode: 'pair' }));

    session.setHandler('build', async (args) => {
      if (args.cloud) {
        const a = accountFor();
        return {
          name: args.name || unitLabel(args.serial) || 'Mini-split',
          data: { id: args.serial },
          store: { connection: 'cloud', username: a.username, password: a.password },
          settings: { address: '', serial: args.serial, connection: 'Mitsubishi cloud' },
        };
      }
      const c = credsFor(args);
      return {
        name: args.name || c.label || 'Mini-split',
        data: { id: c.serial },
        store: { connection: 'local', password: c.password, cryptoSerial: c.cryptoSerial },
        settings: { address: args.address, serial: c.serial, mac: c.mac || '', connection: 'Local (LAN)' },
      };
    });
  }

  async onRepair(session, device) {
    const { credsFor, accountFor } = this._registerCommonHandlers(session);

    session.setHandler('getMode', async () => ({
      mode: 'repair',
      serial: device.getData().id,
      address: device.getSetting('address'),
    }));

    session.setHandler('repair', async (args) => {
      if (args.cloud) {
        const a = accountFor();
        await device.switchToCloud(a);
        return true;
      }
      const c = credsFor({ ...args, serial: args.serial || device.getData().id });
      if (c.serial !== device.getData().id) throw new Error(`That is a different unit (${c.serial}); pick ${device.getData().id}`);
      await device.updateCredentials({ password: c.password, cryptoSerial: c.cryptoSerial, address: args.address });
      return true;
    });
  }
}

module.exports = ComfortDriver;
