import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDuration, parseKeys } from './tui';

const names = (s: string) => parseKeys(s).map(k => (k.name === 'char' ? k.ch : k.name));

test('function keys in every dialect the consoles send', () => {
    assert.deepEqual(names('\x1bOP\x1bOQ\x1bOR\x1bOS'), ['f1', 'f2', 'f3', 'f4']);
    // libuv's Windows console
    assert.deepEqual(names('\x1b[[A\x1b[[B\x1b[[E'), ['f1', 'f2', 'f5']);
    assert.deepEqual(names('\x1b[11~\x1b[15~\x1b[17~\x1b[21~'), ['f1', 'f5', 'f6', 'f10']);
});

test('editing keys, text and a lone Esc', () => {
    assert.deepEqual(names('ab\x7f\r'), ['a', 'b', 'backspace', 'enter']);
    assert.deepEqual(names('\x1b[D\x1b[C\x1b[H\x1b[F\x1b[3~'), ['left', 'right', 'home', 'end', 'delete']);
    assert.deepEqual(names('\x1b'), ['escape']);
    assert.deepEqual(names('\x03'), ['ctrl-c']);
    assert.deepEqual(names('E:\\Ä'), ['E', ':', '\\', 'Ä']);
});

test('an unknown escape sequence is skipped, not typed', () => {
    assert.deepEqual(names('\x1b[200~x'), ['x']);
});

test('durations', () => {
    assert.equal(formatDuration(5_000), '5s');
    assert.equal(formatDuration(65_000), '1m05s');
    assert.equal(formatDuration(3_720_000), '1h02m');
});
