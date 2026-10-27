import { createComponent } from '@angular/core';
import { createApplication } from '@angular/platform-browser';
import type { MissionEditor } from '../../mission/missionEditor';
import { MissionPanel } from './missionPanel';

/**
 * Mount the waypoint editor's panel into the F12 map's left pane. A bare
 * application, as the settings dialog has (settingsLauncher.ts): the game's
 * own boot is untouched, and Angular starts only in the map.
 */
export async function mountMissionPanel(host: HTMLElement, editor: MissionEditor): Promise<void> {
    const app = await createApplication();
    const ref = createComponent(MissionPanel, { environmentInjector: app.injector, hostElement: host });
    ref.setInput('editor', editor);
    app.attachView(ref.hostView);
}
