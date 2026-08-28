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
import type Meta from 'gi://Meta';
import type {RoundedWindowActor} from '../utils/types.js';

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {RoundedCornersEffect} from '../effect/rounded_corners_effect.js';
import {ROUNDED_CORNERS_EFFECT} from '../utils/constants.js';
import {logDebug, logTime, logTimeEnd} from '../utils/log.js';
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
    
    logTime(`onAddEffect`);

    logDebug(`Adding effect to window`);

    // 1. Guard against 0x0 or invalid Wine/Proton windows
    const frameRect = win.get_frame_rect();
    if (
        frameRect.width <= 0 ||
        frameRect.height <= 0 ||
        actor.width <= 0 ||
        actor.height <= 0
    ) {
        logDebug(`Skipping window: Invalid geometry (0x0)`);
        logTimeEnd(`onAddEffect`);
        return;
    }

    const windowState = {
        maximized: win.maximizedHorizontally || win.maximizedVertically,
        fullscreen: win.fullscreen
    };

    // 2. Guard against windows that shouldn't have the effect
    if (!shouldEnableEffect(win, windowState)) {
        logDebug(`Skipping window`);
        logTimeEnd(`onAddEffect`);
        return;
    }

    // 3. Guard against duplicate effect applications or leaked shadows
    if (windowStateMap.has(actor) || getRoundedCornersEffect(actor)) {
        logDebug(`Skipping window: Effect already applied`);
        logTimeEnd(`onAddEffect`);
        return;
    }

    unwrapActor(actor)?.add_effect_with_name(
        ROUNDED_CORNERS_EFFECT,
        new RoundedCornersEffect(),
    );

    // Compute & cache Wayland shadow insets once per window instead of on every resize.
    const cachedShadowInsets = computeShadowInsets(win);
    const state = {
        unminimizedTimeoutId: 0,
        cachedShadowInsets,
    };

    windowStateMap.set(actor, state);
    managedActors.add(actor);

    const effect = getRoundedCornersEffect(actor);
    if (effect) {
        updateEffectUniforms(actor, win, effect, state, frameRect, windowState);
    }
    
    logTimeEnd(`onAddEffect`);
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
    
    logTime(`refreshRoundedCorners`);

    const frameRect = prefetchedFrameRect ?? win.get_frame_rect();
    if (
        frameRect.width <= 0 ||
        frameRect.height <= 0 ||
        actor.width <= 0 ||
        actor.height <= 0
    ) {
        logDebug(`Skipping window: Invalid geometry (0x0)`);
        logTimeEnd(`refreshRoundedCorners`);
        return;
    }

    const windowState = {
        maximized: win.maximizedHorizontally || win.maximizedVertically,
        fullscreen: win.fullscreen
    };

    const shouldHaveEffect = shouldEnableEffect(win, windowState);
    if (!shouldHaveEffect) {
        onRemoveEffect(actor);
        logTimeEnd(`refreshRoundedCorners`);
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
        logTimeEnd(`refreshRoundedCorners`);
        return;
    }

    updateEffectUniforms(actor, win, effect, state, frameRect, windowState);
    
    logTimeEnd(`refreshRoundedCorners`);
}

function updateEffectUniforms(
    actor: RoundedWindowActor,
    win: Meta.Window,
    effect: InstanceType<typeof RoundedCornersEffect>,
    state: { cachedShadowInsets?: any },
    frameRect: Mtk.Rectangle,
    windowState?: {maximized: boolean, fullscreen: boolean}
): void {
    if (!effect.enabled) {
        effect.enabled = true;
    }

    const windowContentOffset = computeWindowContentsOffset(win, frameRect);
    const maximized = windowState ? windowState.maximized : (win.maximizedHorizontally || win.maximizedVertically);
    const fullscreen = windowState ? windowState.fullscreen : win.fullscreen;
    const showBorder = !(maximized || fullscreen);

    let shadowSettings = win.appears_focused ? FOCUSED_SHADOW : UNFOCUSED_SHADOW;

    // If a Wayland window has no native padding (buffer == frame) and no CSD insets,
    // we cannot draw shadows because the shader cannot draw outside the buffer.
    // Instead of complex vertex expansion, we just disable the shadow by zeroing opacity.
    if (showBorder && !state.cachedShadowInsets) {
        const bufferRect = win.get_buffer_rect();
        if (bufferRect.width === frameRect.width) {
            shadowSettings = shadowSettings.map(s => ({ ...s, opacity: 0 })) as typeof shadowSettings;
        }
    }

    effect.updateUniforms(
        computeBounds(actor, windowContentOffset, state.cachedShadowInsets),
        showBorder,
        shadowSettings
    );
}
