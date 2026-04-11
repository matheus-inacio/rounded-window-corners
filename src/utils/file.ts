/** @file Contains utility functions for reading file contents. */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/**
 * Read file contents as a string.
 *
 * @param path - The path to the file to be read.
 * @returns Contents of the file as a UTF-8 string.
 */
export function readFile(path: string) {
    const file = Gio.File.new_for_path(path);

    const contents = file.load_contents(null)[1];

    const decoder = new TextDecoder('utf-8');
    return decoder.decode(contents);
}

/**
 * Read file contents as a string asynchronously.
 *
 * @param path - The path to the file to be read.
 * @returns A promise that resolves to the contents of the file as a UTF-8 string.
 */
export function readFileAsync(path: string): Promise<string> {
    const file = Gio.File.new_for_path(path);

    return new Promise((resolve, reject) => {
        file.load_contents_async(null, (_fileSource, res) => {
            try {
                // In generic gjs, load_contents_finish might return multiple values depending on version,
                // but usually returns [success, contents, etag_out]
                const [, contents] = file.load_contents_finish(res);
                const decoder = new TextDecoder('utf-8');
                resolve(decoder.decode(contents));
            } catch (e) {
                reject(e);
            }
        });
    });
}

/**
 * Read a file relative to the current module.
 *
 * @param module - `import.meta.url` of the current module.
 * @param path - File path relative to the current module.
 * @returns Contents of the file as a UTF-8 string.
 */
export function readRelativeFile(module: string, path: string) {
    const basedir = GLib.path_get_dirname(module);
    const fileUri = GLib.build_filenamev([basedir, path]);
    const filePath = GLib.filename_from_uri(fileUri)[0];
    return readFile(filePath ?? '');
}

/**
 * Read a shader file and split it into declarations and main code, since
 * GNOME's `add_glsl_snippet` function takes those parts as two separate
 * arguments.
 *
 * @param module - `import.meta.url` of the current module.
 * @param path - File path relative to the current module.
 * @returns A list containing the declarations as the first element and
 *          contents of the main function as the second.
 */
export function readShader(module: string, path: string) {
    const shader = readRelativeFile(module, path);
    let [declarations, code] = shader.split(/^.*?main\(\s?\)\s?/m);
    declarations = declarations.trim();
    code = code.trim().replace(/^[{}]/gm, '').trim();
    return [declarations, code];
}
