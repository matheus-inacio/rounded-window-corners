/** @file Provides various utility functions used withing signal handling code. */

import type Clutter from 'gi://Clutter';
import type {RoundedCornersEffect} from '../effect/rounded_corners_effect.js';
import type {Bounds, RoundedCornerSettings} from '../utils/types.js';

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {boxShadowCss} from '../utils/box_shadow.js';
import {
    BLACKLIST,
    CUSTOM_ROUNDED_CORNER_SETTINGS,
    FOCUSED_SHADOW,
    GLOBAL_ROUNDED_CORNER_SETTINGS,
    KEEP_SHADOW_FOR_MAXIMIZED_FULLSCREEN,
    SKIP_LIBADWAITA_APP,
    SKIP_LIBHANDY_APP,
    WHITELIST_MODE,
} from '../utils/config.js';
import {ROUNDED_CORNERS_EFFECT, SHADOW_PADDING,} from '../utils/constants.js';
import {logDebug} from '../utils/log.js';

type ShadowStyleState = {
    lastShadowStyle?: string;
    lastShadowStyleKey?: string;
};

// Cache to prevent repetitive I/O operations for 
// the same app classes
const appTypeCache = new Map<string, AppType>();

/**
 * Clear the cached application types.
 * Should be called when the extension is disabled.
 */
export function clearAppTypeCache() {
    appTypeCache.clear();
}

/**
 * Get the actor that rounded corners should be applied to.
 * In Wayland, the effect is applied to WindowActor, but in X11, it is applied
 * to WindowActor.first_child.
 *
 * @param actor - The window actor to unwrap.
 * @returns The correct actor that the effect should be applied to.
 */
export function unwrapActor(actor: Meta.WindowActor): Clutter.Actor | null {
    try {
        // If the C object is already destroyed, reading .metaWindow will throw.
        const type = actor.metaWindow.get_client_type();
        return type === Meta.WindowClientType.X11 ? actor.get_first_child() : actor;
    } catch (err) {
        // Object already disposed
        return null; 
    }
}

/**
 * Get the correct rounded corner setting for a window (custom settings if a
 * window has custom overrides, global settings otherwise).
 *
 * @param win - The window to get the settings for.
 * @returns The matching settings object.
 */
export function getRoundedCornersCfg(win: Meta.Window): RoundedCornerSettings {
    const globalCfg = GLOBAL_ROUNDED_CORNER_SETTINGS;
    const customCfgList = CUSTOM_ROUNDED_CORNER_SETTINGS;

    const wmClass = win.get_wm_class_instance();
    if (
        wmClass == null ||
        !customCfgList[wmClass] ||
        !customCfgList[wmClass].enabled
    ) {
        return globalCfg;
    }

    return customCfgList[wmClass];
}

// Weird TypeScript magic :)
type RoundedCornersEffectType = InstanceType<typeof RoundedCornersEffect>;

/**
 * Get the Clutter.Effect object for the rounded corner effect of a specific
 * window.
 *
 * @param actor - The window actor to get the effect for.
 * @returns The corresponding Clutter.Effect object.
 */
export function getRoundedCornersEffect(
    actor: Meta.WindowActor,
): RoundedCornersEffectType | null {
    const win = actor.metaWindow;
    const name = ROUNDED_CORNERS_EFFECT;
    return win.get_client_type() === Meta.WindowClientType.X11
        ? (actor.firstChild.get_effect(name) as RoundedCornersEffectType)
        : (actor.get_effect(name) as RoundedCornersEffectType);
}

/** Compute outer bounds for rounded corners of a window
 *
 * @param actor - The window actor to compute the bounds for.
 * @param [x, y, width, height] - The content offsets of the window actor.
 */
export function computeBounds(
    actor: Meta.WindowActor,
    [x, y, width, height]: [number, number, number, number],
): Bounds {
    const bounds = {
        x1: x + 1,
        y1: y + 1,
        x2: x + actor.width + width,
        y2: y + actor.height + height,
    };

    const win = actor.metaWindow;

    // Only Wayland clients with custom decorations 
    // need manual shadow clipping
    if (win.get_client_type() !== Meta.WindowClientType.WAYLAND) {
        return bounds;
    }

    const wmClass = win.get_wm_class_instance()?.toLowerCase() ?? '';
    let shadows: number[] | undefined;

    if (wmClass === 'kitty') {
        shadows = [11, 35, 11, 11];
    } else if (wmClass.startsWith('jetbrains-')) {
        shadows = [18, 18, 18, 18];
    }

    // Apply adjustments if a matching application is found
    if (shadows) {
        const [x1, y1, x2, y2] = shadows;
        
        bounds.x1 += x1;
        bounds.y1 += y1;
        bounds.x2 -= x2;
        bounds.y2 -= y2;
    }

    return bounds;
}

/**
 * Compute the offset of actual window contents from the entire window buffer.
 *
 * @param window - The window to compute the offset for.
 * @returns The content offsets of the window (x, y, width, height).
 */
export function computeWindowContentsOffset(
    window: Meta.Window,
): [number, number, number, number] {
    const bufferRect = window.get_buffer_rect();
    const frameRect = window.get_frame_rect();
    return [
        frameRect.x - bufferRect.x,
        frameRect.y - bufferRect.y,
        frameRect.width - bufferRect.width,
        frameRect.height - bufferRect.height,
    ];
}

/**
 * Compute the offset of the shadow actor for a window.
 *
 * @param actor - The window actor to compute the offset for.
 * @param [offsetX, offsetY, offsetWidth, offsetHeight] - The content offsets of the window actor.
 */
export function computeShadowActorOffset(
    [offsetX, offsetY, offsetWidth, offsetHeight]: [
        number,
        number,
        number,
        number,
    ],
): number[] {
    return [
        offsetX - SHADOW_PADDING,
        offsetY - SHADOW_PADDING,
        2 * SHADOW_PADDING + offsetWidth,
        2 * SHADOW_PADDING + offsetHeight,
    ];
}

/** Update the CSS style of a shadow actor
 *
 * @param win - The window to update the style for.
 * @param actor - The shadow actor to update the style for.
 * @param borderRadius - The border radius of the shadow actor.
 * @param shadow - The shadow settings for the window.
 * @param padding - The padding of the shadow actor.
 * @param state - The optional window effect state containing the CSS cache.
 */
export function updateShadowActorStyle(
    win: Meta.Window,
    actor: St.Bin,
    borderRadius = GLOBAL_ROUNDED_CORNER_SETTINGS.borderRadius,
    shadow = FOCUSED_SHADOW,
    padding = GLOBAL_ROUNDED_CORNER_SETTINGS.padding,
    state?: ShadowStyleState,
) {
    const {left, right, top, bottom} = padding;

    // Increase border_radius when smoothing is on.
    // Read global config once (constant object; avoids redundant lookups).
    let adjustedBorderRadius = borderRadius;
    const globalCfg = GLOBAL_ROUNDED_CORNER_SETTINGS;
    if (globalCfg !== null) {
        adjustedBorderRadius *= 1.0 + globalCfg.smoothing;
    }

    const actorStyle = `padding: ${SHADOW_PADDING}px;`;
    if (actor.style !== actorStyle) {
        actor.style = actorStyle;
    }

    const child = actor.firstChild as St.Bin;

    const hideShadowForMaximizedFullscreen =
        !KEEP_SHADOW_FOR_MAXIMIZED_FULLSCREEN &&
        (win.maximizedHorizontally ||
            win.maximizedVertically ||
            win.fullscreen);

    const shadowStyleKey = hideShadowForMaximizedFullscreen
        ? `hidden|${actorStyle}`
        : `visible|${actorStyle}|${adjustedBorderRadius}|${shadow.horizontalOffset}|${shadow.verticalOffset}|${shadow.blurOffset}|${shadow.spreadRadius}|${shadow.opacity}|${left}|${right}|${top}|${bottom}`;

    if (
        state?.lastShadowStyleKey === shadowStyleKey &&
        child.style === state.lastShadowStyle
    ) {
        return;
    }

    const newChildStyle = hideShadowForMaximizedFullscreen
        ? 'opacity: 0;'
        : `background: white;
           border-radius: ${adjustedBorderRadius}px;
           ${boxShadowCss(shadow)};
               margin: ${top}px ${right}px ${bottom}px ${left}px;`;

    // Only update style and queue a redraw when the style actually changed.
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

export function isPermanentlyIneligible(
    win: Meta.Window & {_appType?: AppType},
): boolean {
    // Skip rounded corners for the DING (Desktop Icons NG) extension.
    //
    // https://extensions.gnome.org/extension/2087/desktop-icons-ng-ding/
    if (win.gtkApplicationId === 'com.rastersoft.ding') {
        return true;
    }

    // Skip blacklisted applications.
    const wmClass = win.get_wm_class_instance();
    if (wmClass == null) {
        logDebug(`Warning: wm_class_instance of ${win}: ${win.title} is null`);
        return true;
    }
    // handles blacklist / whitelist
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
        if (skipRoundedCornersForLibToolkit(win._appType, isException)) {
            return true;
        }
    }

    return false;
}

/**
 * Check whether a window should have rounded corners.
 *
 * @param win - The window to check.
 * @returns Whether the window should have rounded corners.
 */
export function shouldEnableEffect(
    win: Meta.Window & {_appType?: AppType; _appTypePromise?: Promise<void>},
): boolean {
    if (isPermanentlyIneligible(win)) {
        return false;
    }

    // Skip libhandy/libadwaita applications according to config.
    if (win._appType === undefined) {
        if (!win._appTypePromise) {
            win._appTypePromise = getAppTypeAsync(win).then(appType => {
                win._appType = appType;

                // Re-evaluate effect now that we know the type.
                // We must use global.get_window_actors() or actor references carefully.
                // Because shouldEnableEffect is mostly called during refreshRoundedCorners,
                // we should trigger a simple refresh when the promising completes if it changed.
                const actor = win.get_compositor_private();
                // Clutter.Actor uses GObject-style is_destroyed (not camelCase).
                // biome-ignore lint/style/useNamingConvention: GObject/C API name
                type DestroyCheck = {is_destroyed?: () => boolean};
                if (actor && !(actor as DestroyCheck).is_destroyed?.()) {
                    // Quick import or dispatch here is tricky if it circular-depends on handlers.
                    // Actually, if we just rely on the next resize/focus event, it's fine,
                    // but we can also fire a 'notify::size' to force a refresh on the actor.
                    actor.notify('size');
                }
            });
        }
        // Temporarily return true (or false) while it resolves.
        // Returning true here ensures we don't accidentally disable effect if we are not sure,
        // reducing visual pop-in of rounded corners on correct apps.
        // It will be disabled quickly if it's LibAdwaita.
        return true;
    }

    const appType = win._appType;
    logDebug(`Check Type of window:${win.title} => ${appType}`);

    const cfg = getRoundedCornersCfg(win);
    return roundedCornersAllowedForWindowState(win, cfg);
}

export type AppType = 'LibAdwaita' | 'LibHandy' | 'Other';

function skipRoundedCornersForLibToolkit(
    appType: AppType,
    isException: boolean,
): boolean {
    if (isException) {
        return false;
    }
    return (
        (SKIP_LIBADWAITA_APP && appType === 'LibAdwaita') ||
        (SKIP_LIBHANDY_APP && appType === 'LibHandy')
    );
}

function roundedCornersAllowedForWindowState(
    win: Meta.Window,
    cfg: RoundedCornerSettings,
): boolean {
    const maximized = win.maximizedHorizontally || win.maximizedVertically;
    const fullscreen = win.fullscreen;
    return (
        !(maximized || fullscreen) ||
        (maximized && !fullscreen && cfg.keepRoundedCorners.maximized) ||
        (fullscreen && cfg.keepRoundedCorners.fullscreen)
    );
}

/**
 * Get the type of the application asynchronously (LibHandy/LibAdwaita/Other).
 *
 * Tries {@link detectAppTypeFromMapFiles} first (O(unique mapped files / batch)
 * async round-trips), then falls back to {@link detectAppTypeFromMaps} (single
 * bulk read) when map_files is inaccessible due to ptrace restrictions.
 *
 * @param win - The window to get the type of.
 * @returns the type of the application.
 */
async function getAppTypeAsync(win: Meta.Window): Promise<AppType> {
    const wmClass = win.get_wm_class_instance();
    if (wmClass && appTypeCache.has(wmClass)) {
        logDebug(`AppType cache hit for "${wmClass}": ${appTypeCache.get(wmClass)}`);
        return appTypeCache.get(wmClass)!;
    }

    const pid = win.get_pid();
    logDebug(`Detecting app type for "${wmClass}" (pid ${pid}) via map_files…`);

    const appType = await detectAppTypeFromMapFiles(pid)
        .catch((e) => {
            logDebug(`map_files unavailable for pid ${pid} (${e}), falling back to /proc/maps`);
            return detectAppTypeFromMaps(pid);
        });

    logDebug(`AppType resolved for "${wmClass}" (pid ${pid}): ${appType}`);
    if (wmClass) appTypeCache.set(wmClass, appType);
    return appType;
}

/**
 * Detect the app type by enumerating /proc/<pid>/map_files/.
 *
 * Each entry in that directory is a symlink whose target is the path of a
 * memory-mapped file (shared libraries, executables, etc.). Checking symlink
 * targets avoids parsing the full text of /proc/<pid>/maps: there are far
 * fewer unique mapped files than lines in the maps file, and we retrieve them
 * in batches of 64 rather than one per async GLib main-loop round-trip.
 *
 * @throws if the directory cannot be enumerated (e.g. ptrace restrictions).
 */
function detectAppTypeFromMapFiles(pid: number): Promise<AppType> {
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
                    // Permission denied or map_files unavailable — let caller fall back.
                    reject(e);
                    return;
                }

                let batchCount = 0;
                const readBatch = () => {
                    enumerator.next_files_async(64, GLib.PRIORITY_LOW, null, (_s, batchRes) => {
                        try {
                            const infos = enumerator.next_files_finish(batchRes);
                            batchCount++;

                            if (infos.length === 0) {
                                // Exhausted all entries — no library match found.
                                logDebug(`map_files[pid ${pid}]: scanned ${batchCount} batch(es), result=Other`);
                                try { enumerator.close(null); } catch {}
                                resolve('Other');
                                return;
                            }

                            for (const info of infos) {
                                const target = info.get_symlink_target() ?? '';
                                if (target.includes('libadwaita-1.so')) {
                                    logDebug(`map_files[pid ${pid}]: found libadwaita in batch ${batchCount} (${target})`);
                                    try { enumerator.close(null); } catch {}
                                    resolve('LibAdwaita');
                                    return;
                                }
                                if (target.includes('libhandy-1.so')) {
                                    logDebug(`map_files[pid ${pid}]: found libhandy in batch ${batchCount} (${target})`);
                                    try { enumerator.close(null); } catch {}
                                    resolve('LibHandy');
                                    return;
                                }
                            }

                            readBatch();
                        } catch (e) {
                            logDebug(`map_files[pid ${pid}]: error reading batch ${batchCount}: ${e}`);
                            try { enumerator.close(null); } catch {}
                            resolve('Other');
                        }
                    });
                };

                readBatch();
            },
        );
    });
}

/**
 * Fallback: read /proc/<pid>/maps in 16 KB chunks and search each chunk for
 * the toolkit library names.
 *
 * This is strictly better than the two naive extremes:
 *  - Old line-by-line: O(lines) async callbacks, O(1) memory  → huge GLib overhead
 *  - Bulk load_contents_async: O(1) callbacks, O(file) memory → high memory pressure
 *
 * Chunked approach: O(file_size / 16KB) callbacks ≈ 5–10 for typical apps,
 * and O(16KB) memory at any point in time.
 *
 * A (needle_length − 1) = 15-byte overlap is kept between adjacent chunks so
 * that needles straddling a chunk boundary are never missed.
 */
function detectAppTypeFromMaps(pid: number): Promise<AppType> {
    // Longest needle is 'libadwaita-1.so' (16 chars); overlap = 16 - 1 = 15.
    const CHUNK_SIZE = 16 * 1024;
    const OVERLAP    = 'libadwaita-1.so'.length - 1;

    return new Promise((resolve) => {
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
            let tail     = '';  // last OVERLAP chars of the previous chunk
            let chunkNum = 0;

            const readChunk = () => {
                stream.read_bytes_async(CHUNK_SIZE, GLib.PRIORITY_LOW, null, (_s, chunkRes) => {
                    try {
                        const bytes = stream.read_bytes_finish(chunkRes);
                        chunkNum++;

                        if (bytes.get_size() === 0) {
                            // EOF — no match found.
                            logDebug(`maps[pid ${pid}]: scanned ${chunkNum - 1} chunk(s), result=Other`);
                            try { stream.close(null); } catch {}
                            resolve('Other');
                            return;
                        }

                        // Prepend the tail of the previous chunk so we never miss a
                        // needle that straddles a 16 KB boundary.
                        const chunk      = decoder.decode(bytes.get_data() as unknown as Uint8Array);
                        const searchText = tail + chunk;

                        if (searchText.includes('libadwaita-1.so')) {
                            logDebug(`maps[pid ${pid}]: found libadwaita-1.so in chunk ${chunkNum}`);
                            try { stream.close(null); } catch {}
                            resolve('LibAdwaita');
                            return;
                        }
                        if (searchText.includes('libhandy-1.so')) {
                            logDebug(`maps[pid ${pid}]: found libhandy-1.so in chunk ${chunkNum}`);
                            try { stream.close(null); } catch {}
                            resolve('LibHandy');
                            return;
                        }

                        // Carry forward only the minimum overlap needed.
                        tail = chunk.length >= OVERLAP ? chunk.slice(-OVERLAP) : chunk;
                        readChunk();
                    } catch (e) {
                        logDebug(`maps[pid ${pid}]: error reading chunk ${chunkNum}: ${e}`);
                        try { stream.close(null); } catch {}
                        resolve('Other');
                    }
                });
            };

            readChunk();
        });
    });
}