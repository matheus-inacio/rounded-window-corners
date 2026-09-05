/** @file Provides types used throughout the codebase, mostly for storing settings. */
import type Meta from 'gi://Meta';

/** Bounds of rounded corners  */
export type Bounds = {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
};

/** Settings for corner rounding. */
export type RoundedCornerSettings = {
    keepRoundedCorners: {
        maximized: boolean;
        fullscreen: boolean;
    };
    borderRadius: number;
    smoothing: number;
    padding: {
        left: number;
        right: number;
        top: number;
        bottom: number;
    };
    enabled: boolean;
};

/** Rounded corner settings exceptions for specific windows. */
export type CustomRoundedCornerSettings = {
    [wmClass: string]: RoundedCornerSettings;
};

/** Window shadow properties. */
export type BoxShadow = {
    opacity: number;
    spreadRadius: number;
    blurOffset: number;
    verticalOffset: number;
    horizontalOffset: number;
};

/**
 * A window actor with rounded corners.
 *
 * This type acts as an alias to `Meta.WindowActor` to explicitly denote
 * an actor that is managed by the extension and can have effects applied.
 */
export type RoundedWindowActor = Meta.WindowActor;
