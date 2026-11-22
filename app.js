'use strict';

const Homey = require('homey');
const { KumoCloud } = require('./lib/kumo');

class MitsubishiComfortApp extends Homey.App {
  async onInit() {
    this._clouds = new Map();
    this.log('Mitsubishi Comfort started');
  }

  /** One shared cloud session per Comfort account, so devices share a token and stay under rate limits. */
  getCloud(username, password) {
    const key = String(username || '').toLowerCase();
    let cloud = this._clouds.get(key);
    if (!cloud || cloud.password !== password) {
      cloud = new KumoCloud(username, password, { log: (m) => this.log(`[cloud] ${m}`) });
      this._clouds.set(key, cloud);
    }
    return cloud;
  }
}

module.exports = MitsubishiComfortApp;
