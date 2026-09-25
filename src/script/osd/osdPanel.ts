import { AudioSystem } from "../audio/audioSystem";
import { ConfigService } from "../config/configService";
import { loadSettings, updateSettings } from "../config/settingsStorage";
import { JoystickControlDevice } from "../input/devices/joystickControlDevice";
import { KeyboardControlDevice } from "../input/devices/keyboardControlDevice";
import { registerSettingsDialog, toggleSettingsDialog } from "../ui/settings/settingsLauncher";
import { assertIsDefined } from "../utils/asserts";


export function setupOSD(config: ConfigService, keyboardInput: KeyboardControlDevice, joystickInput: JoystickControlDevice, audio: AudioSystem) {
    audio.setMasterVolume(loadSettings().volume);
    persistSettingChanges(config);
    setupSettingsButton(config, keyboardInput, joystickInput, audio);
}

/**
 * Time of day and terrain detail can change from outside the settings dialog
 * — the in-game `N` day/night key writes the time of day — so they are saved
 * from the setting's change listener, whichever end drove the change, and for
 * the whole session rather than only while the dialog is open.
 */
function persistSettingChanges(config: ConfigService) {
    config.daytime.addChangeListener(hours => {
        updateSettings({ daytime: hours });
    });
    config.terrainDetail.addChangeListener(distanceM => {
        updateSettings({
            terrainDetailDistanceM: Number.isFinite(distanceM) ? distanceM : null,
        });
    });
}

function setupSettingsButton(config: ConfigService, keyboardInput: KeyboardControlDevice, joystickInput: JoystickControlDevice, audio: AudioSystem) {
    const settingsButton = document.getElementById('settings-button');
    assertIsDefined(settingsButton);

    // The dialog can also be opened by F9, so the button's state follows the
    // dialog rather than its own clicks.
    registerSettingsDialog(
        { config, keyboardInput, joystickInput, audio },
        open => settingsButton.classList.toggle('active', open),
    );
    settingsButton.addEventListener('click', () => void toggleSettingsDialog());
}
