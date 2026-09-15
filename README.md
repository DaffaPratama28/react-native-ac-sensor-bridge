# IR Home Bridge

A local-only smart home bridge for a non-smart split AC. No cloud, no third-party hub, no subscription — just a spare Android phone doing all the work on-device.

The idea: a Xiaomi Mijia 3 temp/humidity sensor broadcasts encrypted BLE advertisements, this app passively reads and decrypts them, runs a hysteresis loop against configurable thresholds, and fires IR commands at the AC through the phone's built-in IR blaster. Runs as a persistent foreground service so it survives screen-off and backgrounding indefinitely.

## Why

Wanted automatic AC control based on room temperature without buying a smart AC or a smart plug + third-party sensor combo, and without sending anything to the cloud. An old phone with an IR blaster sitting in a drawer was already most of the hardware needed — this app is the rest.

## How it works

```
Mijia 3 sensor (BLE advertisement, encrypted)
        |
        v
Passive BLE scan (native Android)
        |
        v
AES-CCM decrypt (Bindkey from .env)
        |
        v
Hysteresis automation loop (with cooldown lock)
        |
        v
IR command matrix -> ConsumerIrManager -> AC
```

- **BLE**: Passive scanning only, filtered on the MiBeacon service UUID. No `.connect()` — the sensor drops active BLE sessions almost immediately, so this has to be advertisement-only. Implemented as a native Android module rather than a JS BLE library, since manufacturer-data filtering and background reliability needed more control than the RN wrappers give you.
- **Decrypt**: AES-CCM using `react-native-quick-crypto`, with the Bindkey + MAC pulled from `.env` at build time (never hardcoded — see Setup below).
- **Automation**: Simple Schmidt-trigger hysteresis (e.g. ≥28°C turns cooling on, ≤26°C turns it off) with a mandatory cooldown lock after every power-off, so the compressor doesn't get hammered with rapid on/off cycles.
- **IR**: Full-state command matrices (power + mode + temp + fan + checksum) sent through `ConsumerIrManager`, not toggle codes — matches how most split AC remotes actually work.
- **Persistence**: A real native Android Foreground Service with a notification channel, not a JS background task library. Those get throttled by the OS and aren't reliable enough for something that needs to run 24/7.

## Tested hardware

| Device              | BLE scanning                | IR transmit | Notes                                                                                                                                                                                                                                                         |
| ------------------- | --------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Xiaomi 14 (HyperOS) | Works                       | Works       | HyperOS occasionally kills the BLE scan in the background when the screen's off — scan doesn't resume on its own and needs an app restart. Still tracking this down, looks like a HyperOS-specific background restriction rather than a bug in the scan code. |
| Samsung A31         | Works, including screen-off | Not tested  | No IR blaster on this device, so IR transmit couldn't be tested here. Scanning is solid with the screen off, unlike the Xiaomi — points at the HyperOS issue above being OEM-specific rather than a general Android background BLE limitation.                |

If you're running this on a different device and BLE scanning silently stops after screen-off, check the OEM's background activity / battery optimization restrictions first — this seems to be an OEM thing more than an Android-version thing.

## AC compatibility

The IR command set targets the **YR-W02 Haier protocol**. In Indonesia this is what **Aqua**-branded split AC units use. Any AC using the same protocol should work in theory since the IR layer targets the protocol and not a specific brand, but only the Aqua unit has actually been tested — treat other YR-W02 units as untested until confirmed.

## Setup

1. Clone the repo and install dependencies:
   ```bash
   npm install
   ```
2. Copy `.env.example` to `.env` and fill in your own sensor's MAC address and Bindkey (obtained via a BLE flashing/sniffing tool like Telink Flasher — not something this repo provides):
   ```bash
   cp .env.example .env
   ```
3. Run on a connected Android device (this needs real hardware — an emulator has neither a BLE radio nor an IR blaster):
   ```bash
   npx react-native run-android
   ```

Your `.env` is gitignored. Never commit real Bindkeys or MAC addresses — the values in `.env.example` are placeholders only.

## Status

Roughly 95% there. BLE scanning, decryption, hysteresis, cooldown lock, and IR transmit are all working end to end on real hardware. Remaining:

- [ ] Track down the HyperOS background BLE scan drop and add auto-restart/recovery instead of requiring a manual app restart
- [ ] Test IR transmit against more YR-W02-protocol units beyond the Aqua unit
- [ ] General config UI polish (thresholds/cooldown are currently configurable constants, not yet exposed in-app)

## Disclaimer

This controls physical hardware (a compressor-based AC unit) via inferred/sourced IR protocols. The cooldown lock exists specifically to protect the compressor from rapid cycling — don't lower it below manufacturer-recommended minimums. Raw IR pulse data sourced from public IR databases should be validated against your actual unit before relying on it unattended.
