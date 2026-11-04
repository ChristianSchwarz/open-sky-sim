import type { TouchControlsMode } from "../config/settingsStorage";

/**
 * Fullscreen and landscape only on touch screens. No browser lets a page go
 * fullscreen before the player has touched it, so the first touch anywhere
 * does it (and is still the touch it was: a stick, a button), and so does
 * any touch that finds the game out of fullscreen again. Fullscreen locks
 * the screen to landscape where the browser allows it (Android); an upright
 * phone that is not locked gets a turn-it-sideways screen instead of the
 * cockpit. iOS has neither fullscreen nor the lock, so there the player
 * turns the phone. Added to the home screen, the web manifest starts the
 * game fullscreen in landscape without any touch.
 *
 * Made first thing at boot, so it covers the loading screen too.
 */
export class TouchStartGate {

    private readonly coarsePointer = window.matchMedia('(pointer: coarse)');
    private readonly portrait = window.matchMedia('(orientation: portrait)');
    private readonly root: HTMLDivElement;
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
        this.root.textContent = 'Turn your phone sideways';
        document.body.appendChild(this.root);

        // On the way down, ahead of every other handler, and never stopped:
        // the touch still does whatever it touched. A pointerup is a gesture
        // the browser accepts for fullscreen; the click covers older browsers.
        const touched = (event: Event) => {
            if (event instanceof PointerEvent && event.pointerType === 'mouse') {
                return;
            }
            if (this.isTouch()) {
                this.enter();
            }
        };
        document.addEventListener('pointerup', touched, true);
        document.addEventListener('click', touched, true);

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

    private isTouch(): boolean {
        return this.mode === 'on' || (this.mode === 'auto' && this.coarsePointer.matches);
    }

    private update(): void {
        const blocking = this.isTouch() && this.portrait.matches;
        this.root.style.display = blocking ? 'flex' : 'none';
        if (blocking && !this.blocking) {
            this.onBlock?.();
        }
        this.blocking = blocking;
    }

    private enter(): void {
        if (document.fullscreenEnabled && !document.fullscreenElement) {
            void enterFullscreen();
        }
    }
}

async function enterFullscreen(): Promise<void> {
    try {
        await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
        // Android locks to landscape in fullscreen; iOS and desktops refuse, which is fine.
        const orientation = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
        await orientation.lock?.('landscape').catch(() => undefined);
    } catch {
        // Fullscreen is a convenience; the controls work without it.
    }
}
