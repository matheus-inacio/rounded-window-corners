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

class Uniforms {
    bounds = 0;
    clipRadius = 0;
    borderWidth = 0;
    borderColor = 0;
    borderedAreaBounds = 0;
    borderedAreaClipRadius = 0;
    pixelStep = 0;
}

export const RoundedCornersEffect = GObject.registerClass(
    {},
    class Effect extends Shell.GLSLEffect {
        #lastBounds: number[] = [];
        #lastRadius = Number.NaN;
        #lastBorderWidth = Number.NaN;
        #lastBorderColor: [number, number, number, number] = [
            Number.NaN,
            Number.NaN,
            Number.NaN,
            Number.NaN,
        ];
        #lastBorderedAreaBounds: number[] = [];
        #lastBorderedAreaRadius = Number.NaN;
        #lastPixelStep: number[] = [];

        /**
         * To store a uniform value, we need to know its location in the shader,
         * which is done by calling `this.get_uniform_location()`. This is
         * expensive, so we cache the location of uniforms when the shader is
         * created.
         */
        static uniforms: Uniforms = new Uniforms();

        constructor() {
            super();

            for (const k in Effect.uniforms) {
                Effect.uniforms[k as keyof Uniforms] =
                    this.get_uniform_location(k);
            }
        }

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
         * @param scaleFactor - Desktop scaling factor
         * @param config - Rounded corners configuration
         * @param windowBounds - Bounds of the window without padding
         * @param showBorder - Should draw borders
         */
        updateUniforms(
            scaleFactor: number,
            config: RoundedCornerSettings,
            windowBounds: Bounds,
            showBorder: boolean,
        ) {
            const borderWidth = showBorder ? BORDER_WIDTH * scaleFactor : 0;
            const borderColor = config.borderColor;

            const outerRadius = config.borderRadius * scaleFactor;
            const {padding} = config;

            const bounds = [
                windowBounds.x1 + padding.left * scaleFactor,
                windowBounds.y1 + padding.top * scaleFactor,
                windowBounds.x2 - padding.right * scaleFactor,
                windowBounds.y2 - padding.bottom * scaleFactor,
            ];

            const borderedAreaBounds = [
                bounds[0] + borderWidth,
                bounds[1] + borderWidth,
                bounds[2] - borderWidth,
                bounds[3] - borderWidth,
            ];

            let borderedAreaRadius = Math.max(outerRadius - borderWidth, 0.0);

            const actorWidth = this.actor.get_width();
            const actorHeight = this.actor.get_height();
            if (actorWidth <= 0 || actorHeight <= 0) {
                return;
            }

            const pixelStep = [1 / actorWidth, 1 / actorHeight];

            let radius = outerRadius * 2.0;
            const maxRadius = Math.min(
                bounds[2] - bounds[0],
                bounds[3] - bounds[1],
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
                bounds,
                radius,
                borderWidth,
                borderColor,
                borderedAreaBounds,
                borderedAreaRadius,
                pixelStep,
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
                arraysEqual(this.#lastBounds, bounds) &&
                arraysEqual(this.#lastBorderColor, borderColor) &&
                arraysEqual(this.#lastBorderedAreaBounds, borderedAreaBounds) &&
                arraysEqual(this.#lastPixelStep, pixelStep)
            ) {
                return;
            }

            const uniforms = Effect.uniforms;
            this.set_uniform_float(uniforms.bounds, 4, bounds);
            this.set_uniform_float(uniforms.clipRadius, 1, [radius]);
            this.set_uniform_float(uniforms.borderWidth, 1, [borderWidth]);
            this.set_uniform_float(uniforms.borderColor, 4, borderColor);
            this.set_uniform_float(
                uniforms.borderedAreaBounds,
                4,
                borderedAreaBounds,
            );
            this.set_uniform_float(uniforms.borderedAreaClipRadius, 1, [
                borderedAreaRadius,
            ]);
            this.set_uniform_float(uniforms.pixelStep, 2, pixelStep);

            this.#lastBounds = bounds;
            this.#lastRadius = radius;
            this.#lastBorderWidth = borderWidth;
            this.#lastBorderColor = [...borderColor] as [
                number,
                number,
                number,
                number,
            ];
            this.#lastBorderedAreaBounds = borderedAreaBounds;
            this.#lastBorderedAreaRadius = borderedAreaRadius;
            this.#lastPixelStep = pixelStep;
            this.queue_repaint();
        }
    },
);

function arraysEqual(a: readonly number[], b: readonly number[]) {
    if (a.length !== b.length) {
        return false;
    }

    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
            return false;
        }
    }

    return true;
}
