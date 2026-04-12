/**
 * @file Hardcoded extension configuration (former GSettings defaults).
 */

import type {
    BoxShadow,
    CustomRoundedCornerSettings,
    RoundedCornerSettings,
} from './types.js';

/** Former `global-rounded-corner-settings` default. */
export const GLOBAL_ROUNDED_CORNER_SETTINGS: RoundedCornerSettings = {
    keepRoundedCorners: {
        maximized: false,
        fullscreen: false,
    },
    borderRadius: 15,
    smoothing: 0,
    padding: {
        left: 1,
        right: 1,
        top: 1,
        bottom: 1,
    },
    borderColor: [0.2, 0.2, 0.2, 1.0],
    enabled: true,
};

/** Former `custom-rounded-corner-settings` default. */
export const CUSTOM_ROUNDED_CORNER_SETTINGS: CustomRoundedCornerSettings = {};

export const FOCUSED_SHADOW: BoxShadow = {
    horizontalOffset: 0,
    verticalOffset: 4,
    blurOffset: 28,
    spreadRadius: 4,
    opacity: 60,
};

export const UNFOCUSED_SHADOW: BoxShadow = {
    horizontalOffset: 0,
    verticalOffset: 2,
    blurOffset: 12,
    spreadRadius: -1,
    opacity: 65,
};

export const BLACKLIST: string[] = [];
/** When false, blacklist entries are excluded from rounding. */
export const WHITELIST_MODE = false;
export const SKIP_LIBADWAITA_APP = true;
export const SKIP_LIBHANDY_APP = false;
export const BORDER_WIDTH = 0;
export const KEEP_SHADOW_FOR_MAXIMIZED_FULLSCREEN = false;
export const DEBUG_MODE = false;
export const TWEAK_KITTY_TERMINAL = false;
