# Changes from upstream

This fork is a significant refactor of the original extension. Below is a summary of every major change.

## Removed subsystems

| Subsystem | Why it was removed |
|---|---|
| **Preferences UI** (`src/preferences/`, `src/prefs.ts`) | All settings are now hardcoded in a single [`config.ts`](src/utils/config.ts). This eliminates the GSettings schema, the GLib Variant packing logic, and the entire preferences window. |
| **Window picker D-Bus service** (`src/window_picker/`) | Used exclusively by the preferences UI to pick a window class for per-window overrides. No longer needed. |
| **Per-window custom settings** | Configuration for individual `wm_class` overrides has been removed; every window receives the same rounded corner treatment. |
| **Background menu item** (`src/utils/background_menu.ts`) | Desktop right-click shortcut to the now-removed preferences. |
| **Linear filter effect** (`src/effect/linear_filter_effect.ts`) | Removed to reduce the effect pipeline surface area. |
| **Overview & workspace-switch shadow patches** (`src/patch/`) | Monkey-patches into `WindowPreview._addWindow` and `WorkspaceAnimationController` were removed, eliminating fragile coupling with GNOME Shell internals. |
| **LibAdwaita / LibHandy skip toggles** | Previously configurable via GSettings; now the extension always skips apps that already round their own corners. |
| **Translation files** (`po/`) | Removed all `.po` / `.pot` files since there is no longer any translatable UI. |

## Architecture refactoring

The monolithic `src/manager/utils.ts` (373 lines) was decomposed into focused, single-responsibility modules:

| New module | Responsibility |
|---|---|
| [`eligibility.ts`](src/manager/eligibility.ts) | Full "should we apply the effect?" decision tree, including async app-type detection. |
| [`geometry.ts`](src/manager/geometry.ts) | Pure, stateless math helpers for window bounds, shadow offsets, and content-offset calculations. |
| [`shadow.ts`](src/manager/shadow.ts) | Shadow actor creation, styling, constraint management, and CSS-cache-aware refresh. |
| [`actor_helpers.ts`](src/manager/actor_helpers.ts) | Small helpers for safely unwrapping window actors. |
| [`window_state.ts`](src/manager/window_state.ts) | Shared `WeakMap`/`Set` state that tracks managed actors and their per-window effect data. |
| [`config.ts`](src/utils/config.ts) | Single source of truth for all hardcoded settings (radii, shadows, padding, blacklist). |

## Fragment shader rewrite

The rounded-corners fragment shader was rewritten from **197 → 43 lines**:

- **Branchless execution path** — the original shader used `if`/`else` branches for border mode, corner type (circle vs. squircle), and early-exit bounds checks. The new shader eliminates all branching; border rendering is gated by multiplying with a `showBorder` uniform (when `0.0` the border math evaluates to zero — no GPU branch divergence).
- **Simplified SDF** — replaced the dual `circleBounds` / `squircleBounds` functions with a single `getSquircleDist` + `getPointAlpha` SDF pair that uses `sqrt(sqrt(dot(d², d²)))` for the superellipse distance, removing `pow()` calls with arbitrary exponents.
- **Pre-computed uniforms** — center and half-size are now computed on the CPU side and passed as `vec4 bounds` (xy = center, zw = halfSize), eliminating per-pixel coordinate arithmetic. `actorSize` replaces the old `pixelStep` uniform so the shader multiplies instead of dividing.
- **Hardcoded border color** — `BORDER_COLOR` is a compile-time `#define` instead of a runtime uniform, reducing uniform upload cost.

## Performance optimizations

- **Uniform location caching** — `get_uniform_location()` results are now cached per-instance with a `#uniformsCached` guard; values are only re-uploaded when they actually change (per-field `NaN`-initialized dirty tracking).
- **Shadow style cache** — `updateShadowActorStyle()` compares 12 individual numeric fields (radius, offsets, blur, spread, opacity, padding sides, hidden state) instead of building a template-literal cache key, avoiding string allocation and GC pressure on every focus/resize event.
- **Managed actor `Set`** — `onRestacked` iterates a `Set<RoundedWindowActor>` instead of scanning all actors from `global.get_window_actors()`, turning O(n) global lookups into O(managed) iterations.
- **App-type detection** — the `/proc/<pid>/map_files` symlink-target enumeration now reads in batches of 64 entries, with a chunked 16 KB fallback for `/proc/<pid>/maps` (overlap-safe for needle boundary detection). A `.exe` fast-path skips I/O entirely for Wine/Proton windows. Results are cached per `wm_class_instance`.
- **Geometry pre-computation** — frame rectangles are pre-fetched once per event cycle and passed through, preventing redundant `get_frame_rect()` / `get_buffer_rect()` calls across bounds, offset, and shadow calculations.
- **Wayland shadow insets cache** — `computeShadowInsets()` is called once per window and stored in `WindowEffectState.cachedShadowInsets`, avoiding `get_wm_class_instance()` + `toLowerCase()` on every resize event.

## Robustness & lifecycle fixes

- **Duplicate effect guard** — `onAddEffect` is now idempotent; re-entry for the same actor is a no-op, preventing redundant effect registration and state-map collisions.
- **Signal disconnection safety** — all `disconnect()` calls verify the handler ID is valid before attempting removal, preventing "no handler with id" errors during disable.
- **GObject type collision guard** — `RoundedCornersEffect` and `ClipShadowEffect` register with explicit `GTypeName` values, avoiding "Type name already registered" errors when another extension defines a GObject with the same auto-generated name.
- **Texture GC crash prevention** — the extension proactively re-applies effects when a window's texture reference changes (e.g. after a GNOME Shell garbage collection sweep), preventing use-after-free crashes.
- **Geometry validation** — effects are not applied to windows with 0×0 dimensions or invalid frame rects.

## Extension entry point simplification

`src/extension.ts` went from **~130 → ~55 lines**. The `enable()` path no longer initializes GSettings, exports a D-Bus service, patches overview/workspace-switch methods, or watches preference changes. The `disable()` path simply clears the injection manager, disables effects, and cleans up the app-type cache.
