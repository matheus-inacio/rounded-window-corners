/**
 * @file Determines whether a window is eligible to receive rounded corners and
 * a custom shadow.
 *
 * This module owns the entire "should we apply the effect?" decision tree,
 * including the asynchronous detection of application toolkit type
 * (LibAdwaita / LibHandy / Other) which is the most complex piece of logic in
 * the extension.
 */

import Meta from 'gi://Meta';

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {
    BLACKLIST,
    SKIP_LIBADWAITA_APP,
    SKIP_LIBHANDY_APP,
    WHITELIST_MODE,
} from '../utils/config.js';
import {logDebug} from '../utils/log.js';
import {getRoundedCornersCfg} from './actor_helpers.js';

/** The toolkit type of a running application. */
export type AppType = 'LibAdwaita' | 'LibHandy' | 'Other';

// ---------------------------------------------------------------------------
// App-type cache
// ---------------------------------------------------------------------------

/**
 * Caches previously resolved {@link AppType} values keyed by
 * `wm_class_instance` to avoid repeated `/proc` I/O for the same application.
 */
const appTypeCache = new Map<string, AppType>();

/**
 * Clear the app-type cache.  Should be called when the extension is disabled
 * so that stale entries do not carry over to the next enable cycle.
 */
export function clearAppTypeCache() {
    appTypeCache.clear();
}

// ---------------------------------------------------------------------------
// Public eligibility predicates
// ---------------------------------------------------------------------------

/**
 * Return `true` if the window can never receive rounded corners, regardless of
 * its current state or toolkit type.
 *
 * Checks performed (in order):
 * 1. DING (Desktop Icons NG) extension windows are always excluded.
 * 2. Windows whose `wm_class_instance` appears in the blacklist (or does *not*
 *    appear when whitelist mode is active) are excluded.
 * 3. Only `NORMAL`, `DIALOG`, and `MODAL_DIALOG` window types are eligible.
 * 4. If the app type is already known, LibAdwaita/LibHandy windows are
 *    excluded according to config.
 *
 * @param win - The window to evaluate.
 */
export function isPermanentlyIneligible(
    win: Meta.Window & {_appType?: AppType},
): boolean {
    // Skip rounded corners for the DING (Desktop Icons NG) extension.
    // https://extensions.gnome.org/extension/2087/desktop-icons-ng-ding/
    if (win.gtkApplicationId === 'com.rastersoft.ding') {
        return true;
    }

    const wmClass = win.get_wm_class_instance();
    if (wmClass == null) {
        logDebug(`Warning: wm_class_instance of ${win}: ${win.title} is null`);
        return true;
    }

    // Handles blacklist / whitelist logic.
    const isException = BLACKLIST.includes(wmClass);
    if (isException !== WHITELIST_MODE) {
        return true;
    }

    // Only apply the effect to normal windows (skip menus, tooltips, etc.)
    if (
        win.windowType !== Meta.WindowType.NORMAL &&
        win.windowType !== Meta.WindowType.DIALOG &&
        win.windowType !== Meta.WindowType.MODAL_DIALOG
    ) {
        return true;
    }

    if (win._appType !== undefined) {
        if (_skipForLibToolkit(win._appType, isException)) {
            return true;
        }
    }

    return false;
}

/**
 * Return `true` if the rounded-corners effect should be active for `win` right
 * now (taking into account its maximised/fullscreen state and toolkit type).
 *
 * When the app type is not yet known, an async detection task is started and
 * `true` is returned optimistically — the effect will be re-evaluated once the
 * type resolves.
 *
 * @param win - The window to evaluate.
 */
export function shouldEnableEffect(
    win: Meta.Window & {_appType?: AppType; _appTypePromise?: Promise<void>},
): boolean {
    if (isPermanentlyIneligible(win)) {
        return false;
    }

    if (win._appType === undefined) {
        if (!win._appTypePromise) {
            win._appTypePromise = getAppTypeAsync(win).then(appType => {
                win._appType = appType;

                // Re-evaluate now that the type is known.  Notifying 'size'
                // triggers the same refresh path as a resize event.
                const actor = win.get_compositor_private();
                // biome-ignore lint/style/useNamingConvention: GObject/C API name
                type DestroyCheck = {is_destroyed?: () => boolean};
                if (actor && !(actor as DestroyCheck).is_destroyed?.()) {
                    actor.notify('size');
                }
            });
        }
        // Return true optimistically while the promise resolves so we don't
        // accidentally show square corners on apps we intend to round.
        return true;
    }

    logDebug(`Check Type of window:${win.title} => ${win._appType}`);

    const cfg = getRoundedCornersCfg(win);
    return _roundedCornersAllowedForWindowState(win, cfg);
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function _skipForLibToolkit(appType: AppType, isException: boolean): boolean {
    if (isException) {
        return false;
    }
    return (
        (SKIP_LIBADWAITA_APP && appType === 'LibAdwaita') ||
        (SKIP_LIBHANDY_APP && appType === 'LibHandy')
    );
}

function _roundedCornersAllowedForWindowState(
    win: Meta.Window,
    cfg: ReturnType<typeof getRoundedCornersCfg>,
): boolean {
    const maximized = win.maximizedHorizontally || win.maximizedVertically;
    const fullscreen = win.fullscreen;
    return (
        !(maximized || fullscreen) ||
        (maximized && !fullscreen && cfg.keepRoundedCorners.maximized) ||
        (fullscreen && cfg.keepRoundedCorners.fullscreen)
    );
}

// ---------------------------------------------------------------------------
// App-type detection
// ---------------------------------------------------------------------------

/**
 * Asynchronously resolve the toolkit type for the application that owns `win`.
 *
 * Tries {@link _detectFromMapFiles} first (O(unique mapped files / batch)
 * async round-trips), then falls back to {@link _detectFromMaps} (single
 * chunked bulk read) when `map_files` is inaccessible due to ptrace
 * restrictions.
 */
async function getAppTypeAsync(win: Meta.Window): Promise<AppType> {
    const wmClass = win.get_wm_class_instance();
    if (wmClass && appTypeCache.has(wmClass)) {
        logDebug(
            `AppType cache hit for "${wmClass}": ${appTypeCache.get(wmClass)}`,
        );
        return appTypeCache.get(wmClass)!;
    }

    const pid = win.get_pid();
    logDebug(
        `Detecting app type for "${wmClass}" (pid ${pid}) via map_files…`,
    );

    const appType = await _detectFromMapFiles(pid).catch(e => {
        logDebug(
            `map_files unavailable for pid ${pid} (${e}), falling back to /proc/maps`,
        );
        return _detectFromMaps(pid);
    });

    logDebug(`AppType resolved for "${wmClass}" (pid ${pid}): ${appType}`);
    if (wmClass) appTypeCache.set(wmClass, appType);
    return appType;
}

/**
 * Detect the app type by enumerating `/proc/<pid>/map_files/`.
 *
 * Each entry is a symlink whose target is the path of a memory-mapped file.
 * Checking symlink targets avoids parsing the full text of `/proc/<pid>/maps`:
 * there are far fewer unique mapped files than lines in the maps file, and we
 * retrieve them in batches of 64 rather than one per GLib main-loop round-trip.
 *
 * @throws if the directory cannot be enumerated (e.g. ptrace restrictions).
 */
function _detectFromMapFiles(pid: number): Promise<AppType> {
    return new Promise((resolve, reject) => {
        const dir = Gio.File.new_for_path(`/proc/${pid}/map_files`);
        dir.enumerate_children_async(
            'standard::symlink-target',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            GLib.PRIORITY_LOW,
            null,
            (_src, enumRes) => {
                let enumerator: Gio.FileEnumerator;
                try {
                    enumerator = dir.enumerate_children_finish(enumRes);
                } catch (e) {
                    reject(e);
                    return;
                }

                let batchCount = 0;
                const readBatch = () => {
                    enumerator.next_files_async(
                        64,
                        GLib.PRIORITY_LOW,
                        null,
                        (_s, batchRes) => {
                            try {
                                const infos =
                                    enumerator.next_files_finish(batchRes);
                                batchCount++;

                                if (infos.length === 0) {
                                    logDebug(
                                        `map_files[pid ${pid}]: scanned ${batchCount} batch(es), result=Other`,
                                    );
                                    try {
                                        enumerator.close(null);
                                    } catch {}
                                    resolve('Other');
                                    return;
                                }

                                for (const info of infos) {
                                    const target =
                                        info.get_symlink_target() ?? '';
                                    if (target.includes('libadwaita-1.so')) {
                                        logDebug(
                                            `map_files[pid ${pid}]: found libadwaita in batch ${batchCount} (${target})`,
                                        );
                                        try {
                                            enumerator.close(null);
                                        } catch {}
                                        resolve('LibAdwaita');
                                        return;
                                    }
                                    if (target.includes('libhandy-1.so')) {
                                        logDebug(
                                            `map_files[pid ${pid}]: found libhandy in batch ${batchCount} (${target})`,
                                        );
                                        try {
                                            enumerator.close(null);
                                        } catch {}
                                        resolve('LibHandy');
                                        return;
                                    }
                                }

                                readBatch();
                            } catch (e) {
                                logDebug(
                                    `map_files[pid ${pid}]: error reading batch ${batchCount}: ${e}`,
                                );
                                try {
                                    enumerator.close(null);
                                } catch {}
                                resolve('Other');
                            }
                        },
                    );
                };

                readBatch();
            },
        );
    });
}

/**
 * Fallback: read `/proc/<pid>/maps` in 16 KB chunks and search each chunk for
 * the toolkit library names.
 *
 * This is strictly better than the two naive extremes:
 *  - Old line-by-line: O(lines) async callbacks, O(1) memory  → huge GLib overhead
 *  - Bulk load_contents_async: O(1) callbacks, O(file) memory → high memory pressure
 *
 * Chunked approach: O(file_size / 16KB) callbacks ≈ 5–10 for typical apps,
 * and O(16KB) memory at any point in time.
 *
 * A `(needle_length − 1)` = 15-byte overlap is kept between adjacent chunks so
 * that needles straddling a chunk boundary are never missed.
 */
function _detectFromMaps(pid: number): Promise<AppType> {
    // Longest needle is 'libadwaita-1.so' (16 chars); overlap = 16 - 1 = 15.
    const CHUNK_SIZE = 16 * 1024;
    const OVERLAP = 'libadwaita-1.so'.length - 1;

    return new Promise(resolve => {
        logDebug(`maps[pid ${pid}]: opening /proc/${pid}/maps for chunked read`);
        const file = Gio.File.new_for_path(`/proc/${pid}/maps`);

        file.read_async(GLib.PRIORITY_LOW, null, (_src, openRes) => {
            let stream: Gio.FileInputStream;
            try {
                stream = file.read_finish(openRes);
            } catch (e) {
                logDebug(`maps[pid ${pid}]: failed to open stream: ${e}`);
                resolve('Other');
                return;
            }

            const decoder = new TextDecoder();
            let tail = ''; // last OVERLAP chars of the previous chunk
            let chunkNum = 0;

            const readChunk = () => {
                stream.read_bytes_async(
                    CHUNK_SIZE,
                    GLib.PRIORITY_LOW,
                    null,
                    (_s, chunkRes) => {
                        try {
                            const bytes = stream.read_bytes_finish(chunkRes);
                            chunkNum++;

                            if (bytes.get_size() === 0) {
                                logDebug(
                                    `maps[pid ${pid}]: scanned ${chunkNum - 1} chunk(s), result=Other`,
                                );
                                try {
                                    stream.close(null);
                                } catch {}
                                resolve('Other');
                                return;
                            }

                            const chunk = decoder.decode(
                                bytes.get_data() as unknown as Uint8Array,
                            );
                            const searchText = tail + chunk;

                            if (searchText.includes('libadwaita-1.so')) {
                                logDebug(
                                    `maps[pid ${pid}]: found libadwaita-1.so in chunk ${chunkNum}`,
                                );
                                try {
                                    stream.close(null);
                                } catch {}
                                resolve('LibAdwaita');
                                return;
                            }
                            if (searchText.includes('libhandy-1.so')) {
                                logDebug(
                                    `maps[pid ${pid}]: found libhandy-1.so in chunk ${chunkNum}`,
                                );
                                try {
                                    stream.close(null);
                                } catch {}
                                resolve('LibHandy');
                                return;
                            }

                            tail =
                                chunk.length >= OVERLAP
                                    ? chunk.slice(-OVERLAP)
                                    : chunk;
                            readChunk();
                        } catch (e) {
                            logDebug(
                                `maps[pid ${pid}]: error reading chunk ${chunkNum}: ${e}`,
                            );
                            try {
                                stream.close(null);
                            } catch {}
                            resolve('Other');
                        }
                    },
                );
            };

            readChunk();
        });
    });
}
