// Border tint for the inner border pass.
#define BORDER_COLOR vec4(0.2, 0.2, 0.2, 1.0)

// xy = center, zw = halfSize
uniform vec4 bounds;
uniform vec4 borderedAreaBounds; 

uniform float clipRadius;
uniform float borderedAreaClipRadius;

uniform float showBorder;
uniform vec2 actorSize; 

// Optimized squircle math
float getSquircleDist(vec2 delta) {
    vec2 dSq = delta * delta;
    return sqrt(sqrt(dot(dSq, dSq)));
}

// Branchless rounded-rect SDF → alpha
float getPointAlpha(vec2 p, vec4 bndInfo, float rad) {
    // bndInfo.xy is center, bndInfo.zw is halfSize
    vec2 q = abs(p - bndInfo.xy) - (bndInfo.zw - rad);
    vec2 cornerDist = max(q, 0.0);

    float squircleDist = getSquircleDist(cornerDist);
    float innerDist = min(max(q.x, q.y), 0.0);
    
    return clamp(0.5 - (squircleDist + innerDist - rad), 0.0, 1.0);
}

void main() {
    vec2 p = cogl_tex_coord0_in.xy * actorSize;

    float pointAlpha = getPointAlpha(p, bounds, clipRadius);
    cogl_color_out *= pointAlpha;

    // Branchless border: always compute border alpha, gate it with showBorder uniform.
    // When showBorder == 0.0 the multiplication zeroes out the mix weight — no branch.
    float borderedAreaAlpha = getPointAlpha(p, borderedAreaBounds, borderedAreaClipRadius);
    float borderAlpha = clamp(abs(pointAlpha - borderedAreaAlpha), 0.0, 1.0) * showBorder;
    cogl_color_out = mix(cogl_color_out, vec4(BORDER_COLOR.rgb, 1.0), borderAlpha * BORDER_COLOR.a);
}