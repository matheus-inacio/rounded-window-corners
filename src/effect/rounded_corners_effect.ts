import type {Bounds, BoxShadow} from '../utils/types.js';

import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';

import {BORDER_WIDTH, GLOBAL_ROUNDED_CORNER_SETTINGS} from '../utils/config.js';
import {SHADOW_PADDING} from '../utils/constants.js';
import {readShader} from '../utils/file.js';
import {logTime, logTimeEnd} from '../utils/log.js';

const DIVISOR_SIGMA = 1.5;

let shaderDeclarations: string | null = null;
let shaderCode: string | null = null;

export async function loadRoundedCornersShader() {
    if (shaderDeclarations !== null) return;

    [shaderDeclarations, shaderCode] = await readShader(
        import.meta.url,
        'rounded_corners.frag',
    );
}

export function unloadRoundedCornersShader() {
    shaderDeclarations = null;
    shaderCode = null;
}

class UniformLocations {
    bounds = -1;
    clipRadius = -1;
    showBorder = -1;
    borderedAreaBounds = -1;
    borderedAreaClipRadius = -1;
    actorSize = -1;
    shadowOffset = -1;
    shadowSigma = -1;
    shadowSpread = -1;
    shadowOpacity = -1;
}

export const RoundedCornersEffect = GObject.registerClass(
    {
        GTypeName: 'RoundedWindowsLite_RoundedCornersEffect',
    },
    class Effect extends Shell.GLSLEffect {
        #bounds = [0, 0, 0, 0];
        #borderedAreaBounds = [0, 0, 0, 0];
        #actorSize = [0, 0];
        #clipRadius = [0];
        #showBorderUniform = [0];
        #borderedAreaRadiusUniform = [0];
        
        #shadowOffsetUniform = [0, 0, 0, 0, 0, 0];
        #shadowSigmaUniform = [0, 0, 0];
        #shadowSpreadUniform = [0, 0, 0];
        #shadowOpacityUniform = [0, 0, 0];

        #lastBounds = [Number.NaN, Number.NaN, Number.NaN, Number.NaN];
        #lastRadius = Number.NaN;
        #lastShowBorder = Number.NaN;
        #lastBorderedAreaBounds = [Number.NaN, Number.NaN, Number.NaN, Number.NaN];
        #lastBorderedAreaRadius = Number.NaN;
        #lastActorSize = [Number.NaN, Number.NaN];
        
        #lastShadowOffset = [Number.NaN, Number.NaN, Number.NaN, Number.NaN, Number.NaN, Number.NaN];
        #lastShadowSigma = [Number.NaN, Number.NaN, Number.NaN];
        #lastShadowSpread = [Number.NaN, Number.NaN, Number.NaN];
        #lastShadowOpacity = [Number.NaN, Number.NaN, Number.NaN];

        #uniformLocations = new UniformLocations();
        #uniformsCached = false;

        // Pre-allocated arrays to avoid Garbage Collection blocks on render
        #sOffset = [0, 0, 0, 0, 0, 0];
        #sSigma = [0, 0, 0];
        #sSpread = [0, 0, 0];
        #sOpacity = [0, 0, 0];

        vfunc_build_pipeline() {
            this.add_glsl_snippet(
                Cogl.SnippetHook.FRAGMENT,
                shaderDeclarations!,
                shaderCode!,
                false,
            );
        }

        vfunc_modify_paint_volume(volume: Clutter.PaintVolume): boolean {
            const padding = SHADOW_PADDING;
            const origin = volume.get_origin();
            
            if (origin) {
                origin.x -= padding;
                origin.y -= padding;
                volume.set_origin(origin);
            }

            volume.set_width(volume.get_width() + padding * 2);
            volume.set_height(volume.get_height() + padding * 2);

            return true;
        }

        updateUniforms(windowBounds: Bounds, showBorder: boolean, shadowSettings: BoxShadow[]) {
            logTime('updateUniforms');
            
            const showBorderFlag = showBorder ? 1 : 0;
            const outerRadius = GLOBAL_ROUNDED_CORNER_SETTINGS.borderRadius;
            const {padding} = GLOBAL_ROUNDED_CORNER_SETTINGS;

            const x1 = windowBounds.x1 + padding.left;
            const y1 = windowBounds.y1 + padding.top;
            const x2 = windowBounds.x2 - padding.right;
            const y2 = windowBounds.y2 - padding.bottom;

            const halfWidth = (x2 - x1) * 0.5;
            const halfHeight = (y2 - y1) * 0.5;
            const centerX = x1 + halfWidth;
            const centerY = y1 + halfHeight;

            this.#bounds[0] = centerX;
            this.#bounds[1] = centerY;
            this.#bounds[2] = halfWidth;
            this.#bounds[3] = halfHeight;

            this.#borderedAreaBounds[0] = centerX;
            this.#borderedAreaBounds[1] = centerY;
            this.#borderedAreaBounds[2] = Math.max(halfWidth - BORDER_WIDTH, 0);
            this.#borderedAreaBounds[3] = Math.max(halfHeight - BORDER_WIDTH, 0);

            let borderedAreaRadius = Math.max(outerRadius - BORDER_WIDTH, 0.0);
            const actorWidth = this.actor.get_width();
            const actorHeight = this.actor.get_height();

            if (actorWidth <= 0 || actorHeight <= 0) return;

            this.#actorSize[0] = actorWidth;
            this.#actorSize[1] = actorHeight;

            let radius = outerRadius;
            const maxRadius = Math.min(halfWidth * 2, halfHeight * 2);

            if (radius > maxRadius) {
                radius = maxRadius;
            }

            if (outerRadius > 0) {
                borderedAreaRadius *= radius / outerRadius;
            } else {
                borderedAreaRadius = 0;
            }

            // Assign values to pre-allocated properties rather than generating new array instances
            this.#sOffset[0] = shadowSettings[0].horizontalOffset;
            this.#sOffset[1] = shadowSettings[0].verticalOffset;
            this.#sOffset[2] = shadowSettings[1].horizontalOffset;
            this.#sOffset[3] = shadowSettings[1].verticalOffset;
            this.#sOffset[4] = shadowSettings[2].horizontalOffset;
            this.#sOffset[5] = shadowSettings[2].verticalOffset;

            this.#sSigma[0] = shadowSettings[0].blurOffset / DIVISOR_SIGMA;
            this.#sSigma[1] = shadowSettings[1].blurOffset / DIVISOR_SIGMA;
            this.#sSigma[2] = shadowSettings[2].blurOffset / DIVISOR_SIGMA;

            this.#sSpread[0] = shadowSettings[0].spreadRadius;
            this.#sSpread[1] = shadowSettings[1].spreadRadius;
            this.#sSpread[2] = shadowSettings[2].spreadRadius;

            this.#sOpacity[0] = shadowSettings[0].opacity;
            this.#sOpacity[1] = shadowSettings[1].opacity;
            this.#sOpacity[2] = shadowSettings[2].opacity;

            this.#setUniforms(
                this.#bounds,
                radius,
                showBorderFlag,
                this.#borderedAreaBounds,
                borderedAreaRadius,
                this.#actorSize
            );
            
            logTimeEnd('updateUniforms');
        }

        #setUniforms(
            bounds: number[],
            radius: number,
            showBorderFlag: number,
            borderedAreaBounds: number[],
            borderedAreaRadius: number,
            actorSize: number[]
        ) {
            if (
                this.#lastRadius === radius &&
                this.#lastShowBorder === showBorderFlag &&
                this.#lastBorderedAreaRadius === borderedAreaRadius &&
                float4Equal(this.#lastBounds, bounds) &&
                float4Equal(this.#lastBorderedAreaBounds, borderedAreaBounds) &&
                float2Equal(this.#lastActorSize, actorSize) &&
                floatArrayEqual(this.#lastShadowOffset, this.#sOffset) &&
                floatArrayEqual(this.#lastShadowSigma, this.#sSigma) &&
                floatArrayEqual(this.#lastShadowSpread, this.#sSpread) &&
                floatArrayEqual(this.#lastShadowOpacity, this.#sOpacity)
            ) {
                return;
            }

            if (!this.#cacheUniformLocations()) return;

            const uniforms = this.#uniformLocations;

            this.set_uniform_float(uniforms.bounds, 4, bounds);

            this.#clipRadius[0] = radius;
            this.#showBorderUniform[0] = showBorderFlag;
            this.#borderedAreaRadiusUniform[0] = borderedAreaRadius;

            this.set_uniform_float(uniforms.clipRadius, 1, this.#clipRadius);
            this.set_uniform_float(uniforms.showBorder, 1, this.#showBorderUniform);
            this.set_uniform_float(uniforms.borderedAreaBounds, 4, borderedAreaBounds);
            this.set_uniform_float(uniforms.borderedAreaClipRadius, 1, this.#borderedAreaRadiusUniform);
            this.set_uniform_float(uniforms.actorSize, 2, actorSize);
            
            copyFloatArray(this.#shadowOffsetUniform, this.#sOffset);
            copyFloatArray(this.#shadowSigmaUniform, this.#sSigma);
            copyFloatArray(this.#shadowSpreadUniform, this.#sSpread);
            copyFloatArray(this.#shadowOpacityUniform, this.#sOpacity);
            
            this.set_uniform_float(uniforms.shadowOffset, 2, this.#shadowOffsetUniform);
            this.set_uniform_float(uniforms.shadowSigma, 1, this.#shadowSigmaUniform);
            this.set_uniform_float(uniforms.shadowSpread, 1, this.#shadowSpreadUniform);
            this.set_uniform_float(uniforms.shadowOpacity, 1, this.#shadowOpacityUniform);

            copyFloat4(this.#lastBounds, bounds);
            copyFloat4(this.#lastBorderedAreaBounds, borderedAreaBounds);
            copyFloat2(this.#lastActorSize, actorSize);
            copyFloatArray(this.#lastShadowOffset, this.#sOffset);
            
            this.#lastRadius = radius;
            this.#lastShowBorder = showBorderFlag;
            this.#lastBorderedAreaRadius = borderedAreaRadius;
            
            copyFloatArray(this.#lastShadowSigma, this.#sSigma);
            copyFloatArray(this.#lastShadowSpread, this.#sSpread);
            copyFloatArray(this.#lastShadowOpacity, this.#sOpacity);

            this.queue_repaint();
        }

        #cacheUniformLocations() {
            if (this.#uniformsCached) return true;

            const uniforms = this.#uniformLocations;
            uniforms.bounds = this.get_uniform_location('bounds');
            uniforms.clipRadius = this.get_uniform_location('clipRadius');
            uniforms.showBorder = this.get_uniform_location('showBorder');
            uniforms.borderedAreaBounds = this.get_uniform_location('borderedAreaBounds');
            uniforms.borderedAreaClipRadius = this.get_uniform_location('borderedAreaClipRadius');
            uniforms.actorSize = this.get_uniform_location('actorSize');
            uniforms.shadowOffset = this.get_uniform_location('shadowOffset');
            uniforms.shadowSigma = this.get_uniform_location('shadowSigma');
            uniforms.shadowSpread = this.get_uniform_location('shadowSpread');
            uniforms.shadowOpacity = this.get_uniform_location('shadowOpacity');

            const ready =
                uniforms.bounds >= 0 &&
                uniforms.clipRadius >= 0 &&
                uniforms.showBorder >= 0 &&
                uniforms.borderedAreaBounds >= 0 &&
                uniforms.borderedAreaClipRadius >= 0 &&
                uniforms.actorSize >= 0 &&
                uniforms.shadowOffset >= 0 &&
                uniforms.shadowSigma >= 0 &&
                uniforms.shadowSpread >= 0 &&
                uniforms.shadowOpacity >= 0;

            if (ready) {
                this.#uniformsCached = true;
            }

            return ready;
        }
    },
);

function float4Equal(a: readonly number[], b: readonly number[]) {
    return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

function float2Equal(a: readonly number[], b: readonly number[]) {
    return a[0] === b[0] && a[1] === b[1];
}

function copyFloat4(dest: number[], src: readonly number[]) {
    dest[0] = src[0];
    dest[1] = src[1];
    dest[2] = src[2];
    dest[3] = src[3];
}

function copyFloat2(dest: number[], src: readonly number[]) {
    dest[0] = src[0];
    dest[1] = src[1];
}

function floatArrayEqual(a: readonly number[], b: readonly number[]) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

function copyFloatArray(dest: number[], src: readonly number[]) {
    for (let i = 0; i < src.length; i++) {
        dest[i] = src[i];
    }
}