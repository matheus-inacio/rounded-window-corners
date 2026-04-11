/**
 * @file Contains the implementation of handlers for various events that need
 * to be processed by the extension. Those handlers are bound to event signals
 * in effect_manager.ts.
 */

import type Meta from 'gi://Meta';
import type {RoundedWindowActor} from '../utils/types.js';

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {ClipShadowEffect} from '../effect/clip_shadow_effect.js';
import {RoundedCornersEffect} from '../effect/rounded_corners_effect.js';
import {FOCUSED_SHADOW, UNFOCUSED_SHADOW} from '../utils/config.js';
import {CLIP_SHADOW_EFFECT, ROUNDED_CORNERS_EFFECT,} from '../utils/constants.js';
import {logDebug} from '../utils/log.js';
import {
    computeBounds,
    computeShadowActorOffset,
    computeWindowContentsOffset,
    getRoundedCornersCfg,
    getRoundedCornersEffect,
    shouldEnableEffect,
    unwrapActor,
    updateShadowActorStyle,
    windowScaleFactor,
} from './utils.js';

export interface WindowEffectState {
    shadow: St.Bin;
    unminimizedTimeoutId: number;
    propertyBindings: GObject.Binding[];
}

// Safely manages custom state tied to the window actor without mutating the actor itself
export const windowStateMap = new WeakMap<RoundedWindowActor | Meta.WindowActor, WindowEffectState>();

export function onAddEffect(actor: RoundedWindowActor) {
    logDebug(`Adding effect to ${actor?.metaWindow.title}`);

    const win = actor.metaWindow;

    if (!shouldEnableEffect(win)) {
        logDebug(`Skipping ${win.title}`);
        return;
    }

    unwrapActor(actor)?.add_effect_with_name(
        ROUNDED_CORNERS_EFFECT,
        new RoundedCornersEffect(),
    );

    const shadow = createShadow(actor);

    // Bind properties of the window to the shadow actor.
    const propertyBindings: GObject.Binding[] = [];
    for (const prop of [
        'pivot-point',
        'translation-x',
        'translation-y',
        'scale-x',
        'scale-y',
        'visible',
    ]) {
        const binding = actor.bind_property(
            prop,
            shadow,
            prop,
            GObject.BindingFlags.SYNC_CREATE,
        );
        propertyBindings.push(binding);
    }

    // Store state in WeakMap
    windowStateMap.set(actor, {
        shadow,
        unminimizedTimeoutId: 0,
        propertyBindings,
    });

    // Make sure the effect is applied correctly.
    refreshRoundedCorners(actor);
}

export function onRemoveEffect(actor: RoundedWindowActor): void {
    unwrapActor(actor)?.remove_effect_by_name(ROUNDED_CORNERS_EFFECT);

    const state = windowStateMap.get(actor);
    if (!state) {
        return;
    }

    for (const binding of state.propertyBindings) {
        binding.unbind();
    }

    // Remove shadow actor
    const shadow = state.shadow;
    if (shadow) {
        shadow.get_constraints().forEach(constraint => {
            shadow.remove_constraint(constraint);
        });
        global.windowGroup.remove_child(shadow);
        shadow.clear_effects();
        shadow.destroy();
    }

    if (state.unminimizedTimeoutId) {
        GLib.source_remove(state.unminimizedTimeoutId);
    }
    
    windowStateMap.delete(actor);
}

export function onMinimize(actor: RoundedWindowActor): void {
    // Compatibility with "Compiz alike magic lamp effect".
    // When minimizing a window, disable the shadow to make the magic lamp effect
    // work.
    const magicLampEffect = actor.get_effect('minimize-magic-lamp-effect');
    const state = windowStateMap.get(actor);
    const roundedCornersEffect = getRoundedCornersEffect(actor);
    
    if (magicLampEffect && state?.shadow && roundedCornersEffect) {
        state.shadow.visible = false;
        roundedCornersEffect.enabled = false;
    }
}

export function onUnminimize(actor: RoundedWindowActor): void {
    // Compatibility with "Compiz alike magic lamp effect".
    // When unminimizing a window, wait until the effect is completed before
    // showing the shadow.
    const magicLampEffect = actor.get_effect('unminimize-magic-lamp-effect');
    const state = windowStateMap.get(actor);
    const roundedCornersEffect = getRoundedCornersEffect(actor);
    if (magicLampEffect && state?.shadow && roundedCornersEffect) {
        state.shadow.visible = false;
        type Effect = Clutter.Effect & {timerId: Clutter.Timeline};
        const timer = (magicLampEffect as Effect).timerId;

        const id = timer.connect('new-frame', source => {
            // Wait until the effect is 98% completed
            if (source.get_progress() > 0.98) {
                state.shadow.visible = true;
                roundedCornersEffect.enabled = true;
                source.disconnect(id);
            }
        });
    }
}

export function onRestacked(): void {
    for (const actor of global.get_window_actors()) {
        const state = windowStateMap.get(actor);

        if (!(actor.visible && state?.shadow)) {
            continue;
        }

        global.windowGroup.set_child_below_sibling(state.shadow, actor);
    }
}

export const onSizeChanged = refreshRoundedCorners;

export const onFocusChanged = refreshShadow;

/**
 * Create the shadow actor for a window.
 *
 * @param actor - The window actor to create the shadow actor for.
 */
function createShadow(actor: Meta.WindowActor): St.Bin {
    const shadow = new St.Bin({
        name: 'Shadow Actor',
        child: new St.Bin({
            xExpand: true,
            yExpand: true,
        }),
    });
    (shadow.firstChild as St.Bin).add_style_class_name('shadow');

    // Attach to map early so refreshShadow can access it
    windowStateMap.set(actor, { shadow, unminimizedTimeoutId: 0, propertyBindings: [] });
    refreshShadow(actor as RoundedWindowActor);

    // We have to clip the shadow because of this issue:
    // https://gitlab.gnome.org/GNOME/gnome-shell/-/issues/4474
    shadow.add_effect_with_name(CLIP_SHADOW_EFFECT, new ClipShadowEffect());

    // Draw the shadow actor below the window actor.
    global.windowGroup.insert_child_below(shadow, actor);

    // Bind position and size between window and shadow
    for (let i = 0; i < 4; i++) {
        const constraint = new Clutter.BindConstraint({
            source: actor,
            coordinate: i,
            offset: 0,
        });
        shadow.add_constraint(constraint);
    }

    return shadow;
}

/**
 * Refresh the shadow actor for a window.
 *
 * @param actor - The window actor to refresh the shadow for.
 */
function refreshShadow(actor: RoundedWindowActor) {
    const win = actor.metaWindow;
    const state = windowStateMap.get(actor);
    if (!state?.shadow) {
        return;
    }

    const shadowSettings = win.appears_focused
        ? FOCUSED_SHADOW
        : UNFOCUSED_SHADOW;

    const {borderRadius, padding} = getRoundedCornersCfg(win);

    updateShadowActorStyle(win, state.shadow, borderRadius, shadowSettings, padding);
}

/**
 * Refresh rounded corners state and settings for a window.
 *
 * @param actor - The window actor to refresh the rounded corners settings for.
 */
function refreshRoundedCorners(actor: RoundedWindowActor): void {
    const win = actor.metaWindow;
    if (!win) return;

    const state = windowStateMap.get(actor);
    const effect = getRoundedCornersEffect(actor);

    const hasEffect = effect && state;
    const shouldHaveEffect = shouldEnableEffect(win);

    if (!hasEffect) {
        // onAddEffect already skips windows that shouldn't have rounded corners.
        onAddEffect(actor);
        return;
    }

    if (!shouldHaveEffect) {
        onRemoveEffect(actor);
        return;
    }

    if (!effect.enabled) {
        effect.enabled = true;
    }

    // When window size is changed, update uniforms for corner rounding shader.
    const cfg = getRoundedCornersCfg(win);
    const windowContentOffset = computeWindowContentsOffset(win);
    effect.updateUniforms(
        windowScaleFactor(win),
        cfg,
        computeBounds(actor, windowContentOffset),
    );

    // Update BindConstraint for the shadow
    const shadow = state.shadow;
    const offsets = computeShadowActorOffset(actor, windowContentOffset);
    const constraints = shadow.get_constraints();
    constraints.forEach((constraint, i) => {
        if (constraint instanceof Clutter.BindConstraint) {
            constraint.offset = offsets[i];
        }
    });

    refreshShadow(actor);
}
