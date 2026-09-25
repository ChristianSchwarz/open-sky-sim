/**
 * Is the keyboard currently being used to type, rather than to fly?
 *
 * The game binds its shortcuts on `document`, and nothing in `src/` looks at
 * `document.activeElement` — so typing a name into the F9 area picker's field
 * today toggles force vectors on `v` and the
 * barricade on `k`, and switches cameras on F1/F2/F3. That was survivable while
 * the only text field in the app was one you used for a moment; an editor with
 * a properties panel makes it constant.
 *
 * Kept in `utils` rather than in a panel because all four handlers that need it
 * live in three different files, and the fix only works if they all agree.
 */

/** Element types that own the keyboard while they have focus. */
const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/**
 * Duck-typed rather than `instanceof HTMLElement`, for two reasons: an element
 * from another realm — an iframe, a template document — is a real element that
 * fails the `instanceof`, and reading two properties is testable without a DOM.
 * `tagName` is upper-case for HTML elements, which is what the set matches.
 */
export function isTypingInField(target: EventTarget | null): boolean {
    if (target === null || typeof target !== 'object') {
        return false;
    }
    const el = target as { tagName?: unknown; isContentEditable?: unknown };
    if (typeof el.tagName === 'string' && TYPING_TAGS.has(el.tagName)) {
        return true;
    }
    return el.isContentEditable === true;
}
