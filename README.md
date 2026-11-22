# Mitsubishi Comfort for Homey

> **Nov 2026 status:** Mitsubishi's cloud stopped returning the adapter's local key (password/cryptoSerial) around 2026-07-31, for every client including Home Assistant. New pairings therefore use **cloud mode**: Homey calls the same Mitsubishi Comfort V3 web API the phone app uses (login → `GET /v3/devices/{serial}` → `POST /v3/devices/send-command`). Local mode still works if you have a saved key (e.g. an old `kumo_cache.json`); enter it on the *Enter keys manually* tab.

This app controls Mitsubishi mini-splits that have a Mitsubishi Comfort (formerly Kumo Cloud) Wi-Fi adapter (PAC-USWHS002-WF-x). It runs on your LAN from Homey Pro or Homey Self-Hosted Server. It works the same way as Home Assistant's `mitsubishi_comfort` integration: your Comfort app login is used **once**, at pairing, to fetch the unit's local key. After that, every command goes straight to the adapter over HTTP. The cloud isn't used.

The protocol is ported from [pykumo](https://github.com/dlarrick/pykumo) (MIT) and `mitsubishi-comfort`.

## What you get

| Homey capability | Unit field | Notes |
|---|---|---|
| `onoff` | mode | Off sends `off`. On restores the last active mode. |
| `thermostat_mode` | mode | Off / heat / cool / auto. Works with voice and Google/Alexa. |
| `kumo_mode` (picker) | mode | Every mode, including **Dry** and **Fan only**. |
| `target_temperature` | spHeat / spCool | Heat uses spHeat. Cool/Dry use spCool. In Auto it moves both setpoints and keeps the gap between them. |
| `target_temperature.heat` / `.cool` | spHeat / spCool | Only added if the unit supports Auto. |
| `measure_temperature` | roomTemp | |
| `measure_humidity` | sensor / MHK2 | Only added if the unit reports a humidity value. |
| `kumo_fan_speed`, `kumo_vane` | fanSpeed, vaneDir | The vane control is removed if the unit doesn't report one (some cassettes don't). |
| `alarm_generic` | filterDirty | Labelled "Filter needs cleaning". |
| `kumo_rssi` | adapter Wi-Fi RSSI | Logged to Insights. |

**Fahrenheit:** when Homey is set to imperial units, setpoints use the Comfort app's own whole-degree °F ↔ °C table. Setting 70 °F in Homey shows 70 °F in the Comfort app, and the reverse. You can force this per device with Settings → *Setpoint rounding*.

**Flow cards:** Mode changed (trigger) · Fan speed changed (trigger) · Mode is… (condition) · Is heating or cooling (condition) · Set mode · Set fan speed · Set vane · Set mode and temperature · Set heat/cool setpoints. You also get Homey's built-in thermostat, on/off and temperature cards.

## 1. Test from your Mac first (optional, ~2 min)

Cloud mode:

```bash
node tools/kumo-test.js cloud-status you@example.com
node tools/kumo-test.js cloud-set you@example.com fanSpeed quiet
```

Local mode (needs a local key):

You need Node 16 or newer. Nothing to install.

```bash
cd homey-mitsubishi-comfort
node tools/kumo-test.js login you@example.com     # prompts for the Comfort password, writes kumo-creds.json
node tools/kumo-test.js status 192.168.1.50
node tools/kumo-test.js profile 192.168.1.50     # shows what the cassette supports (fan speeds, vane)
node tools/kumo-test.js set 192.168.1.50 fanSpeed quiet
```

`kumo-creds.json` contains the unit's local key. Keep it private. You can also paste its `password` and `cryptoSerial` into the pairing screen's **Enter keys manually** tab.

## 2. Install on Homey

```bash
npm install -g homey           # Homey CLI
homey login
homey select                   # pick the Self-Hosted Server
cd homey-mitsubishi-comfort
homey app install              # or: homey app run --remote  (live logs, app stops when you Ctrl-C)
```

Then go to Devices → + → *Mitsubishi Comfort*. Log in with your Comfort app account and enter the adapter IP (**192.168.1.50**). The app tests the connection before it adds the device.

## 3. If something breaks later

- **IP changed:** update it in device Settings → *Adapter IP address*.
- **Mitsubishi rotated the key, or the adapter was re-provisioned:** use the device's **Repair** option. It runs the same login screen and refreshes the stored key.
- **Live logs:** `homey app run --remote`. On the first poll the app logs the unit's profile (modes, fan speeds, vane, setpoint limits).

## Development

```bash
npm test               # offline self-test: token vs Python reference, fake signed adapter, device logic with mocked Homey
homey app validate --level debug
```

## License

MIT — see [LICENSE](LICENSE). The local-API token computation and the Comfort cloud protocol are ported from [pykumo](https://github.com/dlarrick/pykumo) (MIT, © 2019 dlarrick) and [mitsubishi-comfort](https://github.com/nikolairahimi/mitsubishi-comfort) (MIT, © 2026 Nikolai Rahimi). Not affiliated with or endorsed by Mitsubishi Electric.
