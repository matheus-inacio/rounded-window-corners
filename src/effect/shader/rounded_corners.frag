#define BORDER_COLOR vec4(0.2, 0.2, 0.2, 1.0)

uniform vec4 bounds;
uniform vec4 borderedAreaBounds; 

uniform float clipRadius;
uniform float borderedAreaClipRadius;

uniform float showBorder;
uniform vec2 actorSize; 

float getPointAlpha(vec2 p, vec4 bndInfo, float rad) {
    vec2 q = abs(p - bndInfo.xy) - (bndInfo.zw - rad);
    float dist = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
    
    return clamp(0.5 - (dist - rad), 0.0, 1.0);
}

void main() {
    vec2 p = cogl_tex_coord0_in.xy * actorSize;

    float pointAlpha = getPointAlpha(p, bounds, clipRadius);
    cogl_color_out *= pointAlpha;

    float borderedAreaAlpha = getPointAlpha(p, borderedAreaBounds, borderedAreaClipRadius);
    float borderAlpha = clamp(abs(pointAlpha - borderedAreaAlpha), 0.0, 1.0) * showBorder;
    
    cogl_color_out = mix(cogl_color_out, vec4(BORDER_COLOR.rgb, 1.0), borderAlpha * BORDER_COLOR.a);
}