import { MijiaScanner } from './scanner';

/**
 * Single shared instance — App.tsx starts/stops it, RemoteControlScreen
 * reads live temp/humidity and elapsed/remaining scan time from the same
 * instance rather than creating its own (which would mean two independent
 * scan sessions / duplicate BLE listeners).
 */
export const scanner = new MijiaScanner();
