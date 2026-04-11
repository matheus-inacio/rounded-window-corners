import type Gio from 'gi://Gio';

import {
    Extension,
    InjectionManager,
} from 'resource:///org/gnome/shell/extensions/extension.js';
import {layoutManager} from 'resource:///org/gnome/shell/ui/main.js';

import {disableEffect, enableEffect} from './manager/event_manager.js';
import {clearMutterSettingsCache} from './manager/utils.js';
import {
    disableBackgroundMenuItem,
    enableBackgroundMenuItem,
} from './utils/background_menu.js';
import {logDebug} from './utils/log.js';
import {getPref, initPrefs, prefs, uninitPrefs} from './utils/settings.js';
import {WindowPicker} from './window_picker/service.js';

export default class RoundedWindowCornersReborn extends Extension {
    // The extension works by overriding (monkey patching) the code of GNOME
    // Shell's internal methods. InjectionManager is a convenience class that
    // stores references to the original methods and allows to easily restore
    // them when the extension is disabled.
    #injectionManager: InjectionManager | null = null;

    #windowPicker: WindowPicker | null = null;

    #layoutManagerStartupConnection: number | null = null;

    enable() {
        // Initialize extension preferences
        initPrefs(this.getSettings());

        this.#injectionManager = new InjectionManager();

        // Export the d-bus interface of the window picker in preferences.
        // See the readme in the `window_picker` directory for more information.
        this.#windowPicker = new WindowPicker();
        this.#windowPicker.export();

        if (layoutManager._startingUp) {
            // Wait for GNOME Shell to be ready before enabling rounded corners
            this.#layoutManagerStartupConnection = layoutManager.connect(
                'startup-complete',
                () => {
                    enableEffect();

                    if (getPref('enable-preferences-entry')) {
                        enableBackgroundMenuItem();
                    }

                    layoutManager.disconnect(
                        // biome-ignore lint/style/noNonNullAssertion: Since this happens inside of the connection, there is no way for this to be null.
                        this.#layoutManagerStartupConnection!,
                    );
                },
            );
        } else {
            enableEffect();

            if (getPref('enable-preferences-entry')) {
                enableBackgroundMenuItem();
            }
        }

        // Watch for changes of the `enable-preferences-entry` prefs key.
        prefs.connect('changed', (_: Gio.Settings, key: string) => {
            if (key === 'enable-preferences-entry') {
                getPref('enable-preferences-entry')
                    ? enableBackgroundMenuItem()
                    : disableBackgroundMenuItem();
            }
        });

        logDebug('Enabled');
    }

    disable() {
        // Restore patched methods
        this.#injectionManager?.clear();
        this.#injectionManager = null;

        // Remove the item to open preferences page in background menu
        disableBackgroundMenuItem();

        this.#windowPicker?.unexport();
        disableEffect();
        clearMutterSettingsCache();

        // Set all props to null
        this.#windowPicker = null;

        if (this.#layoutManagerStartupConnection !== null) {
            layoutManager.disconnect(this.#layoutManagerStartupConnection);
            this.#layoutManagerStartupConnection = null;
        }

        logDebug('Disabled');

        uninitPrefs();
    }
}
