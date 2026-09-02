import { NativeModules, Platform } from 'react-native';

interface ForegroundServiceNativeModule {
  start(): Promise<void>;
  stop(): Promise<void>;
  requestIgnoreBatteryOptimizations(): Promise<boolean>;
  openXiaomiAutostartSettings(): Promise<boolean>;
  openAppSettings(): Promise<boolean>;
}

const LINKING_ERROR =
  `ForegroundServiceModule native module is not linked. Make sure:\n` +
  `  - You have rebuilt the app after adding ForegroundServicePackage (JS-only reload is not enough)\n` +
  `  - ForegroundServicePackage is registered in MainApplication\n` +
  `  - You are running on Android (this module has no iOS implementation)\n`;

function getNativeModule(): ForegroundServiceNativeModule {
  const nativeModule = NativeModules.ForegroundServiceModule as
    | ForegroundServiceNativeModule
    | undefined;

  if (!nativeModule) {
    throw new Error(LINKING_ERROR);
  }

  return nativeModule;
}

/**
 * Starts the true Android foreground service that keeps this app's
 * process alive (and with it, the existing BLE scan) when backgrounded
 * or the screen is off. Call once, e.g. right after a successful
 * scanner.start() — not on every reading.
 *
 * On Android 13+ (API 33+), posting the persistent notification requires
 * the POST_NOTIFICATIONS runtime permission — request it (e.g. via
 * PermissionsAndroid) before calling this, or the service will still
 * run but the user won't see the status notification.
 */
export async function startForegroundMonitoring(): Promise<void> {
  if (Platform.OS !== 'android') {
    return;
  }
  await getNativeModule().start();
}

/** Stops the foreground service. Call when monitoring should fully stop, not on routine backgrounding. */
export async function stopForegroundMonitoring(): Promise<void> {
  if (Platform.OS !== 'android') {
    return;
  }
  await getNativeModule().stop();
}

/**
 * Requests exemption from standard Android Doze/App Standby battery
 * optimization. Worth calling once (e.g. a settings button), but on
 * Xiaomi devices this alone is NOT sufficient — MIUI/HyperOS runs its
 * own separate background-management layer that this API doesn't
 * override. See openXiaomiAutostartSettings/openAppSettings below for
 * the manual steps that actually matter on those devices.
 *
 * Resolves true if already exempted; if not, opens a system dialog and
 * resolves false immediately (there's no reliable way to know the
 * dialog's outcome from here — re-call this later to check again).
 */
export async function requestIgnoreBatteryOptimizations(): Promise<boolean> {
  if (Platform.OS !== 'android') {
    return true;
  }
  return getNativeModule().requestIgnoreBatteryOptimizations();
}

/**
 * Attempts to open MIUI/HyperOS's Autostart management screen directly.
 * Targets an undocumented Xiaomi-internal activity — works on most
 * MIUI/HyperOS versions but isn't guaranteed on all of them. Returns
 * false (not a thrown error) if unavailable; fall back to
 * openAppSettings() and manual instructions in that case.
 */
export async function openXiaomiAutostartSettings(): Promise<boolean> {
  if (Platform.OS !== 'android') {
    return false;
  }
  return getNativeModule().openXiaomiAutostartSettings();
}

/** Opens this app's standard system App Info screen — a reliable fallback for manual battery-saver setup on any device/OEM. */
export async function openAppSettings(): Promise<void> {
  if (Platform.OS !== 'android') {
    return;
  }
  await getNativeModule().openAppSettings();
}
