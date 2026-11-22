#!/usr/bin/env node
'use strict';

/*
 * Standalone test for the Kumo client — run from a Mac/PC on the home LAN
 * before installing on Homey. No npm install needed (Node 16+).
 *
 *   # 1. Fetch local credentials from the Comfort cloud (saved to ./kumo-creds.json)
 *   node tools/kumo-test.js login you@example.com [--debug]
 *
 *   # 2. Read status from the unit (local only)
 *   node tools/kumo-test.js status 192.168.1.50
 *
 *   # 3. Send a command (local only)
 *   node tools/kumo-test.js set 192.168.1.50 mode heat
 *   node tools/kumo-test.js set 192.168.1.50 spHeat 21.5
 *   node tools/kumo-test.js set 192.168.1.50 fanSpeed quiet
 *   node tools/kumo-test.js set 192.168.1.50 vaneDir auto
 *
 *   # Dump the raw profile (shows fan/vane/mode capabilities of the cassette)
 *   node tools/kumo-test.js profile 192.168.1.50
 *
 * Cloud control (no local key needed; set KUMO_PASSWORD to skip the prompt):
 *   node tools/kumo-test.js cloud-status you@example.com
 *   node tools/kumo-test.js cloud-set you@example.com fanSpeed quiet
 *   node tools/kumo-test.js cloud-set you@example.com spHeat 21.5
 *   node tools/kumo-test.js cloud-set you@example.com mode heat
 *   node tools/kumo-test.js cloud-watch you@example.com      # live updates; change something in the Comfort app
 *
 * kumo-creds.json holds the unit's local password — keep it private.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { KumoCloud, KumoUnit, KumoCloudUnit } = require('../lib/kumo');

const CREDS_FILE = path.resolve(process.cwd(), 'kumo-creds.json');

function askHidden(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (!rl.muted) rl.output.write(s); };
    rl.question(prompt, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
    rl.muted = true;
  });
}

function loadCreds() {
  if (!fs.existsSync(CREDS_FILE)) {
    console.error(`No ${CREDS_FILE}. Run "login" first.`);
    process.exit(1);
  }
  const units = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
  const usable = units.filter((u) => u.complete);
  if (!usable.length) {
    console.error('No unit with complete credentials in kumo-creds.json');
    process.exit(1);
  }
  if (usable.length > 1) console.log(`(multiple units; using "${usable[0].label}" ${usable[0].serial})`);
  return usable[0];
}

function unitFor(ip) {
  const c = loadCreds();
  return new KumoUnit({ address: ip, password: c.password, cryptoSerial: c.cryptoSerial, log: console.log });
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  if (cmd === 'login') {
    const user = args[0];
    if (!user) throw new Error('usage: login <email>');
    const pass = process.env.KUMO_PASSWORD || (await askHidden('Comfort app password: '));
    const cloud = new KumoCloud(user, pass, { log: (m) => console.log('  ', m) });
    console.log('Logging in to Comfort cloud (V3)…');
    const debug = args.includes('--debug');
    const units = await cloud.discoverUnits({ debug });
    if (debug) console.log('\n--- debug (values redacted) ---\n' + JSON.stringify(cloud.debugInfo, null, 2) + '\n---');
    for (const u of units) {
      console.log(`- ${u.label}  serial=${u.serial}  mac=${u.mac || '?'}  password=${u.password ? 'yes' : 'MISSING'}  cryptoSerial=${u.cryptoSerial ? 'yes' : 'MISSING'}`);
    }
    fs.writeFileSync(CREDS_FILE, JSON.stringify(units, null, 2), { mode: 0o600 });
    console.log(`Saved ${units.length} unit(s) to ${CREDS_FILE}`);
    return;
  }

  if (cmd === 'cloud-status' || cmd === 'cloud-set' || cmd === 'cloud-profile' || cmd === 'cloud-watch') {
    const user = args[0];
    if (!user) throw new Error(`usage: ${cmd} <email> ...`);
    const pass = process.env.KUMO_PASSWORD || (await askHidden('Comfort app password: '));
    const cloud = new KumoCloud(user, pass, { log: (m) => console.log('  ', m) });
    await cloud.login();
    const sites = (await cloud._get('/v3/sites/')) || [];
    let serial = null;
    for (const site of sites) {
      for (const zone of (await cloud._get(`/v3/sites/${site.id}/zones`)) || []) {
        if (zone.adapter && zone.adapter.deviceSerial && !zone.adapter.isHeadless) {
          serial = serial || zone.adapter.deviceSerial;
          console.log(`zone "${zone.name}" serial=${zone.adapter.deviceSerial}`);
        }
      }
    }
    if (!serial) throw new Error('No indoor unit found');
    const unit = new KumoCloudUnit({ cloud, serial, log: console.log });
    if (cmd === 'cloud-watch') {
      const stream = cloud.getStream();
      stream.on('connected', () => console.log(`[${new Date().toLocaleTimeString()}] connected — change something in the Comfort app or on the remote (Ctrl-C to stop)`));
      stream.on('disconnected', () => console.log(`[${new Date().toLocaleTimeString()}] disconnected (will reconnect)`));
      stream.on('device_update', (s, data) => {
        const keys = ['power', 'operationMode', 'spHeat', 'spCool', 'roomTemp', 'fanSpeed', 'airDirection', 'humidity'];
        const shown = Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]]));
        console.log(`[${new Date().toLocaleTimeString()}] ${s}`, JSON.stringify(shown));
      });
      stream.addSerial(serial);
      await new Promise(() => {});
    }
    if (cmd === 'cloud-profile') {
      console.log(JSON.stringify(await unit.getProfile(true), null, 2));
      return;
    }
    if (cmd === 'cloud-set') {
      const [, field, value] = args;
      if (!field || value === undefined) throw new Error('usage: cloud-set <email> <field> <value>');
      await unit.getProfile();
      const v = ['spHeat', 'spCool'].includes(field) ? Number(value) : value;
      console.log('response:', JSON.stringify(await unit.setStatus({ [field]: v })));
      console.log('waiting 6 s for the unit to apply it…');
      await new Promise((r) => setTimeout(r, 6000));
    }
    const t0 = Date.now();
    const { raw, ...summary } = await unit.getStatus();
    console.log(JSON.stringify(summary, null, 2));
    console.log('supported modes:', unit.supportedModes().join(', '));
    console.log('supported fan speeds:', unit.supportedFanSpeeds().join(', '));
    console.log('supported vane directions:', unit.supportedVaneDirections().join(', ') || '(none reported)');
    console.log(`(${Date.now() - t0} ms)`);
    return;
  }

  if (cmd === 'status') {
    const unit = unitFor(args[0]);
    const t0 = Date.now();
    const s = await unit.getStatus();
    const { raw, ...summary } = s;
    console.log(JSON.stringify(summary, null, 2));
    console.log('supported modes:', unit.supportedModes().join(', '));
    console.log('supported fan speeds:', unit.supportedFanSpeeds().join(', '));
    console.log('supported vane directions:', unit.supportedVaneDirections().join(', ') || '(none reported)');
    console.log(`(${Date.now() - t0} ms)`);
    return;
  }

  if (cmd === 'profile') {
    const unit = unitFor(args[0]);
    console.log(JSON.stringify(await unit.getProfile(true), null, 2));
    console.log(JSON.stringify(await unit.getAdapterInfo(), null, 2));
    return;
  }

  if (cmd === 'set') {
    const [ip, field, value] = args;
    if (!ip || !field || value === undefined) throw new Error('usage: set <ip> <field> <value>');
    const unit = unitFor(ip);
    const v = ['spHeat', 'spCool'].includes(field) ? Number(value) : value;
    console.log('response:', JSON.stringify(await unit.setStatus({ [field]: v })));
    const { raw, ...summary } = await unit.getStatus();
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(3, 30).join('\n'));
}

main().catch((err) => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
