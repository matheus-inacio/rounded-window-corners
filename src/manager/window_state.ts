/**
 * @file Holds the shared runtime state that tracks which window actors are
 * currently managed by the extension and what effect-related data is
 * associated with each one.
 *
 * Keeping this in its own module avoids circular imports between
 * event_handlers.ts and shadow.ts, both of which need to read/write this
 * state.
 */

import type Clutter from 'gi://Clutter';
import type GObject from 'gi://GObject';
import type Meta from 'gi://Meta';
import type St from 'gi://St';
import type {RoundedWindowActor} from '../utils/types.js';

export type WindowEffectState = {
    unminimizedTimeoutId: number;
    /** Cached Wayland shadow insets for this window (avoids re-computing wm_class each frame). */
    cachedShadowInsets?: readonly number[] | null;
    /** Cached parameters from the last refresh to avoid redundant updates */
    lastRefreshArgs?: {
        actorWidth: number;
        actorHeight: number;
        frameRectX: number;
        frameRectY: number;
        frameRectWidth: number;
        frameRectHeight: number;
        bufferRectX: number;
        bufferRectY: number;
        bufferRectWidth: number;
        bufferRectHeight: number;
        maximized: boolean;
        fullscreen: boolean;
        appearsFocused: boolean;
    };
};

/**
 * Maps each managed window actor to its associated {@link WindowEffectState}.
 *
 * A WeakMap is used so that state is automatically garbage-collected when
 * the actor is destroyed without any explicit clean-up being required.
 */
export const windowStateMap = new WeakMap<
    RoundedWindowActor | Meta.WindowActor,
    WindowEffectState
>();

/**
 * Iterable set of all actors currently managed by the extension.
 *
 * WeakMap cannot be iterated, so this companion Set lets {@link onRestacked}
 * walk every managed actor without keeping strong references unnecessarily
 * (actors are removed from the Set in `onRemoveEffect`).
 */
export const managedActors = new Set<RoundedWindowActor | Meta.WindowActor>();
