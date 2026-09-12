# AGENTS.md — IRHomeBridge

## Project overview

React Native `0.87` + React `19` app (TypeScript, Node `>=22.11.0`).
Android-first BLE → IR automation bridge:

- Passively scans **one** Xiaomi Mijia-family sensor (MiBeacon advertisements only, never `.connect()`).
- Decrypts service-data with bindkey, parses temp/humidity/battery.
- Stores readings history, drives hysteresis automation that transmits IR commands (Haier YRW-02 AC protocol) via native IR blaster.
- Foreground service + background ticker keep monitoring alive with screen off.

Entry: `index.js` → `App.tsx` (`AppContent`).

## Directory layout

- `App.tsx` — scan start/stop UI, live temp/humidity cards, debug log (cap 200 lines), history modal + remote screen toggles. Calls `automationController.loadPersisted()` + `startBackgroundTicker()` at module load.
- `src/ble/` — `scanner.ts` (MijiaScanner class), `sharedScanner.ts` (module singleton), `mibeacon.ts`, `decrypt.ts`.
- `src/automation/` — `automationController.ts` (persisted singleton), `hysteresis.ts`, `cooldownLock.ts`, `timerMirror.ts`, `backgroundTicker.ts`.
- `src/ir/` — `IRBlaster.ts` (typed `transmit()`/`hasIrEmitter()` wrapper), `protocols/acProtocol.ts` (HaierYRW02 `stateToCommand`).
- `src/storage/` — `readingsStore.ts` (history), `acStateStore.ts` (last AC state + source).
- `src/service/foregroundService.ts` — JS bridge to `MijiaForegroundService.java`.
- `src/types/mibeacon.ts`, `src/ui/` (`LogView`, `ReadingsHistoryModal`, `RemoteControlScreen`).
- `android/app/src/main/java/com/irhomebridge/{ble,ir,service}/` — native modules: `BleScannerModule`, `IRBlasterModule`, `MijiaForegroundService`. No iOS implementations.
- `__tests__/App.test.tsx` — Jest (`@react-native/jest-preset`).

## Commands

```sh
npm start          # Metro dev server
npm run android    # build + run Android
npm run ios        # build + run iOS (BLE/IR paths are Android-only stubs)
npm test           # jest
npm run lint       # eslint .
```

iOS native deps (first clone / after native dep change):
```sh
bundle install
bundle exec pod install
```

## Environment / secrets

- Copy `.env.example` → `.env` (gitignored, never commit):
  ```
  MIJIA_MAC=AA:BB:CC:DD:EE:FF
  MIJIA_BINDKEY=00000000000000000000000000000000
  ```
- Read via `react-native-config` (`Config.MIJIA_MAC`). Never hardcode MAC/bindkey in source — `MijiaScanner` throws `MijiaScannerConfigError` if missing.
- Rebuild native app after `.env` changes (RN Config is baked at build time).

## Critical architecture rules

1. **Passive BLE only.** Never add `connect()`/GATT calls to the Mijia path. Parse + decrypt advertisement service-data only (`scanner.ts:handleScanResult`).
2. **Native scan path.** Scanning goes through `BleScannerModule.java` (hardware MAC `ScanFilter` — required to survive Android screen-off ~30s throttle). Do not revert to `react-native-ble-plx` scanning. JS `MijiaScanner` API stays stable so `App.tsx` callers don't change.
3. **`reading` vs `rawReading` (`SensorUpdate`).** Sensor broadcasts fragmented attributes (only what crossed a threshold). `reading` = merged with last-known (for live display + automation `SensorSnapshot`); `rawReading` = only this cycle's attributes (for storage). Always pass `rawReading` to `appendReading()` — merged data would falsify history. Missing fields store as literal `'EMPTY'`.
4. **Singletons outlive screens.** Use `src/ble/sharedScanner.ts:scanner` and `automationController` — never instantiate `MijiaScanner`/`AutomationController` per-screen. `RemoteControlScreen` only reads/writes config; it doesn't own subscriptions. On unmount call `scanner.stop()`, never `destroy()` except true app shutdown.
5. **Automation flow.** `scanner.onUpdate → HysteresisAutomation.evaluate(snapshot) → loadAcState → stateToCommand → transmit → saveAcState(next,'automation')`. Handle `no_change` / `blocked_cooldown` explicitly; failed `transmit()` must emit `error` event, not break the state machine. Config/enabled persist under AsyncStorage keys `irhomebridge:automation_config` / `irhomebridge:automation_enabled`.
6. **Scan lifecycle.** 6h hard cap (`MAX_SCAN_DURATION_MS`) auto-stops via `onAutoStop`. `start()` is idempotent; `stop()` removes event subscriptions and clears timer. Foreground monitoring (`startForegroundMonitoring`/`stopForegroundMonitoring`) must pair with scan start/stop.
7. **IR validation duplicated intentionally.** `IRBlaster.ts:validatePattern` mirrors Java checks for fast failure — keep both in sync. `transmit(frequency, patternArray)`: frequency positive int Hz, pattern non-empty even-length array of positive-int µs durations starting with "on". Always gate automation on `hasIrEmitter()` (returns `false` on iOS/non-IR hardware). `transmit()` throws `IRBlasterError` on iOS.
8. **Storage limits.** `readingsStore` caps at 20000 entries (AsyncStorage read-modify-write whole array — don't use for high-frequency logging; SQLite would be the migration path). `LogView` caps at 200 lines (`MAX_LOG_LINES`).

## Native module rules

- After touching anything under `android/.../java/`, adding a `*Package.java`, or editing `MainApplication`, **rebuild the app** — JS-only reload is not enough. Both `scanner.ts` and `IRBlaster.ts` surface explicit `LINKING_ERROR` text for this case; preserve it.
- New native methods need matching TS typings in the corresponding `*NativeModule` interface in `scanner.ts` / `IRBlaster.ts` / `foregroundService.ts`.
- Android permissions: API 31+ needs `BLUETOOTH_SCAN` + `BLUETOOTH_CONNECT` (+ location requested); API <31 needs `ACCESS_FINE_LOCATION`. `requestPermissions()` returns `false` on non-Android — surface a log message, don't silently fail.

## Code conventions

- TypeScript strict via `@react-native/typescript-config`. Functional components + hooks only.
- ESLint: `@react-native` config (`.eslintrc.js`); Prettier `2.8.8` (`.prettierrc.js`). Run `npm run lint` before finishing.
- Error types: extend `Error` with distinct `name` (`MijiaScannerConfigError`, `MiBeaconParseError`, `MiBeaconDecryptError`, `IRBlasterError`, `ReadingsStoreError`). Emit scan/parse errors via `onError`, don't throw inside event handlers (wrap in `Unexpected error handling advertisement...`).
- Keep diagnostic `console.log` hex dumps in `handleScanResult` (pre-parse / frame / decrypted payload / objects) — they are the primary BLE debug path.
- UI: dark theme (`#0b0d11` bg, `#12151a` cards, `#262b33` borders). `SafeAreaView` from `react-native-safe-area-context` + explicit non-translucent `StatusBar` — don't revert to RN core `SafeAreaView` (breaks Android insets).
- AsyncStorage keys are namespaced `irhomebridge:*`. Persisted shapes (`AutomationConfig`, `StoredReading`) must stay JSON-compatible; handle `null`/corrupt gracefully.

## Testing

- `npm test` (Jest preset `@react-native/jest-preset`). Existing coverage is thin (`__tests__/App.test.tsx` only) — add unit tests for pure logic (`mibeacon.ts`, `decrypt.ts`, `hysteresis.ts`, `cooldownLock.ts`, `acProtocol.ts`) when changing them; avoid hardware-dependent tests (mock `NativeModules.BleScannerModule` / `IRBlasterModule`).
- Manual verification needs a physical Android device with BLE + (for transmit) consumer-IR hardware; emulator/simulator cannot cover scan/transmit paths.
