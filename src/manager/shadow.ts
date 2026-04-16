/**
 * @file Manages the complete lifecycle of a window's drop shadow actor.
 *
 * Responsibilities:
 *  - Creating the `St.Bin` shadow actor and inserting it into the window group
 *  - Refreshing the shadow CSS whenever focus or window state changes
 *  - Computing and applying the final CSS style string, with a style-key cache
 *    to skip redundant redraws
 *
 * The shadow actor is a plain CSS box with a `box-shadow` rule applied to its
 * inner child.  A {@link ClipShadowEffect} is attached to prevent the shadow
 * from spilling outside the window group (see the linked GNOME Shell bug).
 */

import type Meta from 'gi://Meta';
import type {RoundedWindowActor} from '../utils/types.js';
import type {WindowEffectState} from './window_state.js';

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {ClipShadowEffect} from '../effect/clip_shadow_effect.js';
import {boxShadowCss} from '../utils/box_shadow.js';
import {
    FOCUSED_SHADOW,
    GLOBAL_ROUNDED_CORNER_SETTINGS,
    KEEP_SHADOW_FOR_MAXIMIZED_FULLSCREEN,
    UNFOCUSED_SHADOW,
} from '../utils/config.js';
import {CLIP_SHADOW_EFFECT, SHADOW_PADDING} from '../utils/constants.js';
import {getRoundedCornersCfg} from './actor_helpers.js';
import {windowStateMap} from './window_state.js';

// ---------------------------------------------------------------------------
// Shadow actor creation
// ---------------------------------------------------------------------------

/**
 * Build a shadow actor for `actor`, insert it below the window in the window
 * group, and return it.
 *
 * The shadow is a two-level `St.Bin` hierarchy:
 *   outer (`St.Bin`, name "Shadow Actor") — carries the padding and BindConstraints
 *   └─ inner (`St.Bin`, style class "shadow") — carries the CSS `box-shadow`
 *
 * @param actor - The window actor to create the shadow for.
 */
export function createShadow(actor: Meta.WindowActor): St.Bin {
    const shadow = new St.Bin({
        name: 'Shadow Actor',
        child: new St.Bin({
            xExpand: true,
            yExpand: true,
        }),
    });
    (shadow.firstChild as St.Bin).add_style_class_name('shadow');

    // Attach state early so refreshShadow can read it.
    windowStateMap.set(actor, {
        shadow,
        unminimizedTimeoutId: 0,
        propertyBindings: [],
    });
    refreshShadow(actor as RoundedWindowActor);

    // Clip the shadow to prevent it from spilling outside the window group.
    // https://gitlab.gnome.org/GNOME/gnome-shell/-/issues/4474
    shadow.add_effect_with_name(CLIP_SHADOW_EFFECT, new ClipShadowEffect());

    // Place the shadow below the window actor in the scene graph.
    global.windowGroup.insert_child_below(shadow, actor);

    // Bind position and size from the window actor to the shadow actor.
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

// ---------------------------------------------------------------------------
// Shadow refresh
// ---------------------------------------------------------------------------

/**
 * Re-apply the shadow CSS to reflect the current focus state and rounded
 * corner settings of `actor`.
 *
 * @param actor - The managed window actor whose shadow should be refreshed.
 */
export function refreshShadow(actor: RoundedWindowActor): void {
    const win = actor.metaWindow;
    const state = windowStateMap.get(actor);
    if (!state?.shadow) {
        return;
    }

    const shadowSettings = win.appears_focused
        ? FOCUSED_SHADOW
        : UNFOCUSED_SHADOW;

    const {borderRadius, padding} = getRoundedCornersCfg(win);

    updateShadowActorStyle(
        win,
        state.shadow,
        borderRadius,
        shadowSettings,
        padding,
        state,
    );
}

// ---------------------------------------------------------------------------
// Shadow CSS styling
// ---------------------------------------------------------------------------

/**
 * Compute and apply the CSS style to a shadow actor, using a style-key cache
 * to skip redundant redraws when nothing has changed.
 *
 * @param win           - The window the shadow belongs to.
 * @param actor         - The outer shadow `St.Bin`.
 * @param borderRadius  - Outer corner radius (pixels).
 * @param shadow        - Box-shadow configuration.
 * @param padding       - Window padding configuration.
 * @param state         - Optional {@link WindowEffectState} used as the CSS cache.
 */
export function updateShadowActorStyle(
    win: Meta.Window,
    actor: St.Bin,
    borderRadius = GLOBAL_ROUNDED_CORNER_SETTINGS.borderRadius,
    shadow = FOCUSED_SHADOW,
    padding = GLOBAL_ROUNDED_CORNER_SETTINGS.padding,
    state?: Pick<WindowEffectState, 'lastShadowStyle' | 'lastShadowStyleKey'>,
): void {
    const {left, right, top, bottom} = padding;

    // Scale border radius when smoothing is enabled.
    let adjustedBorderRadius = borderRadius;
    if (GLOBAL_ROUNDED_CORNER_SETTINGS !== null) {
        adjustedBorderRadius *= 1.0 + GLOBAL_ROUNDED_CORNER_SETTINGS.smoothing;
    }

    const actorStyle = `padding: ${SHADOW_PADDING}px;`;
    if (actor.style !== actorStyle) {
        actor.style = actorStyle;
    }

    const child = actor.firstChild as St.Bin;

    const hideShadow =
        !KEEP_SHADOW_FOR_MAXIMIZED_FULLSCREEN &&
        (win.maximizedHorizontally ||
            win.maximizedVertically ||
            win.fullscreen);

    const shadowStyleKey = hideShadow
        ? `hidden|${actorStyle}`
        : `visible|${actorStyle}|${adjustedBorderRadius}|${shadow.horizontalOffset}|${shadow.verticalOffset}|${shadow.blurOffset}|${shadow.spreadRadius}|${shadow.opacity}|${left}|${right}|${top}|${bottom}`;

    // Early-exit: key matches AND the child style hasn't been overwritten externally.
    if (
        state?.lastShadowStyleKey === shadowStyleKey &&
        child.style === state.lastShadowStyle
    ) {
        return;
    }

    const newChildStyle = hideShadow
        ? 'opacity: 0;'
        : `background: white;
           border-radius: ${adjustedBorderRadius}px;
           ${boxShadowCss(shadow)};
               margin: ${top}px ${right}px ${bottom}px ${left}px;`;

    if (state && state.lastShadowStyle !== newChildStyle) {
        child.style = newChildStyle;
        state.lastShadowStyle = newChildStyle;
        state.lastShadowStyleKey = shadowStyleKey;
        child.queue_redraw();
    } else if (state) {
        state.lastShadowStyleKey = shadowStyleKey;
    } else if (!state && child.style !== newChildStyle) {
        child.style = newChildStyle;
        child.queue_redraw();
    }
}
