/** Full-screen boot progress overlay (#boot-progress). */

export function setBootProgress(percent: number, label: string): void {
    const root = document.getElementById('boot-progress');
    const fill = document.getElementById('boot-progress-fill');
    const text = document.getElementById('boot-progress-label');
    if (!root || !fill || !text) {
        return;
    }
    const clamped = Math.max(0, Math.min(100, percent));
    fill.style.width = `${clamped}%`;
    text.textContent = label;
    root.classList.remove('hidden');
}

export function hideBootProgress(): void {
    const root = document.getElementById('boot-progress');
    if (!root) {
        return;
    }
    root.classList.add('hidden');
}

/**
 * Switch the overlay from the opaque boot screen to a blurred pane over the
 * live view, for the streaming hold after boot (see Game.holdUntilStreamed).
 */
export function setBootStreaming(percent: number, label: string): void {
    setBootProgress(percent, label);
    const root = document.getElementById('boot-progress');
    root?.classList.add('streaming');
    // A respawn can start before the previous fade finished.
    root?.classList.remove('fading');
}

/** Clear the blur and dim to nothing over a second (see style.css), then hide the overlay. */
export function fadeOutBootProgress(): void {
    const root = document.getElementById('boot-progress');
    if (!root) {
        return;
    }
    root.classList.add('fading');
    const done = () => {
        // Shown again (a respawn) since the fade began: leave it up.
        if (!root.classList.contains('fading')) {
            return;
        }
        root.classList.add('hidden');
        root.classList.remove('fading', 'streaming');
    };
    root.addEventListener('transitionend', done, { once: true });
    // transitionend never fires when the transition is skipped (reduced motion, hidden tab).
    setTimeout(done, 1100);
}

/** The big "get ready" number shown after the streaming blur lifts (#countdown). */
export function showCountdown(text: string): void {
    const el = document.getElementById('countdown');
    if (!el) {
        return;
    }
    el.textContent = text;
    el.classList.remove('hidden');
    // Restart the pop animation for each number.
    el.classList.remove('tick');
    void el.offsetWidth;
    el.classList.add('tick');
}

export function hideCountdown(): void {
    document.getElementById('countdown')?.classList.add('hidden');
}
