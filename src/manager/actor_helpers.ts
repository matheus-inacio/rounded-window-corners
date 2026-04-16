/**
 * @file Pure accessor helpers for GNOME window actors and their rounded-corner
 * effect instances.
 *
 * All functions here are stateless lookups — they read from the actor/window
 * object graph and return a derived value, with no side effects.
 */

import type Clutter from 'gi://Clutter';
import type {RoundedCornersEffect} from '../effect/rounded_corners_effect.js';
import type {RoundedCornerSettings} from '../utils/types.js';

import Meta from 'gi://Meta';

import {
    CUSTOM_ROUNDED_CORNER_SETTINGS,
    GLOBAL_ROUNDED_CORNER_SETTINGS,
} from '../utils/config.js';
import {ROUNDED_CORNERS_EFFECT} from '../utils/constants.js';

// Weird TypeScript magic :)
type RoundedCornersEffectType = InstanceType<typeof RoundedCornersEffect>;

/**
 * Get the actor that rounded corners should be applied to.
 *
 * In Wayland, the effect is applied directly to the `WindowActor`. In X11 it
 * must be applied to `WindowActor.first_child` instead because the actor
 * itself is just a container.
 *
 * @param actor - The window actor to unwrap.
 * @returns The correct actor for the effect, or `null` if the actor has
 *          already been disposed.
 */
export function unwrapActor(actor: Meta.WindowActor): Clutter.Actor | null {
    try {
        // If the C object is already destroyed, reading .metaWindow will throw.
        const type = actor.metaWindow.get_client_type();
        return type === Meta.WindowClientType.X11
            ? actor.get_first_child()
            : actor;
    } catch {
        // Object already disposed.
        return null;
    }
}

/**
 * Get the {@link RoundedCornersEffect} instance currently attached to a
 * window actor, or `null` if none is present.
 *
 * @param actor - The window actor to query.
 */
export function getRoundedCornersEffect(
    actor: Meta.WindowActor,
): RoundedCornersEffectType | null {
    const win = actor.metaWindow;
    const name = ROUNDED_CORNERS_EFFECT;
    return win.get_client_type() === Meta.WindowClientType.X11
        ? (actor.firstChild.get_effect(name) as RoundedCornersEffectType)
        : (actor.get_effect(name) as RoundedCornersEffectType);
}

/**
 * Return the correct rounded-corner settings for a window.
 *
 * If the window has a custom per-`wm_class_instance` override that is
 * explicitly enabled, that override is returned; otherwise the global
 * defaults are used.
 *
 * @param win - The window to look up settings for.
 */
export function getRoundedCornersCfg(win: Meta.Window): RoundedCornerSettings {
    const globalCfg = GLOBAL_ROUNDED_CORNER_SETTINGS;
    const customCfgList = CUSTOM_ROUNDED_CORNER_SETTINGS;

    const wmClass = win.get_wm_class_instance();
    if (
        wmClass == null ||
        !customCfgList[wmClass] ||
        !customCfgList[wmClass].enabled
    ) {
        return globalCfg;
    }

    return customCfgList[wmClass];
}
