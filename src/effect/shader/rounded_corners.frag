uniform vec4 bounds;
uniform float clipRadius;

uniform float borderWidth;
uniform vec4 borderColor;

uniform vec4 borderedAreaBounds;
uniform float borderedAreaClipRadius;

uniform vec2 pixelStep;

// Highly optimized squircle math (replaces expensive pow() functions)
float getSquircleDist(vec2 p, vec2 center) {
    vec2 delta = abs(p - center);
    vec2 deltaSq = delta * delta;
    vec2 powD4 = deltaSq * deltaSq;
    return sqrt(sqrt(powD4.x + powD4.y));
}

// Reusable function to calculate alpha, cleanly determining the correct center
float getPointAlpha(vec2 p, vec4 bnd, float rad) {
    // If outside this specific bounding box, it's invisible
    if (p.x < bnd.x || p.x > bnd.z || p.y < bnd.y || p.y > bnd.w) {
        return 0.0;
    }

    vec2 center = vec2(0.0);
    bool inX = false;
    bool inY = false;

    // Find X center
    float cLeft = bnd.x + rad;
    float cRight = bnd.z - rad;
    if (p.x < cLeft) {
        center.x = cLeft;
        inX = true;
    } else if (p.x > cRight) {
        center.x = cRight;
        inX = true;
    }

    // Find Y center
    float cTop = bnd.y + rad;
    float cBottom = bnd.w - rad;
    if (p.y < cTop) {
        center.y = cTop;
        inY = true;
    } else if (p.y > cBottom) {
        center.y = cBottom;
        inY = true;
    }

    // Only do the squircle math if we are actually in a corner
    if (inX && inY) {
        float dist = getSquircleDist(p, center);
        return clamp(rad - dist + 0.5, 0.0, 1.0);
    }

    // Inside the bounds, but not in a corner
    return 1.0;
}

void main() {
    vec2 p = cogl_tex_coord0_in.xy / pixelStep;

    // Global early exit: saves GPU cycles by entirely 
    / skipping pixels outside the window
    if (p.x < bounds.x || p.x > bounds.z || p.y < bounds.y || p.y > bounds.w) {
        cogl_color_out = vec4(0.0);
        return;
    }

    float pointAlpha = getPointAlpha(p, bounds, clipRadius);

    if (borderWidth > 0.9 || borderWidth < -0.9) {
        // Calculate the inner area using its own proper bounds and radius
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