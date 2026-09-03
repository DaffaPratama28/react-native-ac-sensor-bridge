package com.irhomebridge.ble;

import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.os.ParcelUuid;
import android.util.Base64;

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
 * Why this exists: Android silently stops delivering results for
 * UNFILTERED BLE scans ~30 seconds after the screen turns off — no
 * error, results just stop arriving. This is documented, OS-level
 * behavior, separate from Doze/battery-optimization/OEM app killers.
 * A device-address filter is handled by the Bluetooth chipset's
 * hardware filtering rather than software-decoded matching, which is
 * why it's expected to be more reliable here than the service-UUID
 * filter this project found broken on this hardware earlier.
 *
 * Emits raw service-data bytes (base64) via DeviceEventEmitter — parsing/
 * decryption stays entirely on the JS side (mibeacon.ts / decrypt.ts),
 * unchanged. This module's only job is getting bytes off the air
 * reliably.
 */
public class BleScannerModule extends ReactContextBaseJavaModule {

    private static final String MODULE_NAME = "BleScannerModule";
    public static final String EVENT_SCAN_RESULT = "BleScannerModule:scanResult";
    public static final String EVENT_SCAN_ERROR = "BleScannerModule:scanError";

    private static final UUID MIBEACON_SERVICE_UUID =
            UUID.fromString("0000fe95-0000-1000-8000-00805f9b34fb");

    private BluetoothLeScanner bleScanner;
    private ScanCallback activeScanCallback;

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
            BluetoothManager bluetoothManager =
                    (BluetoothManager) getReactApplicationContext().getSystemService(Context.BLUETOOTH_SERVICE);
            if (bluetoothManager == null) {
                promise.reject("ERR_NO_BLUETOOTH", "BluetoothManager not available on this device.");
                return;
            }

            BluetoothAdapter adapter = bluetoothManager.getAdapter();
            if (adapter == null || !adapter.isEnabled()) {
                promise.reject("ERR_BLUETOOTH_OFF", "Bluetooth adapter is not available or not enabled.");
                return;
            }

            bleScanner = adapter.getBluetoothLeScanner();
            if (bleScanner == null) {
                promise.reject("ERR_NO_SCANNER", "BluetoothLeScanner not available (BLE not supported?).");
                return;
            }

            stopActiveScanIfAny(); // Defensive: don't stack multiple native scans.

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
                    handleScanResult(result);
                }

                @Override
                public void onScanFailed(int errorCode) {
                    WritableMap params = Arguments.createMap();
                    params.putInt("errorCode", errorCode);
                    emitEvent(EVENT_SCAN_ERROR, params);
                }
            };

            bleScanner.startScan(filters, settings, activeScanCallback);
            promise.resolve(null);
        } catch (Exception e) {
            promise.reject("ERR_START_SCAN_FAILED", "Failed to start native BLE scan: " + e.getMessage(), e);
        }
    }

    @ReactMethod
    public void stopScan(Promise promise) {
        try {
            stopActiveScanIfAny();
            promise.resolve(null);
        } catch (Exception e) {
            promise.reject("ERR_STOP_SCAN_FAILED", "Failed to stop native BLE scan: " + e.getMessage(), e);
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
}
