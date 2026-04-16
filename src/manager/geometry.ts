/**
 * @file Pure geometry helpers for computing window and shadow bounds.
 *
 * All functions here are stateless mathematical transformations — they accept
 * window/actor data and return plain numeric values, with no side effects or
 * I/O.
 */

import Meta from 'gi://Meta';
import type {Bounds} from '../utils/types.js';

import {SHADOW_PADDING} from '../utils/constants.js';

/**
 * Compute the outer bounds that the rounded-corner shader should clip to.
 *
 * For Wayland windows that embed their own client-side shadows (e.g. Kitty,
 * JetBrains IDEs), additional insets are applied to exclude those shadows from
 * the clipping region.
 *
 * @param actor - The window actor.
 * @param [x, y, width, height] - Content offsets returned by
 *        {@link computeWindowContentsOffset}.
 */
export function computeBounds(
    actor: Meta.WindowActor,
    [x, y, width, height]: [number, number, number, number],
): Bounds {
    const bounds = {
        x1: x + 1,
        y1: y + 1,
        x2: x + actor.width + width,
        y2: y + actor.height + height,
    };

    const win = actor.metaWindow;

    // Only Wayland clients with custom decorations need manual shadow clipping.
    if (win.get_client_type() !== Meta.WindowClientType.WAYLAND) {
        return bounds;
    }

    const wmClass = win.get_wm_class_instance()?.toLowerCase() ?? '';
    let shadows: number[] | undefined;

    if (wmClass === 'kitty') {
        shadows = [11, 35, 11, 11];
    } else if (wmClass.startsWith('jetbrains-')) {
        shadows = [18, 18, 18, 18];
    }

    if (shadows) {
        const [x1, y1, x2, y2] = shadows;
        bounds.x1 += x1;
        bounds.y1 += y1;
        bounds.x2 -= x2;
        bounds.y2 -= y2;
    }

    return bounds;
}

/**
 * Compute the offset of the actual window contents from the full window
 * buffer rectangle.
 *
 * GNOME windows have a buffer rect that may be larger than the visible frame
 * (e.g. due to server-side decorations or client-side shadows). This function
 * returns the delta so callers can work in frame coordinates.
 *
 * @param window - The window to compute the offset for.
 * @returns `[x, y, width, height]` offsets from buffer to frame.
 */
export function computeWindowContentsOffset(
    window: Meta.Window,
): [number, number, number, number] {
    const bufferRect = window.get_buffer_rect();
    const frameRect = window.get_frame_rect();
    return [
        frameRect.x - bufferRect.x,
        frameRect.y - bufferRect.y,
        frameRect.width - bufferRect.width,
        frameRect.height - bufferRect.height,
    ];
}

/**
 * Compute the position and size offsets to apply to a shadow actor so it
 * correctly underlaps the window with the configured {@link SHADOW_PADDING}.
 *
 * @param [offsetX, offsetY, offsetWidth, offsetHeight] - Content offsets
 *        returned by {@link computeWindowContentsOffset}.
 * @returns `[x, y, width, height]` offsets to set on the shadow's
 *          `BindConstraint`s.
 */
export function computeShadowActorOffset(
    [offsetX, offsetY, offsetWidth, offsetHeight]: [
        number,
        number,
        number,
        number,
    ],
): number[] {
    return [
        offsetX - SHADOW_PADDING,
        offsetY - SHADOW_PADDING,
        2 * SHADOW_PADDING + offsetWidth,
        2 * SHADOW_PADDING + offsetHeight,
    ];
}
