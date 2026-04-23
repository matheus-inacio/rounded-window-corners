/** @file Binds the actual corner rounding shader to the windows. */

import type {Bounds} from '../utils/types.js';

import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

import {BORDER_WIDTH, GLOBAL_ROUNDED_CORNER_SETTINGS} from '../utils/config.js';
import {readShader} from '../utils/file.js';

const [declarations, code] = readShader(
    import.meta.url,
    'shader/rounded_corners.frag',
);

class UniformLocations {
    bounds = -1;
    clipRadius = -1;
    showBorder = -1; 
    borderedAreaBounds = -1;
    borderedAreaClipRadius = -1;
    actorSize = -1; 
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

        #lastBounds = [Number.NaN, Number.NaN, Number.NaN, Number.NaN];
        #lastRadius = Number.NaN;
        #lastShowBorder = Number.NaN;
        #lastBorderedAreaBounds = [
            Number.NaN,
            Number.NaN,
            Number.NaN,
            Number.NaN,
        ];
        #lastBorderedAreaRadius = Number.NaN;
        #lastActorSize = [Number.NaN, Number.NaN]; 
        #uniformLocations = new UniformLocations();
        #uniformsCached = false;

        vfunc_build_pipeline() {
            this.add_glsl_snippet(
                Cogl.SnippetHook.FRAGMENT,
                declarations,
                code,
                false,
            );
        }

        /**
         * Update uniforms of the shader.
         *
         * @param windowBounds - Bounds of the window without padding
         * @param showBorder - Should draw borders
         */
        updateUniforms(windowBounds: Bounds, showBorder: boolean) {
            // Convert boolean to integer 1 or 0 for the shader
            const showBorderFlag = showBorder ? 1 : 0;

            const outerRadius = GLOBAL_ROUNDED_CORNER_SETTINGS.borderRadius;
            const {padding} = GLOBAL_ROUNDED_CORNER_SETTINGS;

            const x1 = windowBounds.x1 + padding.left;
            const y1 = windowBounds.y1 + padding.top;
            const x2 = windowBounds.x2 - padding.right;
            const y2 = windowBounds.y2 - padding.bottom;

            // Pre-calculate Center and Half-Size for the shader
            const halfWidth = (x2 - x1) * 0.5;
            const halfHeight = (y2 - y1) * 0.5;
            const centerX = x1 + halfWidth;
            const centerY = y1 + halfHeight;

            this.#bounds[0] = centerX;
            this.#bounds[1] = centerY;
            this.#bounds[2] = halfWidth;
            this.#bounds[3] = halfHeight;

            // Bordered area shares the same center. Always calculate using the constant width.
            this.#borderedAreaBounds[0] = centerX;
            this.#borderedAreaBounds[1] = centerY;
            this.#borderedAreaBounds[2] = Math.max(halfWidth - BORDER_WIDTH, 0);
            this.#borderedAreaBounds[3] = Math.max(halfHeight - BORDER_WIDTH, 0);

            let borderedAreaRadius = Math.max(outerRadius - BORDER_WIDTH, 0.0);

            const actorWidth = this.actor.get_width();
            const actorHeight = this.actor.get_height();
            if (actorWidth <= 0 || actorHeight <= 0) {
                return;
            }

            // Pass the raw size, no division needed
            this.#actorSize[0] = actorWidth;
            this.#actorSize[1] = actorHeight;

            let radius = outerRadius * 2.0;
            const maxRadius = Math.min(halfWidth * 2, halfHeight * 2);
            if (radius > maxRadius) {
                radius = maxRadius;
            }

            if (outerRadius > 0) {
                borderedAreaRadius *= radius / outerRadius;
            } else {
                borderedAreaRadius = 0;
            }

            this.#setUniforms(
                this.#bounds,
                radius,
                showBorderFlag,
                this.#borderedAreaBounds,
                borderedAreaRadius,
                this.#actorSize,
            );
        }

        #setUniforms(
            bounds: number[],
            radius: number,
            showBorderFlag: number,
            borderedAreaBounds: number[],
            borderedAreaRadius: number,
            actorSize: number[],
        ) {
            if (
                this.#lastRadius === radius &&
                this.#lastShowBorder === showBorderFlag &&
                this.#lastBorderedAreaRadius === borderedAreaRadius &&
                float4Equal(this.#lastBounds, bounds) &&
                float4Equal(this.#lastBorderedAreaBounds, borderedAreaBounds) &&
                float2Equal(this.#lastActorSize, actorSize)
            ) {
                return;
            }

            if (!this.#cacheUniformLocations()) {
                return;
            }

            const uniforms = this.#uniformLocations;
            this.set_uniform_float(uniforms.bounds, 4, bounds);
            
            this.#clipRadius[0] = radius;
            this.#showBorderUniform[0] = showBorderFlag;
            this.#borderedAreaRadiusUniform[0] = borderedAreaRadius;
            
            this.set_uniform_float(uniforms.clipRadius, 1, this.#clipRadius);
            
            // Note: GLSL bool uniforms require integer setting via the host. 
            // If your Shell version lacks set_uniform_int, you may need to revert to float.
            this.set_uniform_float(uniforms.showBorder, 1, this.#showBorderUniform);
            
            this.set_uniform_float(uniforms.borderedAreaBounds, 4, borderedAreaBounds);
            this.set_uniform_float(uniforms.borderedAreaClipRadius, 1, this.#borderedAreaRadiusUniform);
            this.set_uniform_float(uniforms.actorSize, 2, actorSize);

            this.#lastBounds[0] = bounds[0];
            this.#lastBounds[1] = bounds[1];
            this.#lastBounds[2] = bounds[2];
            this.#lastBounds[3] = bounds[3];
            this.#lastRadius = radius;
            this.#lastShowBorder = showBorderFlag;
            this.#lastBorderedAreaBounds[0] = borderedAreaBounds[0];
            this.#lastBorderedAreaBounds[1] = borderedAreaBounds[1];
            this.#lastBorderedAreaBounds[2] = borderedAreaBounds[2];
            this.#lastBorderedAreaBounds[3] = borderedAreaBounds[3];
            this.#lastBorderedAreaRadius = borderedAreaRadius;
            this.#lastActorSize[0] = actorSize[0];
            this.#lastActorSize[1] = actorSize[1];
            this.queue_repaint();
        }

        #cacheUniformLocations() {
            if (this.#uniformsCached) {
                return true;
            }

            const uniforms = this.#uniformLocations;
            uniforms.bounds = this.get_uniform_location('bounds');
            uniforms.clipRadius = this.get_uniform_location('clipRadius');
            uniforms.showBorder = this.get_uniform_location('showBorder');
            uniforms.borderedAreaBounds = this.get_uniform_location('borderedAreaBounds');
            uniforms.borderedAreaClipRadius = this.get_uniform_location('borderedAreaClipRadius');
            uniforms.actorSize = this.get_uniform_location('actorSize'); 

            const ready =
                uniforms.bounds >= 0 &&
                uniforms.clipRadius >= 0 &&
                uniforms.showBorder >= 0 &&
                uniforms.borderedAreaBounds >= 0 &&
                uniforms.borderedAreaClipRadius >= 0 &&
                uniforms.actorSize >= 0; 

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