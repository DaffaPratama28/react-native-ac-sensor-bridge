package com.irhomebridge.ble;

import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.ParcelUuid;
import android.util.Base64;
import android.util.Log;

import androidx.annotation.NonNull;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * Native passive BLE scanner using a hardware-level device-address
 * ScanFilter, instead of the client-side MAC filtering this project
 * previously did on top of an unfiltered (or broken service-UUID
 * filtered) react-native-ble-plx scan.
 *
 * HYPEROS SCREEN-OFF THROTTLE (2026-09 investigation):
 * dumpsys bluetooth_manager on Xiaomi 14 / Redmi 13C (HyperOS) shows
 * LOW_LATENCY scans keep accumulating "active" time for a while after
 * screen-off, then start accumulating "suspend" time instead — i.e. this
 * isn't an instant screen-off cutoff, it's HyperOS suspending a scan
 * session once it's been alive past some age threshold. A short scan
 * window right after screen-off can still capture results; a long-lived
 * one gets throttled. Countermeasure: proactively tear down and recreate
 * the native scan session on a fixed interval (see beginScanSession /
 * onScanWindowExpired below) so no single session ever gets old enough
 * to hit that threshold. The MAC ScanFilter itself (below) is a separate,
 * earlier fix for a different problem (unfiltered/service-UUID-filtered
 * scans losing results ~30s after screen-off on plain AOSP-level
 * behavior) and is still required independently of the restart loop.
 *
 * Emits raw service-data bytes (base64) via DeviceEventEmitter — parsing/
 * decryption stays entirely on the JS side (mibeacon.ts / decrypt.ts),
 * unchanged. This module's only job is getting bytes off the air
 * reliably.
 */
public class BleScannerModule extends ReactContextBaseJavaModule {

    private static final String TAG = "BleScannerModule"; // filter logcat with: adb logcat -s BleScannerModule
    private static final String MODULE_NAME = "BleScannerModule";
    public static final String EVENT_SCAN_RESULT = "BleScannerModule:scanResult";
    public static final String EVENT_SCAN_ERROR = "BleScannerModule:scanError";
    public static final String EVENT_HEARTBEAT = "BleScannerModule:heartbeat";
    public static final String EVENT_SCAN_RESTART = "BleScannerModule:scanRestart";

    private static final long HEARTBEAT_INTERVAL_MS = 10_000;

    /**
     * How long a single native scan session is allowed to live before we
     * proactively tear it down and recreate it, to stay under whatever age
     * threshold HyperOS is using to decide "this scan has been running too
     * long, suspend it." Tune this down if dumpsys still shows suspend
     * time creeping in; tune it up cautiously — going too low risks
     * tripping Android's own SCAN_FAILED_SCANNING_TOO_FREQUENTLY throttle
     * (undocumented, roughly ~5 start/stop cycles per 30s app-wide on
     * API 31+). 15s window + 1s gap = ~16s cycle, well under that.
     */
    private static final long SCAN_WINDOW_MS = 15_000;

    /**
     * Gap between stopScan() and the next startScan() during a proactive
     * restart. Deliberately non-zero (not "instant") per user's own
     * testing — some device schedulers seem to need a beat between the
     * two BluetoothLeScanner calls. Keep this short: every ms here is a
     * ms with no active scan session, i.e. a real (small) coverage gap.
     */
    private static final long SCAN_RESTART_GAP_MS = 300;

    private static final UUID MIBEACON_SERVICE_UUID =
            UUID.fromString("0000fe95-0000-1000-8000-00805f9b34fb");

    private BluetoothLeScanner bleScanner;
    private ScanCallback activeScanCallback;

    // --- Proactive restart loop state -------------------------------------
    private HandlerThread scanLoopThread;
    private Handler scanLoopHandler;
    private String currentMacAddress;
    private volatile boolean scanLoopActive = false;
    private int restartCount = 0;

    private final Runnable onScanWindowExpiredRunnable = this::onScanWindowExpired;
    private final Runnable onRestartGapElapsedRunnable = this::onRestartGapElapsed;
    // ------------------------------------------------------------------------

    /**
     * DIAGNOSTIC: runs on its own HandlerThread (not the main/JS thread)
     * so it's a clean independent signal. If HyperOS is freezing this
     * app's entire process (this project's working theory, given three
     * different scan strategies all failed identically), this heartbeat
     * will show GAPS in its own Log.d timestamps matching the screen-off
     * duration — i.e. it won't tick on schedule, it'll catch up all at
     * once the moment the screen unlocks. That's the smoking gun for
     * "whole process frozen" vs. "only BLE scanning specifically
     * throttled" (which would show the heartbeat ticking normally with
     * zero scan results in between).
     *
     * Deliberately logs via native Log.d (visible in `adb logcat`,
     * independent of the JS bridge/engine being responsive) AND emits a
     * JS event, so the two channels can be directly compared.
     */
    private HandlerThread heartbeatThread;
    private Handler heartbeatHandler;
    private final Runnable heartbeatRunnable = new Runnable() {
        @Override
        public void run() {
            long now = System.currentTimeMillis();
            Log.d(TAG, "HEARTBEAT native tick at " + now);

            WritableMap params = Arguments.createMap();
            params.putDouble("timestamp", (double) now);
            emitEvent(EVENT_HEARTBEAT, params);

            if (heartbeatHandler != null) {
                heartbeatHandler.postDelayed(this, HEARTBEAT_INTERVAL_MS);
            }
        }
    };

    public BleScannerModule(@NonNull ReactApplicationContext reactContext) {
        super(reactContext);
    }

    @NonNull
    @Override
    public String getName() {
        return MODULE_NAME;
    }

    /**
     * @param macAddress e.g. "A4:C1:38:B7:58:9A" — the ONLY device this
     *                   scan will match, filtered natively.
     */
    @ReactMethod
    public void startScan(String macAddress, Promise promise) {
        try {
            resolveBleScanner(); // fail fast with a clear promise rejection before touching loop state
        } catch (IllegalStateException e) {
            promise.reject("ERR_START_SCAN_FAILED", e.getMessage());
            return;
        }

        stopScanLoopInternal(); // clean slate — cancel any previous loop/timers first
        ensureScanLoopThread();

        currentMacAddress = macAddress;
        scanLoopActive = true;
        restartCount = 0;

        try {
            beginScanSession(macAddress);
            Log.d(TAG, "startScan() called successfully for MAC " + macAddress);
            startHeartbeat();
            promise.resolve(null);
        } catch (Exception e) {
            scanLoopActive = false;
            Log.e(TAG, "startScan() failed: " + e.getMessage(), e);
            promise.reject("ERR_START_SCAN_FAILED", "Failed to start native BLE scan: " + e.getMessage(), e);
        }
    }

    @ReactMethod
    public void stopScan(Promise promise) {
        try {
            stopScanLoopInternal();
            stopHeartbeat();
            Log.d(TAG, "stopScan() called successfully");
            promise.resolve(null);
        } catch (Exception e) {
            Log.e(TAG, "stopScan() failed: " + e.getMessage(), e);
            promise.reject("ERR_STOP_SCAN_FAILED", "Failed to stop native BLE scan: " + e.getMessage(), e);
        }
    }

    // --- Proactive restart loop ---------------------------------------------

    private void resolveBleScanner() {
        BluetoothManager bluetoothManager =
                (BluetoothManager) getReactApplicationContext().getSystemService(Context.BLUETOOTH_SERVICE);
        if (bluetoothManager == null) {
            throw new IllegalStateException("BluetoothManager not available on this device.");
        }

        BluetoothAdapter adapter = bluetoothManager.getAdapter();
        if (adapter == null || !adapter.isEnabled()) {
            throw new IllegalStateException("Bluetooth adapter is not available or not enabled.");
        }

        bleScanner = adapter.getBluetoothLeScanner();
        if (bleScanner == null) {
            throw new IllegalStateException("BluetoothLeScanner not available (BLE not supported?).");
        }
    }

    private void ensureScanLoopThread() {
        if (scanLoopThread == null || !scanLoopThread.isAlive()) {
            scanLoopThread = new HandlerThread("BleScannerRestartLoop");
            scanLoopThread.start();
            scanLoopHandler = new Handler(scanLoopThread.getLooper());
        }
    }

    /**
     * Starts (or restarts) the actual BluetoothLeScanner session for
     * macAddress and arms the SCAN_WINDOW_MS timer that will proactively
     * tear it down again. Called both from startScan() and from
     * onRestartGapElapsed() — same code path either way, so the very
     * first session and every subsequent proactive restart behave
     * identically.
     */
    private void beginScanSession(String macAddress) {
        resolveBleScanner();
        stopActiveScanIfAny(); // defensive: never stack two native scan sessions

        ScanFilter filter = new ScanFilter.Builder()
                .setDeviceAddress(macAddress)
                .build();
        List<ScanFilter> filters = new ArrayList<>();
        filters.add(filter);

        ScanSettings settings = new ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                .build();

        activeScanCallback = new ScanCallback() {
            @Override
            public void onScanResult(int callbackType, ScanResult result) {
                Log.d(TAG, "onScanResult() fired, callbackType=" + callbackType
                        + ", device=" + result.getDevice().getAddress()
                        + ", at " + System.currentTimeMillis());
                handleScanResult(result);
            }

            @Override
            public void onScanFailed(int errorCode) {
                Log.e(TAG, "onScanFailed() errorCode=" + errorCode);
                WritableMap params = Arguments.createMap();
                params.putInt("errorCode", errorCode);
                emitEvent(EVENT_SCAN_ERROR, params);

                // errorCode 6 == SCAN_FAILED_SCANNING_TOO_FREQUENTLY (API 31+).
                // If the restart loop itself is what's tripping Android's own
                // start/stop rate limit, stop looping instead of hammering it
                // and making things worse — surface it as a scan error so the
                // JS side sees it clearly rather than silently going quiet.
                if (errorCode == 6) {
                    Log.e(TAG, "Restart loop hit SCAN_FAILED_SCANNING_TOO_FREQUENTLY — stopping the loop.");
                    scanLoopActive = false;
                }
            }
        };

        bleScanner.startScan(filters, settings, activeScanCallback);

        if (scanLoopHandler != null) {
            scanLoopHandler.removeCallbacks(onScanWindowExpiredRunnable);
            scanLoopHandler.postDelayed(onScanWindowExpiredRunnable, SCAN_WINDOW_MS);
        }
    }

    private void onScanWindowExpired() {
        if (!scanLoopActive) {
            return;
        }
        restartCount++;
        Log.d(TAG, "Scan window (" + SCAN_WINDOW_MS + "ms) elapsed — proactively restarting "
                + "scan session (restart #" + restartCount + ") to dodge HyperOS long-scan throttle.");

        stopActiveScanIfAny();
        emitRestartEvent("window_expired");

        if (scanLoopHandler != null) {
            scanLoopHandler.postDelayed(onRestartGapElapsedRunnable, SCAN_RESTART_GAP_MS);
        }
    }

    private void onRestartGapElapsed() {
        if (!scanLoopActive) {
            Log.d(TAG, "Restart gap elapsed but loop was stopped meanwhile — not restarting.");
            return;
        }
        try {
            beginScanSession(currentMacAddress);
            Log.d(TAG, "Proactive restart #" + restartCount + " complete.");
        } catch (Exception e) {
            Log.e(TAG, "Proactive scan restart failed, stopping loop: " + e.getMessage(), e);
            scanLoopActive = false;
            WritableMap params = Arguments.createMap();
            params.putString("message", "Proactive scan restart failed: "
                    + (e.getMessage() != null ? e.getMessage() : "unknown"));
            emitEvent(EVENT_SCAN_ERROR, params);
        }
    }

    /** Cancels the restart loop and stops any live scan session. Idempotent. */
    private void stopScanLoopInternal() {
        scanLoopActive = false;
        if (scanLoopHandler != null) {
            scanLoopHandler.removeCallbacksAndMessages(null);
        }
        stopActiveScanIfAny();
    }

    private void emitRestartEvent(String reason) {
        WritableMap params = Arguments.createMap();
        params.putInt("restartCount", restartCount);
        params.putString("reason", reason);
        params.putDouble("timestamp", (double) System.currentTimeMillis());
        emitEvent(EVENT_SCAN_RESTART, params);
    }

    // -------------------------------------------------------------------------

    private void startHeartbeat() {
        stopHeartbeat(); // Defensive: don't stack multiple heartbeat loops.
        heartbeatThread = new HandlerThread("BleScannerHeartbeat");
        heartbeatThread.start();
        heartbeatHandler = new Handler(heartbeatThread.getLooper());
        heartbeatHandler.post(heartbeatRunnable);
    }

    private void stopHeartbeat() {
        if (heartbeatHandler != null) {
            heartbeatHandler.removeCallbacks(heartbeatRunnable);
            heartbeatHandler = null;
        }
        if (heartbeatThread != null) {
            heartbeatThread.quitSafely();
            heartbeatThread = null;
        }
    }

    private void stopActiveScanIfAny() {
        if (bleScanner != null && activeScanCallback != null) {
            try {
                bleScanner.stopScan(activeScanCallback);
            } catch (Exception ignored) {
                // Scanner may already be stopped (e.g. Bluetooth toggled off externally) — safe to ignore.
            }
        }
        activeScanCallback = null;
    }

    private void handleScanResult(ScanResult result) {
        if (result.getScanRecord() == null) {
            return;
        }

        byte[] serviceData = result.getScanRecord().getServiceData(new ParcelUuid(MIBEACON_SERVICE_UUID));
        if (serviceData == null) {
            return; // This advertisement cycle didn't carry MiBeacon service data.
        }

        WritableMap params = Arguments.createMap();
        params.putString("mac", result.getDevice().getAddress());
        params.putString("name", result.getDevice().getName());
        params.putString("serviceDataBase64", Base64.encodeToString(serviceData, Base64.NO_WRAP));
        params.putInt("rssi", result.getRssi());
        params.putDouble("timestamp", (double) System.currentTimeMillis());

        emitEvent(EVENT_SCAN_RESULT, params);
    }

    private void emitEvent(String eventName, WritableMap params) {
        ReactApplicationContext context = getReactApplicationContext();
        if (context.hasActiveReactInstance()) {
            context
                    .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                    .emit(eventName, params);
        }
    }

    /** Called when the React instance is torn down — release both loop threads. */
    @Override
    public void invalidate() {
        stopScanLoopInternal();
        stopHeartbeat();
        if (scanLoopThread != null) {
            scanLoopThread.quitSafely();
            scanLoopThread = null;
            scanLoopHandler = null;
        }
        super.invalidate();
    }
}