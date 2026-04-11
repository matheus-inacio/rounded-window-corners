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

const pendingEffectApplications = new Map<Meta.WindowActor, number>();
const pendingResizeUpdates = new WeakSet<RoundedWindowActor>();

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
    private connections = new Map<RoundedWindowActor | Meta.WindowActor, { object: GObject.Object; id: number }[]>();

    connect(actor: RoundedWindowActor | Meta.WindowActor, object: GObject.Object, signal: string, callback: (...args: any[]) => any) {
        const id = object.connect(signal, callback);
        const conns = this.connections.get(actor) || [];
        conns.push({ object, id });
        this.connections.set(actor, conns);
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

            const scheduleApply = () => {
                const idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    pendingEffectApplications.delete(actor);
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
                    scheduleApply();
                });
            } else {
                scheduleApply();
            }
        },
    );

    globalSignals.connect(wm, 'minimize', (_: Shell.WM, actor: Meta.WindowActor) => handlers.onMinimize(actor as RoundedWindowActor));
    globalSignals.connect(wm, 'unminimize', (_: Shell.WM, actor: Meta.WindowActor) => handlers.onUnminimize(actor as RoundedWindowActor));

    globalSignals.connect(wm, 'destroy', (_: Shell.WM, actor: Meta.WindowActor) => {
        const idleId = pendingEffectApplications.get(actor);
        if (idleId) {
            GLib.source_remove(idleId);
            pendingEffectApplications.delete(actor);
        }
        removeEffectFrom(actor as RoundedWindowActor);
    });

    globalSignals.connect(global.display, 'restacked', handlers.onRestacked);
}

export function disableEffect() {
    for (const id of pendingEffectApplications.values()) {
        GLib.source_remove(id);
    }
    pendingEffectApplications.clear();

    for (const actor of global.get_window_actors()) {
        removeEffectFrom(actor as RoundedWindowActor);
    }

    globalSignals.disconnectAll();
}

/**
 * Throttles rapid size updates (e.g., window dragging) to a single idle frame.
 */
function throttledResizeHandler(actor: RoundedWindowActor) {
    if (pendingResizeUpdates.has(actor)) return;
    
    pendingResizeUpdates.add(actor);
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        pendingResizeUpdates.delete(actor);
        handlers.onSizeChanged(actor);
        return GLib.SOURCE_REMOVE;
    });
}

function applyEffectTo(actor: RoundedWindowActor) {
    if (!actor.firstChild) {
        actorSignals.connect(actor, actor, 'notify::first-child', () => {
            applyEffectTo(actor);
        });
        return;
    }

    const texture = actor.get_texture();
    const metaWindow = actor.metaWindow;

    if (!(texture && metaWindow)) {
        return;
    }

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
    actorSignals.connect(actor, metaWindow, 'notify::appears-focused', () => handlers.onFocusChanged(actor));
    // Workspace or monitor of the window changed.
    actorSignals.connect(actor, metaWindow, 'workspace-changed', () => handlers.onFocusChanged(actor));

    handlers.onAddEffect(actor);
}

function removeEffectFrom(actor: RoundedWindowActor) {
    actorSignals.disconnectAll(actor);
    handlers.onRemoveEffect(actor);
}