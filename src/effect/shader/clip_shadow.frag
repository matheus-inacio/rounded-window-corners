// Clip shadows to avoid showing them behind the window contents.
void main() {
    vec4 color = cogl_color_out;
    float gray = dot(color.rgb, vec3(0.333));
    cogl_color_out *= (1.0 - smoothstep(0.4, 1.0, gray)) * color.a;
}
