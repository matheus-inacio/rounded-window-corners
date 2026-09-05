/**
 * @file Generic GObject signal connect/disconnect utilities.
 *
 * These classes manage signal connections so they can be bulk-disconnected
 * when the extension is disabled or an actor is removed.
 */

import type Meta from 'gi://Meta';
import type {RoundedWindowActor} from '../utils/types.js';

import GObject from 'gi://GObject';

export class GlobalSignalManager {
    private connections: {object: GObject.Object; id: number}[] = [];

    connect(
        object: GObject.Object,
        signal: string,
        callback: (...args: any[]) => any,
    ) {
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

export class ActorSignalManager {
    private connections = new WeakMap<
        RoundedWindowActor | Meta.WindowActor,
        {object: GObject.Object; id: number}[]
    >();

    connect(
        actor: RoundedWindowActor | Meta.WindowActor,
        object: GObject.Object,
        signal: string,
        callback: (...args: any[]) => any,
    ): number {
        const id = object.connect(signal, callback);
        const conns = this.connections.get(actor) || [];
        conns.push({object, id});
        this.connections.set(actor, conns);
        return id;
    }

    disconnect(actor: RoundedWindowActor | Meta.WindowActor, id: number) {
        const conns = this.connections.get(actor);
        if (conns) {
            const index = conns.findIndex(conn => conn.id === id);
            if (index !== -1) {
                const conn = conns[index];
                try {
                    if (
                        GObject.signal_handler_is_connected(
                            conn.object,
                            conn.id,
                        )
                    ) {
                        conn.object.disconnect(conn.id);
                    }
                } catch {
                    // The object may have been disposed from C code already.
                }
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
                try {
                    if (
                        GObject.signal_handler_is_connected(
                            conn.object,
                            conn.id,
                        )
                    ) {
                        conn.object.disconnect(conn.id);
                    }
                } catch {
                    // The object may have been disposed from C code already.
                }
            }
            this.connections.delete(actor);
        }
    }
}
