/** @file Provides wrapper functions for printing out debug messages. */

import {DEBUG_MODE} from './config.js';

/**
 * Log a message with a [Rounded Window Corners] prefix, but only
 * when debug mode is enabled.
 */
export function logDebug(...args: unknown[]) {
    if (DEBUG_MODE) {
        console.log(`[Rounded Window Corners] ${args}`);
    }
}

/**
 * Log an error with a [Rounded Window Corners] prefix.
 */
export function logError(...args: unknown[]) {
    console.error(`[Rounded Window Corners] ${args}`);
}
