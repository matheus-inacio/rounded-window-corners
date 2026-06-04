/**
 * @file Clips shadows for windows.
 *
 * Needed because of this issue:
 * https://gitlab.gnome.org/GNOME/gnome-shell/-/issues/4474
 */

import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

import {readShader} from '../utils/file.js';

let shaderDeclarations: string | null = null;
let shaderCode: string | null = null;

/** Load the clip shadow shader asynchronously. Must be called before using the effect. */
export async function loadClipShadowShader() {
    if (shaderDeclarations !== null) return;
    [shaderDeclarations, shaderCode] = await readShader(
        import.meta.url,
        'shader/clip_shadow.frag',
    );
}

/** Unload the cached shader source. */
export function unloadClipShadowShader() {
    shaderDeclarations = null;
    shaderCode = null;
}

export const ClipShadowEffect = GObject.registerClass(
    {
        GTypeName: 'RoundedWindowsLite_ClipShadowEffect',
    },
    class extends Shell.GLSLEffect {
        vfunc_build_pipeline() {
            this.add_glsl_snippet(
                Cogl.SnippetHook.FRAGMENT,
                shaderDeclarations!,
                shaderCode!,
                false,
            );
        }
    },
);
