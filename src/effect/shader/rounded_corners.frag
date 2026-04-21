// Border tint for the inner border pass.
#define BORDER_COLOR vec4(0.2, 0.2, 0.2, 1.0)

// xy = center, zw = halfSize
uniform vec4 bounds;
uniform vec4 borderedAreaBounds; 

uniform float clipRadius;
uniform float borderedAreaClipRadius;

uniform bool showBorder; // Changed to bool
uniform vec2 actorSize; 

// 1. Optimized squircle math
float getSquircleDist(vec2 delta) {
    vec2 dSq = delta * delta;
    return sqrt(sqrt(dot(dSq, dSq)));
}

// 2. Optimized Branchless SDF
float getPointAlpha(vec2 p, vec4 bndInfo, float rad) {
    // bndInfo.xy is center, bndInfo.zw is halfSize
    vec2 q = abs(p - bndInfo.xy) - (bndInfo.zw - rad);
    vec2 cornerDist = max(q, 0.0);

    float squircleDist = getSquircleDist(cornerDist);
    float innerDist = min(max(q.x, q.y), 0.0);
    
    return clamp(0.5 - (squircleDist + innerDist - rad), 0.0, 1.0);
}

void main() {
    // Multiply instead of divide for better GPU performance
    vec2 p = cogl_tex_coord0_in.xy * actorSize;

    float pointAlpha = getPointAlpha(p, bounds, clipRadius);

    // 3. Dynamic toggle for borders using boolean
    if (showBorder) {
        float borderedAreaAlpha = getPointAlpha(p, borderedAreaBounds, borderedAreaClipRadius);
        
        // Inner borders
        cogl_color_out *= pointAlpha;
        float borderAlpha = clamp(abs(pointAlpha - borderedAreaAlpha), 0.0, 1.0);
        cogl_color_out = mix(cogl_color_out, vec4(BORDER_COLOR.rgb, 1.0), borderAlpha * BORDER_COLOR.a);
    } else {
        // No borders
        cogl_color_out *= pointAlpha;
    }
}