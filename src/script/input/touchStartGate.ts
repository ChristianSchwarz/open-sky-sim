import type { TouchControlsMode } from "../config/settingsStorage";

/**
 * Fullscreen and landscape only on touch screens. Browsers allow fullscreen
 * only from a gesture, so the game waits behind a tap-to-start screen; and an
 * upright phone gets a turn-it-sideways screen instead of the cockpit.
 * Android turns the screen itself once fullscreen locks it to landscape; iOS
 * has neither fullscreen nor the lock, so there it is the player's turn.
 *
 * Made first thing at boot, so it covers the loading screen too: the tap that
 * starts fullscreen can come while the game is still loading.
 */
export class TouchStartGate {

    private readonly coarsePointer = window.matchMedia('(pointer: coarse)');
    private readonly portrait = window.matchMedia('(orientation: portrait)');
    private readonly root: HTMLDivElement;
    private readonly text: HTMLDivElement;
    private readonly hint: HTMLDivElement;
    /** The first tap has asked for fullscreen; leaving it later is the player's call. */
    private started = !document.fullscreenEnabled;
    private blocking = false;
    /** Told when the gate goes up, so held controls are let go under it. */
    onBlock: (() => void) | undefined;

    constructor(private mode: TouchControlsMode) {
        // Above the boot screen (z-index 4) and the touch controls.
        this.root = document.createElement('div');
        this.root.style.cssText = 'position:fixed;inset:0;z-index:10;display:none;flex-direction:column;'
            + 'align-items:center;justify-content:center;gap:12px;background:black;'
            + 'color:white;font:600 20px/1.3 sans-serif;text-align:center;padding:24px;'
            + 'user-select:none;-webkit-user-select:none;touch-action:none';
        this.text = document.createElement('div');
        this.hint = document.createElement('div');
        this.hint.style.cssText = 'font-size:14px;font-weight:400;opacity:0.7';
        this.root.append(this.text, this.hint);
        // A click: fullscreen needs a gesture that has ended on a touch screen.
        this.root.addEventListener('click', () => this.start());
        document.body.appendChild(this.root);

        this.coarsePointer.addEventListener('change', () => this.update());
        this.portrait.addEventListener('change', () => this.update());
        this.update();
    }

    setMode(mode: TouchControlsMode): void {
        this.mode = mode;
        this.update();
    }

    /** Whether the gate covers the game now. */
    isBlocking(): boolean {
        return this.blocking;
    }

    private update(): void {
        let text = '';
        let hint = '';
        const touch = this.mode === 'on' || (this.mode === 'auto' && this.coarsePointer.matches);
        if (touch) {
            if (this.portrait.matches) {
                text = 'Turn your phone sideways';
                hint = this.started ? 'Retro Flight Sim flies in landscape only' : 'or tap to start in fullscreen';
            } else if (!this.started) {
                text = 'Tap to start';
                hint = 'Retro Flight Sim plays in fullscreen';
            }
        }
        this.text.textContent = text;
        this.hint.textContent = hint;
        this.root.style.display = text ? 'flex' : 'none';
        const blocking = text !== '';
        if (blocking && !this.blocking) {
            this.onBlock?.();
        }
        this.blocking = blocking;
    }

    private start(): void {
        this.started = true;
        if (document.fullscreenEnabled && !document.fullscreenElement) {
            void enterFullscreen();
        }
        this.update();
    }
}

export async function toggleFullscreen(): Promise<void> {
    if (document.fullscreenElement) {
        try {
            await document.exitFullscreen();
        } catch {
            // Already out, or the browser would not; either way nothing to do.
        }
        return;
    }
    await enterFullscreen();
}

async function enterFullscreen(): Promise<void> {
    try {
        await document.documentElement.requestFullscreen();
        // Android locks to landscape in fullscreen; iOS and desktops refuse, which is fine.
        const orientation = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
        await orientation.lock?.('landscape').catch(() => undefined);
    } catch {
        // Fullscreen is a convenience; the controls work without it.
    }
}
