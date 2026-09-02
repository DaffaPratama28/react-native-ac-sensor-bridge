package com.irhomebridge.service;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

/**
 * True Android foreground service, per project spec — NOT a JS-library
 * background task (those are OS-throttled and insufficient here).
 *
 * This service does not itself perform BLE scanning. Its sole job is to
 * hold a foreground-priority process AND a partial wake lock so Android
 * doesn't kill/throttle the app or let the CPU sleep (and with it, the
 * existing react-native-ble-plx scan already running on the JS side)
 * when the app is backgrounded or the screen is off. A foreground
 * service alone keeps the process alive but does NOT keep the CPU
 * awake — confirmed by this project's own testing (worked fine
 * backgrounded with screen on, went silent with screen off) — hence the
 * explicit wake lock below.
 *
 * Starting/stopping this service is exposed to JS via
 * ForegroundServiceModule. It also stops itself via onTaskRemoved() when
 * the user swipes the app away from Recents, since a native Service
 * started this way is NOT automatically tied to the app's JS/Activity
 * lifecycle and would otherwise keep running (with its notification)
 * indefinitely after the app is closed.
 */
public class MijiaForegroundService extends Service {

    private static final String CHANNEL_ID = "irhomebridge_monitoring";
    private static final String CHANNEL_NAME = "IR Home Bridge Monitoring";
    private static final int NOTIFICATION_ID = 1001;
    private static final String WAKE_LOCK_TAG = "IRHomeBridge::MonitoringWakeLock";

    /** Set in onStartCommand() (not onCreate()) so every explicit start
     * — even of an already-running service instance — resets the
     * elapsed-time display, rather than continuing a stale one. */
    private long serviceStartTimeMillis;

    @Nullable
    private PowerManager.WakeLock wakeLock;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        acquireWakeLock();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        serviceStartTimeMillis = System.currentTimeMillis();
        startForeground(NOTIFICATION_ID, buildNotification());
        // START_STICKY: if the OS kills the process under memory pressure,
        // it will attempt to recreate the service (with a null intent) —
        // appropriate for a monitoring service that should keep running.
        return START_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // Fired when the user swipes the app away from Recents. Without
        // this, the service (and its notification) would keep running
        // indefinitely, independent of the JS/Activity lifecycle that
        // already stopped when the task was removed.
        stopSelf();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        // Explicitly remove the notification on teardown rather than
        // relying on implicit stop-service behavior, which has varied
        // across Android versions historically.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(Service.STOP_FOREGROUND_REMOVE);
        } else {
            stopForeground(true);
        }
        releaseWakeLock();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        // Not a bound service — JS controls this purely via
        // start/stop Intents through ForegroundServiceModule.
        return null;
    }

    private void acquireWakeLock() {
        PowerManager powerManager = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (powerManager == null) {
            return;
        }
        wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_LOCK_TAG);
        // No timeout: held for as long as this service runs, released
        // explicitly in onDestroy(). PARTIAL_WAKE_LOCK keeps the CPU
        // running without turning the screen on — exactly what's needed
        // to keep BLE scan callbacks and JS execution alive with the
        // screen off, without draining battery on display.
        wakeLock.acquire();
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
        wakeLock = null;
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    CHANNEL_NAME,
                    NotificationManager.IMPORTANCE_LOW // low: no sound/heads-up, this is a persistent status notification
            );
            channel.setDescription("Keeps sensor monitoring and AC automation running in the background.");

            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }

    private Notification buildNotification() {
        Intent launchIntent = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent contentIntent = null;
        if (launchIntent != null) {
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                flags |= PendingIntent.FLAG_IMMUTABLE;
            }
            contentIntent = PendingIntent.getActivity(this, 0, launchIntent, flags);
        }

        // Proper monochrome notification icon (ic_notification.png,
        // generated from the app icon's linework, transparent otherwise)
        // — Android notification icons must be flat white silhouettes;
        // using the full-color launcher icon here renders poorly/gets
        // auto-tinted into a solid blob on most Android versions.
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("IR Home Bridge")
                .setContentText("Monitoring sensor and automating AC")
                .setSmallIcon(com.irhomebridge.R.drawable.ic_notification)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setWhen(serviceStartTimeMillis)
                .setUsesChronometer(true); // Android auto-ticks an elapsed-time display from setWhen() — no manual updates needed.

        if (contentIntent != null) {
            builder.setContentIntent(contentIntent);
        }

        return builder.build();
    }

    /** Convenience for ForegroundServiceModule to build the start Intent. */
    public static Intent createStartIntent(Context context) {
        return new Intent(context, MijiaForegroundService.class);
    }
}