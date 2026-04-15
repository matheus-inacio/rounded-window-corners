/** @file Binds the actual corner rounding shader to the windows. */

import type {Bounds, RoundedCornerSettings} from '../utils/types.js';

import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

import {BORDER_WIDTH} from '../utils/config.js';
import {readShader} from '../utils/file.js';

const [declarations, code] = readShader(
    import.meta.url,
    'shader/rounded_corners.frag',
);

class UniformLocations {
    bounds = -1;
    clipRadius = -1;
    borderWidth = -1;
    borderColor = -1;
    borderedAreaBounds = -1;
    borderedAreaClipRadius = -1;
    pixelStep = -1;
}

export const RoundedCornersEffect = GObject.registerClass(
    {},
    class Effect extends Shell.GLSLEffect {
        #bounds = [0, 0, 0, 0];
        #borderedAreaBounds = [0, 0, 0, 0];
        #pixelStep = [0, 0];
        #clipRadius = [0];
        #borderWidthUniform = [0];
        #borderedAreaRadiusUniform = [0];

        #lastBounds = [Number.NaN, Number.NaN, Number.NaN, Number.NaN];
        #lastRadius = Number.NaN;
        #lastBorderWidth = Number.NaN;
        #lastBorderColor: [number, number, number, number] = [
            Number.NaN,
            Number.NaN,
            Number.NaN,
            Number.NaN,
        ];
        #lastBorderedAreaBounds = [
            Number.NaN,
            Number.NaN,
            Number.NaN,
            Number.NaN,
        ];
        #lastBorderedAreaRadius = Number.NaN;
        #lastPixelStep = [Number.NaN, Number.NaN];
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
         * For more information, see the comments in the shader file.
         *
         * @param config - Rounded corners configuration
         * @param windowBounds - Bounds of the window without padding
         * @param showBorder - Should draw borders
         */
        updateUniforms(
            config: RoundedCornerSettings,
            windowBounds: Bounds,
            showBorder: boolean,
        ) {
            const borderWidth = showBorder ? BORDER_WIDTH : 0;
            const borderColor = config.borderColor;

            const outerRadius = config.borderRadius;
            const {padding} = config;

            this.#bounds[0] = windowBounds.x1 + padding.left;
            this.#bounds[1] = windowBounds.y1 + padding.top;
            this.#bounds[2] = windowBounds.x2 - padding.right;
            this.#bounds[3] = windowBounds.y2 - padding.bottom;

            this.#borderedAreaBounds[0] = this.#bounds[0] + borderWidth;
            this.#borderedAreaBounds[1] = this.#bounds[1] + borderWidth;
            this.#borderedAreaBounds[2] = this.#bounds[2] - borderWidth;
            this.#borderedAreaBounds[3] = this.#bounds[3] - borderWidth;

            let borderedAreaRadius = Math.max(outerRadius - borderWidth, 0.0);

            const actorWidth = this.actor.get_width();
            const actorHeight = this.actor.get_height();
            if (actorWidth <= 0 || actorHeight <= 0) {
                return;
            }

            this.#pixelStep[0] = 1 / actorWidth;
            this.#pixelStep[1] = 1 / actorHeight;

            let radius = outerRadius * 2.0;
            const maxRadius = Math.min(
                this.#bounds[2] - this.#bounds[0],
                this.#bounds[3] - this.#bounds[1],
            );
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
                borderWidth,
                borderColor,
                this.#borderedAreaBounds,
                borderedAreaRadius,
                this.#pixelStep,
            );
        }

        #setUniforms(
            bounds: number[],
            radius: number,
            borderWidth: number,
            borderColor: [number, number, number, number],
            borderedAreaBounds: number[],
            borderedAreaRadius: number,
            pixelStep: number[],
        ) {
            if (
                this.#lastRadius === radius &&
                this.#lastBorderWidth === borderWidth &&
                this.#lastBorderedAreaRadius === borderedAreaRadius &&
                float4Equal(this.#lastBounds, bounds) &&
                float4Equal(this.#lastBorderColor, borderColor) &&
                float4Equal(this.#lastBorderedAreaBounds, borderedAreaBounds) &&
                float2Equal(this.#lastPixelStep, pixelStep)
            ) {
                return;
            }

            if (!this.#cacheUniformLocations()) {
                return;
            }

            const uniforms = this.#uniformLocations;
            this.set_uniform_float(uniforms.bounds, 4, bounds);
            this.#clipRadius[0] = radius;
            this.#borderWidthUniform[0] = borderWidth;
            this.#borderedAreaRadiusUniform[0] = borderedAreaRadius;
            this.set_uniform_float(uniforms.clipRadius, 1, this.#clipRadius);
            this.set_uniform_float(
                uniforms.borderWidth,
                1,
                this.#borderWidthUniform,
            );
            this.set_uniform_float(uniforms.borderColor, 4, borderColor);
            this.set_uniform_float(
                uniforms.borderedAreaBounds,
                4,
                borderedAreaBounds,
            );
            this.set_uniform_float(
                uniforms.borderedAreaClipRadius,
                1,
                this.#borderedAreaRadiusUniform,
            );
            this.set_uniform_float(uniforms.pixelStep, 2, pixelStep);

            this.#lastBounds[0] = bounds[0];
            this.#lastBounds[1] = bounds[1];
            this.#lastBounds[2] = bounds[2];
            this.#lastBounds[3] = bounds[3];
            this.#lastRadius = radius;
            this.#lastBorderWidth = borderWidth;
            this.#lastBorderColor[0] = borderColor[0];
            this.#lastBorderColor[1] = borderColor[1];
            this.#lastBorderColor[2] = borderColor[2];
            this.#lastBorderColor[3] = borderColor[3];
            this.#lastBorderedAreaBounds[0] = borderedAreaBounds[0];
            this.#lastBorderedAreaBounds[1] = borderedAreaBounds[1];
            this.#lastBorderedAreaBounds[2] = borderedAreaBounds[2];
            this.#lastBorderedAreaBounds[3] = borderedAreaBounds[3];
            this.#lastBorderedAreaRadius = borderedAreaRadius;
            this.#lastPixelStep[0] = pixelStep[0];
            this.#lastPixelStep[1] = pixelStep[1];
            this.queue_repaint();
        }

        #cacheUniformLocations() {
            if (this.#uniformsCached) {
                return true;
            }

            const uniforms = this.#uniformLocations;
            uniforms.bounds = this.get_uniform_location('bounds');
            uniforms.clipRadius = this.get_uniform_location('clipRadius');
            uniforms.borderWidth = this.get_uniform_location('borderWidth');
            uniforms.borderColor = this.get_uniform_location('borderColor');
            uniforms.borderedAreaBounds =
                this.get_uniform_location('borderedAreaBounds');
            uniforms.borderedAreaClipRadius = this.get_uniform_location(
                'borderedAreaClipRadius',
            );
            uniforms.pixelStep = this.get_uniform_location('pixelStep');

            const ready =
                uniforms.bounds >= 0 &&
                uniforms.clipRadius >= 0 &&
                uniforms.borderWidth >= 0 &&
                uniforms.borderColor >= 0 &&
                uniforms.borderedAreaBounds >= 0 &&
                uniforms.borderedAreaClipRadius >= 0 &&
                uniforms.pixelStep >= 0;

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
