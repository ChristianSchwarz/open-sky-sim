import { AudioSystem } from "../audio/audioSystem";
import { ConfigService } from "../config/configService";
import { loadSettings } from "../config/settingsStorage";
import { JoystickControlDevice } from "../input/devices/joystickControlDevice";
import { KeyboardControlDevice } from "../input/devices/keyboardControlDevice";
import { registerSettingsDialog, toggleSettingsDialog } from "../ui/settings/settingsLauncher";
import { persistSettingChanges } from "../ui/settings/settingsModel";
import { assertIsDefined } from "../utils/asserts";


export function setupOSD(config: ConfigService, keyboardInput: KeyboardControlDevice, joystickInput: JoystickControlDevice, audio: AudioSystem) {
    audio.setMasterVolume(loadSettings().volume);
    persistSettingChanges(config);
    setupSettingsButton(config, keyboardInput, joystickInput, audio);
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
