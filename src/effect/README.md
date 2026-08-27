# `effect`

This directory contains the code for applying GLSL effects to windows.

## `rounded_corners_effect.ts`

This effect loads the actual Fragment shader that rounds the corners and draws
custom borders and shadows for the window. The class applies the effect and provides a
function to change uniforms passed to the effect.

## `shader`

This is the directory where the Fragment shaders are stored.

If you're interested in implementation details of the shader, you can read the
`rounded_corners.frag` file, which is well commented and explains how
it works in great detail. Note that in this fork, shadows are rendered entirely
by the shader using a multi-layered approach, rather than the original extension's
method of injecting CSS-styled Clutter actors.
