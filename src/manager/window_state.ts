/**
 * @file Holds the shared runtime state that tracks which window actors are
 * currently managed by the extension and what effect-related data is
 * associated with each one.
 *
 * Keeping this in its own module avoids circular imports between
 * event_handlers.ts and shadow.ts, both of which need to read/write this
 * state.
 */

import type GObject from 'gi://GObject';
import type Meta from 'gi://Meta';
import type St from 'gi://St';
import type {RoundedWindowActor} from '../utils/types.js';

/** Per-window state managed by the extension for each rounded-corners actor. */
export interface WindowEffectState {
    shadow: St.Bin;
    unminimizedTimeoutId: number;
    propertyBindings: GObject.Binding[];
    /** Last rendered shadow CSS string — used to skip redundant style updates. */
    lastShadowStyle?: string;
    /** Cache key for the last shadow style — avoids recomputing unchanged styles. */
    lastShadowStyleKey?: string;
}

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
