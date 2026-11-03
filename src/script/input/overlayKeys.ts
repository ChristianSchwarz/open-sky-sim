import { isTypingInField } from '../utils/domFocus';

/**
 * True when a keyboard event is aimed at an open Angular Material overlay —
 * the settings dialog, or a dropdown inside it — or at a text field anywhere
 * (the F12 mission panel's are not in an overlay), rather than at the game.
 *
 * The game listens for keys on the document, so without this check dragging a
 * slider with the arrow keys would also roll the aircraft, and Esc would open
 * the spawn menu instead of closing the dialog.
 */
export function isOverlayKeyEvent(event: KeyboardEvent): boolean {
    const target = event.target;
    if (isTypingInField(target)) {
        return true;
    }
    return target instanceof Element && target.closest('.cdk-overlay-container') !== null;
}
