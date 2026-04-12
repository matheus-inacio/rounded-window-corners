uniform vec4 bounds;
uniform float clipRadius;

uniform float borderWidth;
uniform vec4 borderColor;

uniform vec4 borderedAreaBounds;
uniform float borderedAreaClipRadius;

uniform vec2 pixelStep;

// 1. Optimized squircle math (takes the pre-folded delta vector)
float getSquircleDist(vec2 delta) {
    vec2 dSq = delta * delta;
    // dot() is hardware-optimized and perfectly replaces (powD4.x + powD4.y)
    return sqrt(sqrt(dot(dSq, dSq)));
}

// 2. 100% Branchless SDF (Signed Distance Field)
float getPointAlpha(vec2 p, vec4 bnd, float rad) {
    // Find the center and half-dimensions of the bounding box
    vec2 center = (bnd.xy + bnd.zw) * 0.5;
    vec2 halfSize = (bnd.zw - bnd.xy) * 0.5;

    // Fold the space into the first quadrant, relative to the corner center
    vec2 q = abs(p - center) - (halfSize - rad);

    // Distance vector from the inner corner center (is (0,0) if inside the straight edges)
    vec2 cornerDist = max(q, 0.0);

    // Calculate the continuous distance field
    float squircleDist = getSquircleDist(cornerDist);
    float innerDist = min(max(q.x, q.y), 0.0);
    
    // Total distance from the edge (positive = outside, negative = inside, 0 = exact edge)
    float d = squircleDist + innerDist - rad;

    // Branchless, uniform anti-aliasing for BOTH straight edges and corners
    return clamp(0.5 - d, 0.0, 1.0);
}

void main() {
    vec2 p = cogl_tex_coord0_in.xy / pixelStep;

    float pointAlpha = getPointAlpha(p, bounds, clipRadius);

    // 3. Simplified uniform check
    if (abs(borderWidth) > 0.9) {
        float borderedAreaAlpha = getPointAlpha(p, borderedAreaBounds, borderedAreaClipRadius);

        if (borderWidth > 0.0) {
            // Inner borders
            cogl_color_out *= pointAlpha;
            float borderAlpha = clamp(abs(pointAlpha - borderedAreaAlpha), 0.0, 1.0);
            cogl_color_out = mix(cogl_color_out, vec4(borderColor.rgb, 1.0), borderAlpha * borderColor.a);
        } else {
            // Outer borders
            vec4 borderRect = vec4(borderColor.rgb, 1.0) * borderedAreaAlpha * borderColor.a;
            cogl_color_out = mix(borderRect, cogl_color_out, pointAlpha);
        }
    } else {
        // No borders
        cogl_color_out *= pointAlpha;
    }
}