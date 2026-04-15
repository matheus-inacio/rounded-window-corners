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

/**
 * Get the scaling factor of a window.
 *
 * @param win - The window to get the scaling factor for.
 * @returns The scaling factor of the window.
 */
export function windowScaleFactor(win: Meta.Window) {
    // In Wayland with fractional scaling, or when the stage is logical,
    // St.ThemeContext.scaleFactor is 1. All stage coordinates are logical, so
    // we don't need to scale shadows or borders per-monitor.
    const originalScale = St.ThemeContext.get_for_stage(
        global.stage as Clutter.Stage,
    ).scaleFactor;

    if (originalScale === 1) {
        return 1;
    }

    const monitorIndex = win.get_monitor();
    return global.display.get_monitor_scale(monitorIndex);
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
        const scale = windowScaleFactor(win);
        
        bounds.x1 += x1 * scale;
        bounds.y1 += y1 * scale;
        bounds.x2 -= x2 * scale;
        bounds.y2 -= y2 * scale;
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
    actor: Meta.WindowActor,
    [offsetX, offsetY, offsetWidth, offsetHeight]: [
        number,
        number,
        number,
        number,
    ],
): number[] {
    const win = actor.metaWindow;
    const shadowPadding = SHADOW_PADDING * windowScaleFactor(win);

    return [
        offsetX - shadowPadding,
        offsetY - shadowPadding,
        2 * shadowPadding + offsetWidth,
        2 * shadowPadding + offsetHeight,
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

    // If there are two monitors with different scale factors, the scale of
    // the window may be different from the scale that has to be applied in
    // the css, so we have to adjust the scale factor accordingly.

    const originalScale = St.ThemeContext.get_for_stage(
        global.stage as Clutter.Stage,
    ).scaleFactor;

    const scale = windowScaleFactor(win) / originalScale;

    const actorStyle = `padding: ${SHADOW_PADDING * scale}px;`;
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
        : `visible|${actorStyle}|${adjustedBorderRadius * scale}|${shadow.horizontalOffset}|${shadow.verticalOffset}|${shadow.blurOffset}|${shadow.spreadRadius}|${shadow.opacity}|${left}|${right}|${top}|${bottom}`;

    if (
        state?.lastShadowStyleKey === shadowStyleKey &&
        child.style === state.lastShadowStyle
    ) {
        return;
    }

    const newChildStyle = hideShadowForMaximizedFullscreen
        ? 'opacity: 0;'
        : `background: white;
           border-radius: ${adjustedBorderRadius * scale}px;
           ${boxShadowCss(shadow, scale)};
               margin: ${top * scale}px
                       ${right * scale}px
                       ${bottom * scale}px
                       ${left * scale}px;`;

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
 * @param win - The window to get the type of.
 * @returns the type of the application.
 */
async function getAppTypeAsync(win: Meta.Window): Promise<AppType> {
    const wmClass = win.get_wm_class_instance();
    if (wmClass && appTypeCache.has(wmClass)) {
        return appTypeCache.get(wmClass)!;
    }

    return new Promise((resolve) => {
        try {
            const file = Gio.File.new_for_path(`/proc/${win.get_pid()}/maps`);
            file.read_async(GLib.PRIORITY_DEFAULT, null, (_source, res) => {
                try {
                    const baseStream = file.read_finish(res);
                    const dataStream = new Gio.DataInputStream({ base_stream: baseStream });

                    const readNextLine = () => {
                        dataStream.read_line_async(GLib.PRIORITY_DEFAULT, null, (_source, lineRes) => {
                            try {
                                const [lineBytes] = dataStream.read_line_finish_utf8(lineRes);
                                
                                if (lineBytes === null) {
                                    dataStream.close(null);
                                    if (wmClass) appTypeCache.set(wmClass, 'Other');
                                    return resolve('Other');
                                }
                    
                                if (lineBytes.includes('libadwaita-1.so')) {
                                    dataStream.close(null);
                                    if (wmClass) appTypeCache.set(wmClass, 'LibAdwaita');
                                    return resolve('LibAdwaita');
                                }
                    
                                if (lineBytes.includes('libhandy-1.so')) {
                                    dataStream.close(null);
                                    if (wmClass) appTypeCache.set(wmClass, 'LibHandy');
                                    return resolve('LibHandy');
                                }
                    
                                readNextLine();
                            } catch {
                                dataStream.close(null);
                                resolve('Other');
                            }
                        });
                    };
                    readNextLine();
                } catch {
                    resolve('Other');
                }
            });
        } catch {
            resolve('Other');
        }
    });
}