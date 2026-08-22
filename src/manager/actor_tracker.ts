/**
 * @file Manages the lifecycle of individual window actors within the
 * rounded-corners extension — tracking which actors are alive, initialized,
 * pending, and coordinating effect application/removal.
 *
 * All per-actor WeakMap/WeakSet state lives here, keeping
 * {@link event_manager.ts} focused on pure signal wiring.
 */

import type Meta from 'gi://Meta';
import type {RoundedWindowActor} from '../utils/types.js';

import GLib from 'gi://GLib';

import {logDebug} from '../utils/log.js';
import {isPermanentlyIneligible} from './eligibility.js';
import * as handlers from './event_handlers.js';
import {ActorSignalManager} from './signal_manager.js';

// ---------------------------------------------------------------------------
// Per-actor tracking state
// ---------------------------------------------------------------------------

let pendingEffectApplications: WeakMap<Meta.WindowActor, number>;
let pendingResizeUpdates: WeakMap<RoundedWindowActor, number>;
let pendingWmClassListeners: WeakMap<Meta.Window, number>;
let initializedActors: WeakSet<RoundedWindowActor>;
let destroyedActors: WeakSet<Meta.WindowActor>;

let actorSignals: ActorSignalManager | null = null;

// ---------------------------------------------------------------------------
// Module lifecycle
// ---------------------------------------------------------------------------

/** Initialize all tracking state. Call once from {@link enableEffect}. */
export function init(): void {
    pendingEffectApplications = new WeakMap();
    pendingResizeUpdates = new WeakMap();
    pendingWmClassListeners = new WeakMap();
    initializedActors = new WeakSet();
    destroyedActors = new WeakSet();
    actorSignals = new ActorSignalManager();
}

/** Tear down all tracking state. Call once from {@link disableEffect}. */
export function shutdown(): void {
    actorSignals = null;
}

// ---------------------------------------------------------------------------
// Window creation / destruction (called from event_manager signal handlers)
// ---------------------------------------------------------------------------

/**
 * Handle a newly created window: schedule the effect application, waiting
 * for the WM class to resolve if necessary.
 */
export function onWindowCreated(win: Meta.Window): void {
    const actor = win.get_compositor_private() as Meta.WindowActor;

    // If there's already a pending application for this actor, don't pile on.
    if (pendingEffectApplications.has(actor)) return;

    const scheduleApply = () => {
        // Bail out immediately if the actor is already in the process of being destroyed
        if (!isAlive(actor)) return;
        if (pendingEffectApplications.has(actor)) return;

        const idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            pendingEffectApplications.delete(actor);

            // Double-check inside the idle loop
            if (!isAlive(actor)) return GLib.SOURCE_REMOVE;

            applyEffectTo(actor as RoundedWindowActor);
            return GLib.SOURCE_REMOVE;
        });
        pendingEffectApplications.set(actor, idleId);
    };

    // If wm_class_instance of Meta.Window is null, wait for it to be
    // set before applying the effect.
    if (win.get_wm_class_instance() == null) {
        const notifyId = win.connect('notify::wm-class', () => {
            win.disconnect(notifyId);
            pendingWmClassListeners.delete(win);
            scheduleApply();
        });
        pendingWmClassListeners.set(win, notifyId);
    } else {
        scheduleApply();
    }
}

/**
 * Handle a window being destroyed by the window manager: cancel any pending
 * idle callbacks and mark the actor as dead.
 */
export function onWindowDestroyed(actor: Meta.WindowActor): void {
    // Mark the actor as dead immediately so any pending idle
    // callbacks can bail out via the fast-path in isAlive()
    // without touching the disposed GObject.
    destroyedActors.add(actor);

    const win = actor.metaWindow;

    // Clean up the wm-class listener if the window is destroyed before the class resolves
    if (win) {
        const notifyId = pendingWmClassListeners.get(win);
        if (notifyId) {
            win.disconnect(notifyId);
            pendingWmClassListeners.delete(win);
        }
    }

    const idleId = pendingEffectApplications.get(actor);
    if (idleId) {
        GLib.source_remove(idleId);
        pendingEffectApplications.delete(actor);
    }
}

// ---------------------------------------------------------------------------
// Effect application / removal
// ---------------------------------------------------------------------------

export function applyEffectTo(actor: RoundedWindowActor): void {
    // Bail out immediately if the actor has been destroyed
    if (!isAlive(actor)) {
        return;
    }

    // Prevent double-initialization of signals
    if (initializedActors.has(actor)) {
        return;
    }

    if (!actor.firstChild) {
        const signalId = actorSignals!.connect(
            actor,
            actor,
            'notify::first-child',
            () => {
                actorSignals!.disconnect(actor, signalId);
                applyEffectTo(actor);
            },
        );
        return;
    }

    const texture = actor.get_texture();
    const metaWindow = actor.metaWindow;

    if (!(texture && metaWindow)) {
        return;
    }

    if (isPermanentlyIneligible(metaWindow)) {
        logDebug(
            `Skipping ${metaWindow.title} (Permanently Ineligible on Initialization)`,
        );
        return;
    }

    // Flag as initialized before binding the massive signal list
    initializedActors.add(actor);

    // --- FIX: Prevent GC Sweep Crashes on MetaShapedTexture ---
    // If the texture is replaced or destroyed, we must proactively disconnect
    // its signals before the garbage collector sweeps it.
    actorSignals!.connect(actor, actor, 'notify::first-child', () => {
        if (actor.get_texture() !== texture) {
            removeEffectFrom(actor);
            applyEffectTo(actor);
        }
    });

    // Window resized.
    //
    // The signal has to be connected both to the actor and the texture. Why is
    // that? I have no idea. But without that, weird bugs can happen. For
    // example, when using Dash to Dock, all opened windows will be invisible
    // *unless they are pinned in the dock*. So yeah, GNOME is magic.
    actorSignals!.connect(actor, actor, 'notify::size', () =>
        throttledResizeHandler(actor),
    );
    actorSignals!.connect(actor, texture, 'size-changed', () =>
        throttledResizeHandler(actor),
    );

    // Get notified about fullscreen explicitly, since a window must not change in
    // size to go fullscreen
    actorSignals!.connect(actor, metaWindow, 'notify::fullscreen', () =>
        throttledResizeHandler(actor),
    );

    // Focus / Workspace changes
    actorSignals!.connect(actor, metaWindow, 'notify::appears-focused', () =>
        handleFocusChanged(actor),
    );

    // Workspace or monitor of the window changed.
    actorSignals!.connect(actor, metaWindow, 'workspace-changed', () =>
        handleFocusChanged(actor),
    );

    // Parent actor destruction covers normal window closing
    actorSignals!.connect(actor, actor, 'destroy', () => {
        destroyedActors.add(actor);
        removeEffectFrom(actor);
    });

    handlers.onAddEffect(actor);
}

export function removeEffectFrom(actor: RoundedWindowActor): void {
    initializedActors.delete(actor);

    // Intercept and destroy the background resize task so it doesn't
    // accidentally resurrect the shadow after the window is closed.
    const resizeIdleId = pendingResizeUpdates.get(actor);
    if (resizeIdleId) {
        GLib.source_remove(resizeIdleId);
        pendingResizeUpdates.delete(actor);
    }

    actorSignals?.disconnectAll(actor);
    handlers.onRemoveEffect(actor);
}

// ---------------------------------------------------------------------------
// Throttled event handlers
// ---------------------------------------------------------------------------

/**
 * Throttles rapid size updates (e.g., window dragging) to a single idle frame.
 */
function throttledResizeHandler(actor: RoundedWindowActor): void {
    if (!isAlive(actor)) return;

    if (actor.metaWindow && isPermanentlyIneligible(actor.metaWindow)) {
        logDebug(
            `Optimization skip triggered: Detaching signals and removing effect from ${actor.metaWindow.title}`,
        );
        removeEffectFrom(actor);
        return;
    }

    if (pendingResizeUpdates.has(actor)) return;

    const idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        pendingResizeUpdates.delete(actor);

        // Prevent the callback from running if the actor was destroyed between
        // the event firing and this idle frame executing.
        if (!isAlive(actor)) {
            return GLib.SOURCE_REMOVE;
        }

        handlers.onSizeChanged(actor);
        return GLib.SOURCE_REMOVE;
    });

    pendingResizeUpdates.set(actor, idleId);
}

function handleFocusChanged(actor: RoundedWindowActor): void {
    if (!isAlive(actor)) return;

    if (actor.metaWindow && isPermanentlyIneligible(actor.metaWindow)) {
        logDebug(
            `Optimization skip triggered: Detaching signals and removing effect from ${actor.metaWindow.title}`,
        );
        removeEffectFrom(actor);
        return;
    }
    handlers.onFocusChanged(actor);
}

// ---------------------------------------------------------------------------
// Bulk cleanup (called from disableEffect)
// ---------------------------------------------------------------------------

/**
 * Cancel all pending callbacks and remove the effect from every tracked actor.
 */
export function cleanupAllActors(): void {
    for (const actor of global.get_window_actors()) {
        const id = pendingEffectApplications.get(actor as Meta.WindowActor);
        if (id) {
            GLib.source_remove(id);
            pendingEffectApplications.delete(actor as Meta.WindowActor);
        }

        const win = (actor as Meta.WindowActor).metaWindow;
        if (win) {
            const notifyId = pendingWmClassListeners.get(win);
            if (notifyId) {
                if (isAlive(win)) {
                    win.disconnect(notifyId);
                }
                pendingWmClassListeners.delete(win);
            }
        }

        removeEffectFrom(actor as RoundedWindowActor);
    }
}

// ---------------------------------------------------------------------------
// GObject liveness check
// ---------------------------------------------------------------------------

function isAlive(obj: any): boolean {
    // Fast-path: if we already know this object has been destroyed via our
    // own bookkeeping, avoid touching the GObject at all.  This prevents GJS
    // from logging a noisy "Object … has been already disposed" warning to
    // the system journal even though the exception would be caught below.
    if (destroyedActors.has(obj)) {
        return false;
    }
    try {
        return !obj?.is_destroyed?.();
    } catch {
        // GJS throws when accessing any property on a disposed GObject.
        // Optional chaining cannot prevent this because the proxy trap
        // fires before `?.` can short-circuit. The thrown error itself
        // confirms the object is dead.
        return false;
    }
}
