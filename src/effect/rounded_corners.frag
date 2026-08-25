#define BORDER_COLOR vec4(0.2, 0.2, 0.2, 1.0)

// W3C specifies blur / 2.0. However, GTK's native box-blur often looks wider.
// If the shadow still looks too small, lower this to 1.8 or 1.5 to widen the blur.
#define SIGMA_DIVISOR 1.5 

uniform vec4 bounds;
uniform vec4 borderedAreaBounds; 

uniform float clipRadius;
uniform float borderedAreaClipRadius;

uniform float showBorder;
uniform vec2 actorSize; 

uniform vec2 shadowOffset[3];
uniform float shadowBlur[3];
uniform float shadowSpread[3];
uniform float shadowOpacity[3];

float getPointAlpha(vec2 p, vec4 bndInfo, float rad) {
    vec2 q = abs(p - bndInfo.xy) - (bndInfo.zw - rad);
    float dist = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
    return clamp(0.5 - (dist - rad), 0.0, 1.0);
}

// Analytical approximation for 2D Gaussian Integral on rounded rectangles
vec2 erf(vec2 x) {
    vec2 s = sign(x), a = abs(x);
    x = vec2(1.0) + (vec2(0.278393) + (vec2(0.230389) + vec2(0.078108) * (a * a)) * a) * a;
    x *= x;
    return s - s / (x * x);
}

// Standard gaussian function used for weighting samples
float gaussian(float x, float sigma) {
    return exp(-(x * x) / (2.0 * sigma * sigma)) / (2.50662827 * sigma);
}

// Returns the blurred mask along the X dimension
float roundedBoxShadowX(float x, float y, float sigma, float corner, vec2 halfSize) {
    float delta = min(halfSize.y - corner - abs(y), 0.0);
    float curved = halfSize.x - corner + sqrt(max(0.0, corner * corner - delta * delta));
    vec2 integral = vec2(0.5) + vec2(0.5) * erf((vec2(x) + vec2(-curved, curved)) * (0.70710678 / sigma));
    return integral.y - integral.x;
}

// Returns the mask for the calculated shadow
float roundedBoxShadow(vec2 point, vec2 halfSize, float sigma, float corner) {
    if (sigma < 0.01) {
        // Anti-aliased fallback for 0px blur shadows (like the 1px outline layer)
        vec2 q = abs(point) - (halfSize - corner);
        float dist = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - corner;
        return clamp(0.5 - dist, 0.0, 1.0);
    }

    float lowerBound = point.y - halfSize.y;
    float upperBound = point.y + halfSize.y;
    
    // Increased from 3.0 to 4.0 to capture the ultra-soft tails of the CSS shadow
    float start = clamp(-4.0 * sigma, lowerBound, upperBound);
    float end = clamp(4.0 * sigma, lowerBound, upperBound);

    if (start >= end) {
        return 0.0;
    }

    // Increased to 24 samples to handle the wider 4-sigma range perfectly
    float stepSize = (end - start) / 24.0;
    float y = start + stepSize * 0.5;
    float accumulatedValue = 0.0;
    
    for (int i = 0; i < 24; i++) {
        accumulatedValue += roundedBoxShadowX(point.x, point.y - y, sigma, corner, halfSize) * gaussian(y, sigma) * stepSize;
        y += stepSize;
    }

    return accumulatedValue;
}

void main() {
    vec2 p = cogl_tex_coord0_in.xy * actorSize;

    vec4 windowColor = cogl_color_out;
    float pointAlpha = getPointAlpha(p, bounds, clipRadius);
    windowColor *= pointAlpha; // Masks out the sharp window corners
    
    float totalShadowAlpha = 0.0;
    for (int i = 0; i < 3; i++) {
        float blur = shadowBlur[i];
        float sigma = blur / SIGMA_DIVISOR; 
        float spread = shadowSpread[i];
        
        vec2 center = bounds.xy + shadowOffset[i];
        vec2 halfSize = bounds.zw + spread;
        float corner = max(clipRadius + spread, 0.0);
        
        float alpha = roundedBoxShadow(p - center, halfSize, sigma, corner);
        alpha = clamp(alpha, 0.0, 1.0) * (shadowOpacity[i] / 100.0);
        
        // Commutative alpha blending: A_total = A_total + A_new - (A_total * A_new)
        // This beautifully stacks the black CSS shadows without exceeding 1.0 opacity.
        totalShadowAlpha = totalShadowAlpha + alpha * (1.0 - totalShadowAlpha);
    }
    
    vec4 shadowColorPremult = vec4(0.0, 0.0, 0.0, totalShadowAlpha);
    
    cogl_color_out = windowColor + shadowColorPremult * (1.0 - pointAlpha);

    float borderedAreaAlpha = getPointAlpha(p, borderedAreaBounds, borderedAreaClipRadius);
    float borderAlpha = clamp(abs(pointAlpha - borderedAreaAlpha), 0.0, 1.0) * showBorder;
    
    cogl_color_out = mix(cogl_color_out, vec4(BORDER_COLOR.rgb, 1.0), borderAlpha * BORDER_COLOR.a);
}