/**
 * @file Implements the event handler callbacks that are wired to GNOME Shell
 * signals by {@link event_manager.ts}.
 *
 * This file intentionally owns only handler *orchestration* — the decision of
 * what to do when a specific event fires.  Heavy lifting is delegated to the
 * focused modules:
 *
 *  - {@link actor_helpers.ts} — stateless actor/effect lookups
 *  - {@link geometry.ts}      — bounds and offset maths
 *  - {@link eligibility.ts}   — window eligibility checks
 *  - {@link shadow.ts}        — shadow actor lifecycle
 *  - {@link window_state.ts}  — shared runtime state
 */

import type Clutter from 'gi://Clutter';
import type Mtk from '@girs/mtk-18';
import type {RoundedWindowActor} from '../utils/types.js';

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {RoundedCornersEffect} from '../effect/rounded_corners_effect.js';
import {ROUNDED_CORNERS_EFFECT} from '../utils/constants.js';
import {logDebug} from '../utils/log.js';
import {getRoundedCornersEffect, unwrapActor} from './actor_helpers.js';
import {shouldEnableEffect} from './eligibility.js';
import {
    computeBounds,
    computeShadowInsets,
    computeWindowContentsOffset,
} from './geometry.js';
import {managedActors, windowStateMap} from './window_state.js';
// ---------------------------------------------------------------------------
// Public event handlers
// ---------------------------------------------------------------------------

export function onAddEffect(actor: RoundedWindowActor): void {
    const win = actor?.metaWindow;
    if (!win) {
        logDebug('Skipping effect addition: actor has no metaWindow');
        return;
    }

    logDebug(`Adding effect to ${win.title}`);

    // 1. Guard against 0x0 or invalid Wine/Proton windows
    const frameRect = win.get_frame_rect();
    if (
        frameRect.width <= 0 ||
        frameRect.height <= 0 ||
        actor.width <= 0 ||
        actor.height <= 0
    ) {
        logDebug(`Skipping ${win.title}: Invalid geometry (0x0)`);
        return;
    }

    // 2. Guard against windows that shouldn't have the effect
    if (!shouldEnableEffect(win)) {
        logDebug(`Skipping ${win.title}`);
        return;
    }

    // 3. Guard against duplicate effect applications or leaked shadows
    if (windowStateMap.has(actor) || getRoundedCornersEffect(actor)) {
        logDebug(`Skipping ${win.title}: Effect already applied`);
        return;
    }

    unwrapActor(actor)?.add_effect_with_name(
        ROUNDED_CORNERS_EFFECT,
        new RoundedCornersEffect(),
    );

    // Compute & cache Wayland shadow insets once per window instead of on every resize.
    const cachedShadowInsets = computeShadowInsets(win);

    windowStateMap.set(actor, {
        unminimizedTimeoutId: 0,
        cachedShadowInsets,
    });
    managedActors.add(actor);

    refreshRoundedCorners(actor, frameRect);
}

export function onRemoveEffect(actor: RoundedWindowActor): void {
    const state = windowStateMap.get(actor);

    try {
        unwrapActor(actor)?.remove_effect_by_name(ROUNDED_CORNERS_EFFECT);
    } catch (err) {
        logDebug(`Ignored error during effect removal: ${err}`);
    }

    if (!state) {
        return;
    }

    if (state.unminimizedTimeoutId) {
        GLib.source_remove(state.unminimizedTimeoutId);
    }

    managedActors.delete(actor);
    windowStateMap.delete(actor);
}

export function onMinimize(actor: RoundedWindowActor): void {
    // Compatibility with "Compiz alike magic lamp effect":
    // Disable the shader during the minimize animation so the lamp effect works.
    const magicLampEffect = actor.get_effect('minimize-magic-lamp-effect');
    const roundedCornersEffect = getRoundedCornersEffect(actor);

    if (magicLampEffect && roundedCornersEffect) {
        roundedCornersEffect.enabled = false;
    }
}

export function onUnminimize(actor: RoundedWindowActor): void {
    // Compatibility with "Compiz alike magic lamp effect":
    // Wait until the unminimize animation is 98% done before re-showing the effect.
    const magicLampEffect = actor.get_effect('unminimize-magic-lamp-effect');
    const roundedCornersEffect = getRoundedCornersEffect(actor);

    if (magicLampEffect && roundedCornersEffect) {
        type Effect = Clutter.Effect & {timerId: Clutter.Timeline};
        const timer = (magicLampEffect as Effect).timerId;

        let disconnected = false;
        const id = timer.connect('new-frame', source => {
            if (source.get_progress() > 0.98 && !disconnected) {
                roundedCornersEffect.enabled = true;
                source.disconnect(id);
                disconnected = true;
            }
        });
    }
}

export function onRestacked(): void {
    // No-op. Previously used to re-stack the St.Bin shadow.
}

/** Alias so event_manager.ts can use a descriptive name. */
export const onSizeChanged = refreshRoundedCorners;

import {FOCUSED_SHADOW, UNFOCUSED_SHADOW} from '../utils/config.js';

export function onFocusChanged(actor: RoundedWindowActor): void {
    refreshRoundedCorners(actor);
}

/**
 * Re-evaluate whether the effect should be active for `actor` and update the
 * shader uniforms and shadow `BindConstraint` offsets to match the current
 * window geometry.
 */
function refreshRoundedCorners(
    actor: RoundedWindowActor,
    prefetchedFrameRect?: Mtk.Rectangle,
): void {
    const win = actor.metaWindow;
    if (!win) return;

    const frameRect = prefetchedFrameRect ?? win.get_frame_rect();
    if (
        frameRect.width <= 0 ||
        frameRect.height <= 0 ||
        actor.width <= 0 ||
        actor.height <= 0
    ) {
        logDebug(`Skipping ${win.title}: Invalid geometry (0x0)`);
        return;
    }

    const shouldHaveEffect = shouldEnableEffect(win);
    if (!shouldHaveEffect) {
        onRemoveEffect(actor);
        return;
    }

    const state = windowStateMap.get(actor);
    const effect = getRoundedCornersEffect(actor);

    const hasEffect = effect && state;

    if (!hasEffect) {
        // If the state is partially applied (e.g. effect stripped but state remains),
        // cleanly remove everything before reapplying to prevent leaks.
        if (state || effect) {
            onRemoveEffect(actor);
        }
        onAddEffect(actor);
        return;
    }

    if (!effect.enabled) {
        effect.enabled = true;
    }

    const windowContentOffset = computeWindowContentsOffset(win, frameRect);
    const showBorder = !(
        win.maximizedHorizontally ||
        win.maximizedVertically ||
        win.fullscreen
    );

    let shadowSettings = win.appears_focused ? FOCUSED_SHADOW : UNFOCUSED_SHADOW;

    const bufferRect = win.get_buffer_rect();
    // If a Wayland window has no native padding (buffer == frame) and no CSD insets,
    // we cannot draw shadows because the shader cannot draw outside the buffer.
    // Instead of complex vertex expansion, we just disable the shadow by zeroing opacity.
    if (showBorder && bufferRect.width === frameRect.width && !state.cachedShadowInsets) {
        shadowSettings = shadowSettings.map(s => ({ ...s, opacity: 0 })) as typeof shadowSettings;
    }

    effect.updateUniforms(
        computeBounds(actor, windowContentOffset, state.cachedShadowInsets),
        showBorder,
        shadowSettings
    );
}
