import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isTypingInField } from './domFocus';

/**
 * No DOM here: `isTypingInField` duck-types deliberately, so a plain object
 * with the two properties an element would have is a faithful stand-in — and
 * so is an element from another realm, which is the case `instanceof` misses.
 */
function el(tagName: string, isContentEditable = false): EventTarget {
    return { tagName, isContentEditable } as unknown as EventTarget;
}

describe('isTypingInField', () => {
    it('claims the keyboard for the three form elements', () => {
        for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) {
            assert.equal(isTypingInField(el(tag)), true, `${tag} did not claim the keyboard`);
        }
    });

    it('claims it for a contenteditable element of any tag', () => {
        assert.equal(isTypingInField(el('DIV', true)), true);
    });

    it('leaves it alone for ordinary elements', () => {
        for (const tag of ['DIV', 'CANVAS', 'BUTTON', 'BODY', 'SPAN']) {
            assert.equal(isTypingInField(el(tag)), false, `${tag} wrongly claimed the keyboard`);
        }
    });

    it('leaves it alone for a null or property-less target', () => {
        // `document` is a common event target and has no tagName.
        assert.equal(isTypingInField(null), false);
        assert.equal(isTypingInField({} as EventTarget), false);
    });

    it('is case-sensitive on tagName, which is how the DOM reports it', () => {
        // `tagName` is upper-case for HTML elements; matching lower-case would
        // be a silent no-op on every real event.
        assert.equal(isTypingInField(el('input')), false);
    });

    it('does not mistake a falsy isContentEditable for true', () => {
        assert.equal(isTypingInField(el('DIV', false)), false);
        assert.equal(
            isTypingInField({ tagName: 'DIV', isContentEditable: 'false' } as unknown as EventTarget),
            false,
            'the string "false" is truthy and must not count as editable');
    });
});
