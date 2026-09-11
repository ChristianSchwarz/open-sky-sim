import { AudioSystem } from "../audio/audioSystem";
import { ConfigService } from "../config/configService";
import { loadSettings, updateSettings } from "../config/settingsStorage";
import { JoystickControlDevice } from "../input/devices/joystickControlDevice";
import { KeyboardControlAction, KeyboardControlDevice, KeyboardControlLayoutId, KeyboardControlLayouts } from "../input/devices/keyboardControlDevice";
import { toggleSettingsDialog } from "../ui/settings/settingsLauncher";
import { assertIsDefined } from "../utils/asserts";


export function setupOSD(config: ConfigService, keyboardInput: KeyboardControlDevice, joystickInput: JoystickControlDevice, audio: AudioSystem) {
    audio.setMasterVolume(loadSettings().volume);
    persistSettingChanges(config);
    setupButtons(config, keyboardInput, audio);
    updateControlsHelp(keyboardInput.getKeyboardLayoutId());
    setupJoystickHelp(joystickInput);
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

function setupButtons(config: ConfigService, keyboardInput: KeyboardControlDevice, audio: AudioSystem) {
    const helpButton = document.getElementById('help-button');
    assertIsDefined(helpButton);
    const settingsButton = document.getElementById('settings-button');
    assertIsDefined(settingsButton);
    const helpSection = document.getElementById('help');
    assertIsDefined(helpSection);
    const panel = document.getElementById('panel');
    assertIsDefined(panel);

    helpSection.classList.add('active');

    helpButton.addEventListener('click', () => {
        if (helpButton.classList.contains('active')) {
            panel.classList.remove('open');
            helpButton.classList.remove('active');
        } else {
            panel.classList.add('open');
            helpButton.classList.add('active');
        }
    });

    settingsButton.addEventListener('click', () => {
        panel.classList.remove('open');
        helpButton.classList.remove('active');
        settingsButton.classList.add('active');
        void toggleSettingsDialog(
            { config, keyboardInput, audio, onKeyboardLayoutChange: updateControlsHelp },
            () => settingsButton.classList.remove('active'),
        );
    });
}

function setupJoystickHelp(joystickInput: JoystickControlDevice) {
    joystickInput.setListener(connected => {
        if (connected) {
            updateJoystickHelp(joystickInput.getDeviceId(), joystickInput.getAxisCount());
        } else {
            disableJoystickHelp();
        }
    });
}

function updateControlsHelp(layoutId: KeyboardControlLayoutId) {
    const pitchPos = document.getElementById('key-pitch-pos');
    assertIsDefined(pitchPos);
    const pitchNeg = document.getElementById('key-pitch-neg');
    assertIsDefined(pitchNeg);
    const rollPos = document.getElementById('key-roll-pos');
    assertIsDefined(rollPos);
    const rollNeg = document.getElementById('key-roll-neg');
    assertIsDefined(rollNeg);
    const yawPos = document.getElementById('key-yaw-pos');
    assertIsDefined(yawPos);
    const yawNeg = document.getElementById('key-yaw-neg');
    assertIsDefined(yawNeg);
    const throttlePos = document.getElementById('key-throttle-pos');
    assertIsDefined(throttlePos);
    const throttleNeg = document.getElementById('key-throttle-neg');
    assertIsDefined(throttleNeg);

    const layout = KeyboardControlLayouts.get(layoutId);
    assertIsDefined(layout);

    pitchPos.innerText = formatControlKey(layout[KeyboardControlAction.PITCH_POS]);
    pitchNeg.innerText = formatControlKey(layout[KeyboardControlAction.PITCH_NEG]);
    rollPos.innerText = formatControlKey(layout[KeyboardControlAction.ROLL_POS]);
    rollNeg.innerText = formatControlKey(layout[KeyboardControlAction.ROLL_NEG]);
    yawPos.innerText = formatControlKey(layout[KeyboardControlAction.YAW_POS]);
    yawNeg.innerText = formatControlKey(layout[KeyboardControlAction.YAW_NEG]);
    throttlePos.innerText = formatControlKey(layout[KeyboardControlAction.THROTTLE_POS]);
    throttleNeg.innerText = formatControlKey(layout[KeyboardControlAction.THROTTLE_NEG]);
}

function formatControlKey(key: string) {
    switch (key) {
        case 'arrowup': return '↑';
        case 'arrowdown': return '↓';
        case 'arrowleft': return '←';
        case 'arrowright': return '→';
        case 'numpadadd': return 'Num+';
        case 'numpadsubtract': return 'Num-';
        default: return key.toUpperCase();
    }
}

function updateJoystickHelp(id: string, axisCount: number) {
    const joystick = document.getElementById('joystick');
    assertIsDefined(joystick);
    const joystickId = document.getElementById('joystick-id');
    assertIsDefined(joystickId);
    const axisPitch = document.getElementById('axis-pitch');
    assertIsDefined(axisPitch);
    const axisRoll = document.getElementById('axis-roll');
    assertIsDefined(axisRoll);
    const axisYaw = document.getElementById('axis-yaw');
    assertIsDefined(axisYaw);
    const axisThrottle = document.getElementById('axis-throttle');
    assertIsDefined(axisThrottle);

    joystick.classList.remove('hidden');
    const lastBracketIndex = id.lastIndexOf('(');
    joystickId.innerText = id.substring(0, lastBracketIndex !== -1 ? lastBracketIndex - 1 : undefined);

    if (axisCount < 4) {
        axisYaw.classList.add('hidden');
    } else {
        axisYaw.classList.remove('hidden');
    }
    if (axisCount < 3) {
        axisThrottle.classList.add('hidden');
    } else {
        axisThrottle.classList.remove('hidden');
    }
    if (axisCount < 2) {
        axisPitch.classList.add('hidden');
    } else {
        axisPitch.classList.remove('hidden');
    }
    if (axisCount < 1) {
        axisRoll.classList.add('hidden');
    } else {
        axisRoll.classList.remove('hidden');
    }
}

function disableJoystickHelp() {
    const joystick = document.getElementById('joystick');
    assertIsDefined(joystick);
    const joystickId = document.getElementById('joystick-id');
    assertIsDefined(joystickId);

    joystick.classList.add('hidden');
    joystickId.innerText = 'No device detected';
}
