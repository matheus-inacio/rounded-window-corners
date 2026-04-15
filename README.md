![2022-07-29 23-49-57][6]

<div align="center">
  <h1>Rounded Windows - Lite</h1>
  <p><i>An opinionated GNOME extension for lightweight, squircle-style window corners</i></p>
  <p><b>Warning:</b> This extension is still in development.</p>
</div>
<br>

> [!NOTE]
> This project is a fork of the [original rounded-window-corners extension][14] by @yilozt.  
> Rounded Windows - Lite focuses on a lean, straightforward implementation.

## Philosophy

Rounded Windows - Lite is intentionally opinionated:

- [Superelliptical][1] ("squircle") corner style inspired by Apple design language
- Performance optimizations to stay as lightweight as possible
- Minimal surface area and fewer moving parts for easier long-term maintenance
- No settings or customization UI; behavior is intentionally fixed and consistent

## Why this fork exists

The original extension interacts with many GNOME Shell private APIs. That makes maintenance harder over time, especially across GNOME updates.

This fork aims to stay lean and straightforward by reducing complexity and avoiding extra configuration features.

## Installation

### From Gnome Extensions

> [!WARNING]
> This extension is still in development and is not published on extensions.gnome.org.

### From source code

1. Install the dependencies:
    - Node.js
    - npm
    - gettext
    - [just](https://just.systems)

    Those packages are available in the repositories of most linux distros, so
    you can simply install them with your package manager.

2. Build the extension

    ```bash
    git clone https://github.com/matheus-inacio/rounded-window-corners
    cd rounded-window-corners
    just install
    ```

After this, the extension will be installed to
`~/.local/share/gnome-shell/extensions`.


## Development

Here are the avaliable `just` commands (run `just --list` to see this message):

```bash
Available recipes:
    build   # Compile the extension and all resources
    clean   # Delete the build directory
    install # Build and install the extension from source
    pack    # Build and pack the extension
    pot     # Update and compile the translation files
```