/**
 * @file Manages connections between gnome shell events and the rounded corners
 * effect. See {@link enableEffect} for more information.
 */

import type GObject from 'gi://GObject';
import type Meta from 'gi://Meta';
import type Shell from 'gi://Shell';
import type {RoundedWindowActor} from '../utils/types.js';

import GLib from 'gi://GLib';

import {logDebug} from '../utils/log.js';
import * as handlers from './event_handlers.js';
import {isPermanentlyIneligible} from './eligibility.js';

const pendingEffectApplications = new WeakMap<Meta.WindowActor, number>();
const pendingResizeUpdates = new WeakMap<RoundedWindowActor, number>();
const pendingWmClassListeners = new WeakMap<Meta.Window, number>();
const initializedActors = new WeakSet<RoundedWindowActor>();

class GlobalSignalManager {
    private connections: { object: GObject.Object; id: number }[] = [];

    connect(object: GObject.Object, signal: string, callback: (...args: any[]) => any) {
        this.connections.push({
            object,
            id: object.connect(signal, callback),
        });
    }

    disconnectAll() {
        for (const conn of this.connections) {
            conn.object.disconnect(conn.id);
        }
        this.connections.length = 0;
    }
}

class ActorSignalManager {
    private connections = new WeakMap<RoundedWindowActor | Meta.WindowActor, { object: GObject.Object; id: number }[]>();

    connect(actor: RoundedWindowActor | Meta.WindowActor, object: GObject.Object, signal: string, callback: (...args: any[]) => any): number {
        const id = object.connect(signal, callback);
        const conns = this.connections.get(actor) || [];
        conns.push({ object, id });
        this.connections.set(actor, conns);
        return id;
    }

    disconnect(actor: RoundedWindowActor | Meta.WindowActor, id: number) {
        const conns = this.connections.get(actor);
        if (conns) {
            const index = conns.findIndex(conn => conn.id === id);
            if (index !== -1) {
                const conn = conns[index];
                conn.object.disconnect(conn.id);
                conns.splice(index, 1);
            }
            if (conns.length === 0) {
                this.connections.delete(actor);
            }
        }
    }

    disconnectAll(actor: RoundedWindowActor | Meta.WindowActor) {
        const conns = this.connections.get(actor);
        if (conns) {
            for (const conn of conns) {
                conn.object.disconnect(conn.id);
            }
            this.connections.delete(actor);
        }
    }
}

const globalSignals = new GlobalSignalManager();
const actorSignals = new ActorSignalManager();

/**
 * The rounded corners effect has to perform some actions when different events
 * happen. For example, when a new window is opened, the effect has to detect
 * it and add rounded corners to it.
 *
 * The `enableEffect` method handles this by attaching the necessary signals
 * to matching handlers on each effect.
 */
export function enableEffect() {
    const wm = global.windowManager;

    // Add the effect to all windows when the extension is enabled.
    const windowActors = global.get_window_actors();
    logDebug(`Initial window count: ${windowActors.length}`);
    for (const actor of windowActors) {
        applyEffectTo(actor as RoundedWindowActor);
    }

    // Add the effect to new windows when they are opened.
    globalSignals.connect(
        global.display,
        'window-created',
        (_: Meta.Display, win: Meta.Window) => {
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
        },
    );

    globalSignals.connect(wm, 'minimize', (_: Shell.WM, actor: Meta.WindowActor) => handlers.onMinimize(actor as RoundedWindowActor));
    globalSignals.connect(wm, 'unminimize', (_: Shell.WM, actor: Meta.WindowActor) => handlers.onUnminimize(actor as RoundedWindowActor));

    globalSignals.connect(wm, 'destroy', (_: Shell.WM, actor: Meta.WindowActor) => {
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
    });

    globalSignals.connect(global.display, 'restacked', handlers.onRestacked);
}

export function disableEffect() {
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

    globalSignals.disconnectAll();
}

/**
 * Throttles rapid size updates (e.g., window dragging) to a single idle frame.
 */
function throttledResizeHandler(actor: RoundedWindowActor) {
    if (actor.metaWindow && isPermanentlyIneligible(actor.metaWindow)) {
        logDebug(`Optimization skip triggered: Detaching signals and removing effect from ${actor.metaWindow.title}`);
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

function handleFocusChanged(actor: RoundedWindowActor) {
    if (actor.metaWindow && isPermanentlyIneligible(actor.metaWindow)) {
        logDebug(`Optimization skip triggered: Detaching signals and removing effect from ${actor.metaWindow.title}`);
        removeEffectFrom(actor);
        return;
    }
    handlers.onFocusChanged(actor);
}

function applyEffectTo(actor: RoundedWindowActor) {
    // Bail out immediately if the actor has been destroyed
    if (!isAlive(actor)) {
        return;
    }

    // Prevent double-initialization of signals
    if (initializedActors.has(actor)) {
        return;
    }

    if (!actor.firstChild) {
        const signalId = actorSignals.connect(actor, actor, 'notify::first-child', () => {
            actorSignals.disconnect(actor, signalId);
            applyEffectTo(actor);
        });
        return;
    }

    const texture = actor.get_texture();
    const metaWindow = actor.metaWindow;

    if (!(texture && metaWindow)) {
        return;
    }

    if (isPermanentlyIneligible(metaWindow)) {
        logDebug(`Skipping ${metaWindow.title} (Permanently Ineligible on Initialization)`);
        return;
    }

    // Flag as initialized before binding the massive signal list
    initializedActors.add(actor);

    // --- FIX: Prevent GC Sweep Crashes on MetaShapedTexture ---
    // If the texture is replaced or destroyed, we must proactively disconnect
    // its signals before the garbage collector sweeps it.
    actorSignals.connect(actor, actor, 'notify::first-child', () => {
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
    actorSignals.connect(actor, actor, 'notify::size', () => throttledResizeHandler(actor));
    actorSignals.connect(actor, texture, 'size-changed', () => throttledResizeHandler(actor));

    // Get notified about fullscreen explicitly, since a window must not change in
    // size to go fullscreen
    actorSignals.connect(actor, metaWindow, 'notify::fullscreen', () => throttledResizeHandler(actor));

    // Focus / Workspace changes
    actorSignals.connect(actor, metaWindow, 'notify::appears-focused', () => handleFocusChanged(actor));

    // Workspace or monitor of the window changed.
    actorSignals.connect(actor, metaWindow, 'workspace-changed', () => handleFocusChanged(actor));

    // Parent actor destruction covers normal window closing
    actorSignals.connect(actor, actor, 'destroy', () => removeEffectFrom(actor));

    handlers.onAddEffect(actor);
}

function removeEffectFrom(actor: RoundedWindowActor) {
    initializedActors.delete(actor);

    // Intercept and destroy the background resize task so it doesn't 
    // accidentally resurrect the shadow after the window is closed.
    const resizeIdleId = pendingResizeUpdates.get(actor);
    if (resizeIdleId) {
        GLib.source_remove(resizeIdleId);
        pendingResizeUpdates.delete(actor);
    }

    actorSignals.disconnectAll(actor);
    handlers.onRemoveEffect(actor);
}

function isAlive(obj: any): boolean {
    return !(obj?.is_destroyed?.());
}