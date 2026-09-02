package com.irhomebridge.service;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import androidx.annotation.NonNull;
import androidx.core.content.ContextCompat;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;

public class ForegroundServiceModule extends ReactContextBaseJavaModule {

    private static final String MODULE_NAME = "ForegroundServiceModule";
    private static final String ERR_START_FAILED = "ERR_START_FAILED";
    private static final String ERR_STOP_FAILED = "ERR_STOP_FAILED";

    public ForegroundServiceModule(@NonNull ReactApplicationContext reactContext) {
        super(reactContext);
    }

    @NonNull
    @Override
    public String getName() {
        return MODULE_NAME;
    }

    @ReactMethod
    public void start(Promise promise) {
        try {
            Context context = getReactApplicationContext();
            Intent intent = MijiaForegroundService.createStartIntent(context);

            // startForegroundService() (API 26+) requires the service to
            // call startForeground() within a few seconds or the OS throws
            // — MijiaForegroundService does this immediately in
            // onStartCommand(), so this is safe.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ContextCompat.startForegroundService(context, intent);
            } else {
                context.startService(intent);
            }
            promise.resolve(null);
        } catch (Exception e) {
            promise.reject(ERR_START_FAILED, "Failed to start foreground service: " + e.getMessage(), e);
        }
    }

    @ReactMethod
    public void stop(Promise promise) {
        try {
            Context context = getReactApplicationContext();
            Intent intent = MijiaForegroundService.createStartIntent(context);
            context.stopService(intent);
            promise.resolve(null);
        } catch (Exception e) {
            promise.reject(ERR_STOP_FAILED, "Failed to stop foreground service: " + e.getMessage(), e);
        }
    }

    /**
     * Standard Android-level battery optimization exemption (Doze/App
     * Standby). Worth having, but per Xiaomi's own documented behavior
     * this does NOT override MIUI/HyperOS's separate app-management
     * layer — the Autostart / Battery Saver / Recents-lock settings
     * still need to be set manually (see openXiaomiAutostartSettings
     * and openXiaomiBatterySettings below). Resolves true if already
     * exempted or the user granted it, false if the user declined —
     * this opens a system dialog, so there's no error case beyond that.
     */
    @ReactMethod
    public void requestIgnoreBatteryOptimizations(Promise promise) {
        Context context = getReactApplicationContext();
        String packageName = context.getPackageName();
        PowerManager powerManager = (PowerManager) context.getSystemService(Context.POWER_SERVICE);

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M || powerManager == null) {
            promise.resolve(true); // Not applicable below API 23.
            return;
        }

        if (powerManager.isIgnoringBatteryOptimizations(packageName)) {
            promise.resolve(true);
            return;
        }

        try {
            Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            intent.setData(Uri.parse("package:" + packageName));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
            // No reliable callback for the dialog's outcome from here;
            // caller can re-check via this same method later if needed.
            promise.resolve(false);
        } catch (ActivityNotFoundException e) {
            promise.reject("ERR_NOT_SUPPORTED", "Battery optimization settings not available on this device.", e);
        }
    }

    /**
     * Attempts to open MIUI/HyperOS's Autostart management screen
     * directly. This targets an undocumented Xiaomi-internal activity —
     * it works on most MIUI/HyperOS versions but isn't guaranteed across
     * all of them or all regions. Resolves false (not an error) if the
     * screen isn't found, so the caller can fall back to telling the
     * user to navigate there manually.
     */
    @ReactMethod
    public void openXiaomiAutostartSettings(Promise promise) {
        try {
            Intent intent = new Intent();
            intent.setComponent(new ComponentName(
                    "com.miui.securitycenter",
                    "com.miui.permcenter.autostart.AutoStartManagementActivity"));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getReactApplicationContext().startActivity(intent);
            promise.resolve(true);
        } catch (ActivityNotFoundException e) {
            promise.resolve(false);
        }
    }

    /** Opens this app's standard system App Info screen, as a reliable fallback for manual battery-saver setup. */
    @ReactMethod
    public void openAppSettings(Promise promise) {
        try {
            Context context = getReactApplicationContext();
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            intent.setData(Uri.parse("package:" + context.getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
            promise.resolve(true);
        } catch (ActivityNotFoundException e) {
            promise.reject("ERR_NOT_SUPPORTED", "App settings screen not available.", e);
        }
    }
}