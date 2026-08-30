import GLib from 'gi://GLib';

import {DEBUG_MODE} from './config.js';

const _times = new Map<string, number>();

export function logTime(label: string | (() => string)) {
    if (DEBUG_MODE) {
        const str = typeof label === 'function' ? label() : label;
        _times.set(str, GLib.get_monotonic_time());
    }
}

export function logTimeEnd(label: string | (() => string)) {
    if (DEBUG_MODE) {
        const str = typeof label === 'function' ? label() : label;
        const start = _times.get(str);
        if (start !== undefined) {
            const end = GLib.get_monotonic_time();
            const ms = (end - start) / 1000;
            console.log(
                `[Rounded Window Corners] [PERF] ${str}: ${ms.toFixed(3)}ms`,
            );
            _times.delete(str);
        }
    }
}

/**
 * Log a message with a [Rounded Window Corners] prefix, but only
 * when debug mode is enabled.
 */
export function logDebug(...args: unknown[]) {
    if (DEBUG_MODE) {
        const resolved = args.map(a => (typeof a === 'function' ? a() : a));
        console.log(`[Rounded Window Corners] ${resolved.join(' ')}`);
    }
}

/**
 * Log an error with a [Rounded Window Corners] prefix.
 */
export function logError(...args: unknown[]) {
    const resolved = args.map(a => (typeof a === 'function' ? a() : a));
    console.error(`[Rounded Window Corners] ${resolved.join(' ')}`);
}
