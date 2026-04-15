/**
 * @file Contains a single function - {@link boxShadowCss}, which converts
 * {@link BoxShadow} objects into CSS code for the shadow.
 */

import type {BoxShadow} from './types.js';

/**
 * Generate a CSS style for a box shadow from the provided {@link BoxShadow}
 * object.
 *
 * @param shadow - The settings for the box shadow.
 * @returns The box-shadow CSS string.
 */
export function boxShadowCss(shadow: BoxShadow) {
    return `box-shadow: ${shadow.horizontalOffset}px
          ${shadow.verticalOffset}px
          ${shadow.blurOffset}px
          ${shadow.spreadRadius}px
          rgba(0,0,0, ${shadow.opacity / 100})`;
}
