package com.irhomebridge.ir;

import android.content.Context;
import android.hardware.ConsumerIrManager;

import androidx.annotation.NonNull;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.ReadableArray;

/**
 * Native bridge to android.hardware.ConsumerIrManager.
 *
 * Exposes a single transmit() method to JS. All validation of the
 * incoming pattern data happens here as well as on the JS side
 * (IRBlaster.ts) — never trust the JS layer alone, since this module
 * could in principle be called directly via NativeModules without
 * going through the typed wrapper.
 */
public class IRBlasterModule extends ReactContextBaseJavaModule {

    private static final String MODULE_NAME = "IRBlasterModule";

    // Error codes surfaced to JS via promise.reject(code, message)
    private static final String ERR_NO_IR_SERVICE = "ERR_NO_IR_SERVICE";
    private static final String ERR_NO_IR_EMITTER = "ERR_NO_IR_EMITTER";
    private static final String ERR_INVALID_FREQUENCY = "ERR_INVALID_FREQUENCY";
    private static final String ERR_INVALID_PATTERN = "ERR_INVALID_PATTERN";
    private static final String ERR_TRANSMIT_FAILED = "ERR_TRANSMIT_FAILED";

    public IRBlasterModule(@NonNull ReactApplicationContext reactContext) {
        super(reactContext);
    }

    @NonNull
    @Override
    public String getName() {
        return MODULE_NAME;
    }

    /**
     * Checks whether this device exposes a ConsumerIrManager AND has a
     * physical emitter. Safe to call before attempting a transmit so the
     * JS layer can degrade gracefully (e.g. disable automation) on
     * hardware without an IR blaster.
     */
    @ReactMethod
    public void hasIrEmitter(Promise promise) {
        ConsumerIrManager irManager = getIrManager();
        if (irManager == null) {
            promise.resolve(false);
            return;
        }
        promise.resolve(irManager.hasIrEmitter());
    }

    /**
     * Transmits a raw IR pulse pattern at the given carrier frequency.
     *
     * @param frequency    carrier frequency in Hz (e.g. 38000 for a
     *                     typical 38kHz AC remote carrier).
     * @param patternArray alternating on/off durations in microseconds,
     *                     starting with an "on" duration. Must be a
     *                     non-empty array of positive integers with an
     *                     even length (ConsumerIrManager requirement).
     */
    @ReactMethod
    public void transmit(int frequency, ReadableArray patternArray, Promise promise) {
        ConsumerIrManager irManager = getIrManager();

        if (irManager == null) {
            promise.reject(ERR_NO_IR_SERVICE, "CONSUMER_IR_SERVICE is not available on this device.");
            return;
        }

        if (!irManager.hasIrEmitter()) {
            promise.reject(ERR_NO_IR_EMITTER, "This device does not have a physical IR emitter.");
            return;
        }

        if (frequency <= 0) {
            promise.reject(ERR_INVALID_FREQUENCY, "Frequency must be a positive integer (Hz). Got: " + frequency);
            return;
        }

        final int[] pattern;
        try {
            pattern = readableArrayToIntArray(patternArray);
        } catch (IllegalArgumentException e) {
            promise.reject(ERR_INVALID_PATTERN, e.getMessage());
            return;
        }

        try {
            irManager.transmit(frequency, pattern);
            promise.resolve(null);
        } catch (RuntimeException e) {
            // ConsumerIrManager.transmit() can throw on some OEM firmwares
            // (e.g. transmit called too rapidly, or a malformed pattern
            // that passed our validation but is still rejected by the
            // underlying HAL).
            promise.reject(ERR_TRANSMIT_FAILED, "Native transmit() failed: " + e.getMessage(), e);
        }
    }

    private ConsumerIrManager getIrManager() {
        ReactApplicationContext context = getReactApplicationContext();
        if (context == null) {
            return null;
        }
        return (ConsumerIrManager) context.getSystemService(Context.CONSUMER_IR_SERVICE);
    }

    /**
     * Converts a ReadableArray of numbers into an int[], validating that
     * every element is present, integral, positive, and that the total
     * length is even (ConsumerIrManager requires alternating on/off
     * durations, so an odd-length pattern is always malformed).
     */
    private int[] readableArrayToIntArray(ReadableArray array) {
        if (array == null) {
            throw new IllegalArgumentException("patternArray is null.");
        }

        int size = array.size();
        if (size == 0) {
            throw new IllegalArgumentException("patternArray must not be empty.");
        }
        if (size % 2 != 0) {
            throw new IllegalArgumentException(
                    "patternArray must have an even number of elements (alternating on/off durations). Got size: " + size);
        }

        int[] result = new int[size];
        for (int i = 0; i < size; i++) {
            if (array.isNull(i)) {
                throw new IllegalArgumentException("patternArray contains a null value at index " + i + ".");
            }

            double raw = array.getDouble(i);
            int value = (int) raw;

            if (value != raw) {
                throw new IllegalArgumentException(
                        "patternArray must contain only integers. Non-integer value at index " + i + ": " + raw);
            }
            if (value <= 0) {
                throw new IllegalArgumentException(
                        "patternArray values must be positive (microsecond durations). Invalid value at index " + i + ": " + value);
            }

            result[i] = value;
        }

        return result;
    }
}
