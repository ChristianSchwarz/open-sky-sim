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
