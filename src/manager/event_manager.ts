/**
 * @file Manages connections between gnome shell events and the rounded corners
 * effect. See {@link enableEffect} for more information.
 */

import type GObject from 'gi://GObject';
import type Meta from 'gi://Meta';
import type Shell from 'gi://Shell';
import GLib from 'gi://GLib';
import type { RoundedWindowActor } from '../utils/types.js';

import { logDebug } from '../utils/log.js';
import { prefs } from '../utils/settings.js';
import * as handlers from './event_handlers.js';

const pendingEffectApplications = new Map<Meta.WindowActor, number>();
const globalConnections: { object: GObject.Object; id: number }[] = [];
const actorConnections = new Map<RoundedWindowActor | Meta.WindowActor, { object: GObject.Object; id: number }[]>();

/**
 * The rounded corners effect has to perform some actions when different events
 * happen. For example, when a new window is opened, the effect has to detect
 * it and add rounded corners to it.
 *
 * The `enableEffect` method handles this by attaching the necessary signals
 * to matching handlers on each effect.
 */
export function enableEffect() {
    // Update the effect when settings are changed.
    connectGlobal(prefs, 'changed', handlers.onSettingsChanged);

    const wm = global.windowManager;

    // Add the effect to all windows when the extension is enabled.
    const windowActors = global.get_window_actors();
    logDebug(`Initial window count: ${windowActors.length}`);
    for (const actor of windowActors) {
        applyEffectTo(actor as RoundedWindowActor);
    }

    // Add the effect to new windows when they are opened.
    connectGlobal(
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

    // Window minimized.
    connectGlobal(wm, 'minimize', (_: Shell.WM, actor: Meta.WindowActor) =>
        handlers.onMinimize(actor),
    );

    // Window unminimized.
    connectGlobal(wm, 'unminimize', (_: Shell.WM, actor: Meta.WindowActor) =>
        handlers.onUnminimize(actor),
    );

    // When closing the window, remove the effect from it.
    connectGlobal(wm, 'destroy', (_: Shell.WM, actor: Meta.WindowActor) => {
        const idleId = pendingEffectApplications.get(actor);
        if (idleId) {
            GLib.source_remove(idleId);
            pendingEffectApplications.delete(actor);
        }
        removeEffectFrom(actor as RoundedWindowActor);
    });

    // When windows are restacked, the order of shadow actors as well.
    connectGlobal(global.display, 'restacked', handlers.onRestacked);
}

/** Disable the effect for all windows. */
export function disableEffect() {
    for (const id of pendingEffectApplications.values()) {
        GLib.source_remove(id);
    }
    pendingEffectApplications.clear();

    for (const actor of global.get_window_actors()) {
        removeEffectFrom(actor as RoundedWindowActor);
    }

    disconnectGlobal();
}

/**
 * Connect a callback to a global object signal.
 */
function connectGlobal(
    object: GObject.Object,
    signal: string,
    // biome-ignore lint/suspicious/noExplicitAny: Signal callbacks can have any return args and return types.
    callback: (...args: any[]) => any,
) {
    globalConnections.push({
        object: object,
        id: object.connect(signal, callback),
    });
}

/**
 * Disconnect all global signals.
 */
function disconnectGlobal() {
    for (const conn of globalConnections) {
        conn.object.disconnect(conn.id);
    }
    globalConnections.length = 0;
}

/**
 * Connect a callback to an object signal and track it 
 * for a specific actor.
 */
function connectActor(
    actor: RoundedWindowActor | Meta.WindowActor,
    object: GObject.Object,
    signal: string,
    // biome-ignore lint/suspicious/noExplicitAny: Signal callbacks can have any return args and return types.
    callback: (...args: any[]) => any,
) {
    let conns = actorConnections.get(actor);
    if (!conns) {
        conns = [];
        actorConnections.set(actor, conns);
    }
    conns.push({
        object,
        id: object.connect(signal, callback),
    });
}

/**
 * Apply the effect to a window.
 *
 * While {@link enableEffect} handles global events such as window creation,
 * this function handles events that happen to a specific window, like changing
 * its size or workspace.
 *
 * @param actor - The window actor to apply the effect to.
 */
function applyEffectTo(actor: RoundedWindowActor) {
    // In wayland sessions, the surface actor of XWayland clients is sometimes
    // not ready when the window is created. In this case, we wait until it is
    // ready before applying the effect.
    if (!actor.firstChild) {
        // Tracked via connectActor so it safely disconnects if the window dies early
        connectActor(actor, actor, 'notify::first-child', () => {
            applyEffectTo(actor);
        });
        return;
    }

    const texture = actor.get_texture();
    const metaWindow = actor.metaWindow;

    // Fail early if components are missing to avoid connecting to undefined
    if (!texture || !metaWindow) {
        return;
    }

    // Window resized.
    //
    // The signal has to be connected both to the actor and the texture. Why is
    // that? I have no idea. But without that, weird bugs can happen. For
    // example, when using Dash to Dock, all opened windows will be invisible
    // *unless they are pinned in the dock*. So yeah, GNOME is magic.
    connectActor(actor, actor, 'notify::size', () => handlers.onSizeChanged(actor));
    connectActor(actor, texture, 'size-changed', () => handlers.onSizeChanged(actor));

    // Get notified about fullscreen explicitly, since a window must not change in
    // size to go fullscreen
    connectActor(actor, metaWindow, 'notify::fullscreen', () => handlers.onSizeChanged(actor));

    // Window focus changed.
    connectActor(actor, metaWindow, 'notify::appears-focused', () => handlers.onFocusChanged(actor));

    // Workspace or monitor of the window changed.
    connectActor(actor, metaWindow, 'workspace-changed', () => handlers.onFocusChanged(actor));

    handlers.onAddEffect(actor);
}

function removeEffectFrom(actor: RoundedWindowActor) {
    const conns = actorConnections.get(actor);
    if (conns) {
        for (const conn of conns) {
            conn.object.disconnect(conn.id);
        }
        actorConnections.delete(actor);
    }

    handlers.onRemoveEffect(actor);
}