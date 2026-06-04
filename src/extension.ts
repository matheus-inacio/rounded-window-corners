import {
    Extension,
    InjectionManager,
} from 'resource:///org/gnome/shell/extensions/extension.js';
import { layoutManager } from 'resource:///org/gnome/shell/ui/main.js';

import { disableEffect, enableEffect } from './manager/event_manager.js';
import { clearAppTypeCache } from './manager/eligibility.js';
import { logDebug } from './utils/log.js';

export default class RoundedWindowCornersReborn extends Extension {
    // The extension works by overriding (monkey patching) the code of GNOME
    // Shell's internal methods. InjectionManager is a convenience class that
    // stores references to the original methods and allows easily restoring
    // them when the extension is disabled.
    #injectionManager: InjectionManager | null = null;

    #layoutManagerStartupConnection: number | null = null;
    #isEnabled = false;

    enable() {
        this.#isEnabled = true;
        this.#injectionManager = new InjectionManager();

        if (layoutManager._startingUp) {
            // Wait for GNOME Shell to be ready before enabling rounded corners
            this.#layoutManagerStartupConnection = layoutManager.connect(
                'startup-complete',
                () => {
                    this._safeEnableEffect();

                    if (this.#layoutManagerStartupConnection !== null) {
                        layoutManager.disconnect(this.#layoutManagerStartupConnection);
                        this.#layoutManagerStartupConnection = null;
                    }
                },
            );
        } else {
            this._safeEnableEffect();
        }

        logDebug('Enabled');
    }

    // Handle async enableEffect() safely: if the extension was disabled
    // while the promise was in-flight, immediately revert.
    _safeEnableEffect() {
        enableEffect().then(() => {
            if (!this.#isEnabled) {
                disableEffect();
            }
        }).catch(err => {
            console.error(`Failed to enable effect: ${err}`);
        });
    }

    disable() {
        this.#isEnabled = false;

        // Restore patched methods
        this.#injectionManager?.clear();
        this.#injectionManager = null;

        disableEffect();
        clearAppTypeCache();

        if (this.#layoutManagerStartupConnection !== null) {
            layoutManager.disconnect(this.#layoutManagerStartupConnection);
            this.#layoutManagerStartupConnection = null;
        }

        logDebug('Disabled');
    }
}
