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

import type {RoundedWindowActor} from '../utils/types.js';

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import type Mtk from '@girs/mtk-18';

import {RoundedCornersEffect} from '../effect/rounded_corners_effect.js';
import {ROUNDED_CORNERS_EFFECT} from '../utils/constants.js';
import {logDebug} from '../utils/log.js';
import {
    getRoundedCornersEffect,
    unwrapActor,
} from './actor_helpers.js';
import {shouldEnableEffect} from './eligibility.js';
import {
    computeBounds,
    computeShadowActorOffset,
    computeShadowInsets,
    computeWindowContentsOffset,
} from './geometry.js';
import {createShadow, refreshShadow} from './shadow.js';
import {managedActors, windowStateMap} from './window_state.js';
// ---------------------------------------------------------------------------
// Public event handlers
// ---------------------------------------------------------------------------

export function onAddEffect(actor: RoundedWindowActor): void {
    logDebug(`Adding effect to ${actor?.metaWindow.title}`);

    const win = actor.metaWindow;

    // 1. Guard against 0x0 or invalid Wine/Proton windows
    const frameRect = win.get_frame_rect();
    if (frameRect.width <= 0 || frameRect.height <= 0 || actor.width <= 0 || actor.height <= 0) {
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

    const shadow = createShadow(actor);

    // Bind transform properties of the window to the shadow actor so it
    // follows animations (minimize, workspace switch, etc.).
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

    // Compute & cache Wayland shadow insets once per window instead of on every resize.
    const cachedShadowInsets = computeShadowInsets(win);

    // Retrieve the provisional state (already contains shadowConstraints from createShadow)
    // and overwrite it with the full state.
    const provisionalState = windowStateMap.get(actor);
    windowStateMap.set(actor, {
        shadow,
        unminimizedTimeoutId: 0,
        propertyBindings,
        shadowConstraints: provisionalState?.shadowConstraints,
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

    // Unbind all property bindings (including `visible`) immediately so the
    // shadow stops following the window actor's animation state.
    for (const binding of state.propertyBindings) {
        binding.unbind();
    }

    const shadow = state.shadow;
    if (shadow) {
        // Remove constraints so the shadow is no longer driven by the actor.
        shadow.get_constraints().forEach(constraint => {
            shadow.remove_constraint(constraint);
        });

        // Hide immediately so it is not visible during the close animation.
        shadow.visible = false;

        // Defer the actual destruction to the next idle frame.  The window-close
        // animation (≈300 ms) keeps a reference to the window actor and can
        // trigger paint/timeline callbacks on still-connected children.  Destroying
        // the shadow synchronously causes:
        //   • "Timelines with detached actors" — St.Bin removed while animated
        //   • "cogl_framebuffer_set_viewport: width > 0 && height > 0" — FBO
        //     allocated for a zero-size actor during the closing shrink.
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            destroyShadow(shadow);
            return GLib.SOURCE_REMOVE;
        });
    }

    if (state.unminimizedTimeoutId) {
        GLib.source_remove(state.unminimizedTimeoutId);
    }

    managedActors.delete(actor);
    windowStateMap.delete(actor);
}

/**
 * Safely tear down a detached shadow actor.
 *
 * Called from an idle handler so any in-flight Clutter animations on the
 * closing window have already finished their current frame before we destroy
 * the `St.Bin` hierarchy.
 */
function destroyShadow(shadow: St.Bin): void {
    type DestroyCheck = {is_destroyed?: () => boolean};
    if ((shadow as unknown as DestroyCheck).is_destroyed?.()) {
        return;
    }
    try {
        global.windowGroup.remove_child(shadow);
    } catch (_) {
        // Already removed (e.g. extension disabled mid-flight).
    }
    shadow.clear_effects();
    shadow.destroy();
}

export function onMinimize(actor: RoundedWindowActor): void {
    // Compatibility with "Compiz alike magic lamp effect":
    // Disable the shadow during the minimize animation so the lamp effect works.
    const magicLampEffect = actor.get_effect('minimize-magic-lamp-effect');
    const state = windowStateMap.get(actor);
    const roundedCornersEffect = getRoundedCornersEffect(actor);

    if (magicLampEffect && state?.shadow && roundedCornersEffect) {
        state.shadow.visible = false;
        roundedCornersEffect.enabled = false;
    }
}

export function onUnminimize(actor: RoundedWindowActor): void {
    // Compatibility with "Compiz alike magic lamp effect":
    // Wait until the unminimize animation is 98% done before re-showing the shadow.
    const magicLampEffect = actor.get_effect('unminimize-magic-lamp-effect');
    const state = windowStateMap.get(actor);
    const roundedCornersEffect = getRoundedCornersEffect(actor);

    if (magicLampEffect && state?.shadow && roundedCornersEffect) {
        state.shadow.visible = false;
        type Effect = Clutter.Effect & {timerId: Clutter.Timeline};
        const timer = (magicLampEffect as Effect).timerId;

        let disconnected = false;
        const id = timer.connect('new-frame', source => {
            if (source.get_progress() > 0.98 && !disconnected) {
                state.shadow.visible = true;
                roundedCornersEffect.enabled = true;
                source.disconnect(id);
                disconnected = true;
            }
        });
    }
}

export function onRestacked(): void {
    for (const actor of managedActors) {
        const state = windowStateMap.get(actor);

        if (!(actor.visible && state?.shadow)) {
            continue;
        }

        if (actor.get_previous_sibling() !== state.shadow) {
            global.windowGroup.set_child_below_sibling(
                state.shadow,
                actor,
            );
        }
    }
}

/** Alias so event_manager.ts can use a descriptive name. */
export const onSizeChanged = refreshRoundedCorners;

/** Alias so event_manager.ts can use a descriptive name. */
export {refreshShadow as onFocusChanged};

/**
 * Re-evaluate whether the effect should be active for `actor` and update the
 * shader uniforms and shadow `BindConstraint` offsets to match the current
 * window geometry.
 */
function refreshRoundedCorners(
    actor: RoundedWindowActor,
    prefetchedFrameRect?: Mtk.Rectangle): void {
    const win = actor.metaWindow;
    if (!win) return;

    const frameRect = prefetchedFrameRect ?? win.get_frame_rect();
    if (frameRect.width <= 0 || frameRect.height <= 0 || actor.width <= 0 || actor.height <= 0) {
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

    effect.updateUniforms(
        computeBounds(actor, windowContentOffset, state.cachedShadowInsets),
        showBorder,
    );

    // Update BindConstraint offsets so the shadow tracks the new window geometry.
    // Use cached constraint references for direct indexed access — avoids
    // forEach() closure allocation + instanceof type-check per resize event.
    const offsets = computeShadowActorOffset(windowContentOffset);
    const constraints = state.shadowConstraints;
    if (constraints) {
        for (let i = 0; i < 4; i++) {
            const nextOffset = offsets[i];
            if (constraints[i].offset !== nextOffset) {
                constraints[i].offset = nextOffset;
            }
        }
    }
}
