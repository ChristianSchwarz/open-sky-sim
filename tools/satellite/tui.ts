/**
 * The satellite's console, drawn like an old DOS file manager (Norton
 * Commander): a blue full-screen panel with the status, a thread list and a
 * log, a function-key bar at the bottom, and grey dialogs for the settings.
 * Plain ANSI escapes and Node built-ins only, so the exe stays one file.
 *
 * Keys: F1..F10, or the digits 1..9 and 0 for terminals that eat function
 * keys. Esc closes a dialog, Enter takes it.
 *
 * When stdout is not a terminal (redirected to a file), there is no screen:
 * log lines are printed as they come and a one-line summary every SUMMARY_MS.
 */

const SUMMARY_MS = 30_000;
const LOG_KEEP = 300;

// Colours: SGR parameter strings.
const C = {
    panel: '0;96;44',      // light cyan on blue: frames and labels
    value: '0;97;44',      // white on blue
    bright: '0;93;44',     // yellow on blue
    dim: '0;36;44',        // cyan on blue
    bad: '0;91;44',        // light red on blue
    barFull: '0;93;44',
    barEmpty: '0;34;44',
    title: '0;30;46',      // black on cyan
    keyNum: '0;97;40',     // white on black
    keyLabel: '0;30;46',   // black on cyan
    dialog: '0;30;47',     // black on grey
    dialogTitle: '0;97;47',
    dialogBad: '0;31;47',
    input: '0;30;46',      // black on cyan
    button: '0;97;40',
};

export interface InfoRow { label: string; value: string; tone?: 'value' | 'bright' | 'dim' | 'bad'; bar?: number }

export interface TuiModel {
    title(): string;
    info(): InfoRow[];
    threads(): string[];
    summary(): string;
}

type Key = { name: string; ch?: string };

interface Dialog {
    title: string;
    lines: string[];
    input?: { label: string; value: string; cursor: number };
    error?: string;
    buttons: string;
    onKey: (k: Key) => void;
}

/** A screen of character cells, each with its SGR. */
class Grid {
    readonly ch: string[][];
    readonly at: string[][];

    constructor(readonly w: number, readonly h: number, fill: string) {
        this.ch = Array.from({ length: h }, () => new Array<string>(w).fill(' '));
        this.at = Array.from({ length: h }, () => new Array<string>(w).fill(fill));
    }

    put(x: number, y: number, text: string, sgr: string, maxW = this.w - x): void {
        if (y < 0 || y >= this.h) {
            return;
        }
        const chars = [...text];
        for (let i = 0; i < chars.length && i < maxW; i++) {
            if (x + i >= 0 && x + i < this.w) {
                this.ch[y][x + i] = chars[i];
                this.at[y][x + i] = sgr;
            }
        }
    }

    fill(x: number, y: number, w: number, h: number, sgr: string): void {
        for (let r = y; r < y + h; r++) {
            this.put(x, r, ' '.repeat(Math.max(0, w)), sgr, w);
        }
    }

    /** A double-line frame, optionally titled. */
    box(x: number, y: number, w: number, h: number, sgr: string, title?: string, titleSgr = sgr): void {
        this.put(x, y, `╔${'═'.repeat(w - 2)}╗`, sgr);
        for (let r = y + 1; r < y + h - 1; r++) {
            this.put(x, r, '║', sgr);
            this.put(x + w - 1, r, '║', sgr);
        }
        this.put(x, y + h - 1, `╚${'═'.repeat(w - 2)}╝`, sgr);
        if (title) {
            const t = ` ${title} `.slice(0, w - 4);
            this.put(x + Math.floor((w - t.length) / 2), y, t, titleSgr);
        }
    }

    /** A divider across a box, ╟───╢, titled at the left. */
    divider(x: number, y: number, w: number, sgr: string, title?: string): void {
        this.put(x, y, `╟${'─'.repeat(w - 2)}╢`, sgr);
        if (title) {
            this.put(x + 2, y, ` ${title} `, sgr);
        }
    }

    serialize(): string {
        let out = '';
        for (let y = 0; y < this.h; y++) {
            out += `\x1b[${y + 1};1H`;
            let cur = '';
            for (let x = 0; x < this.w; x++) {
                if (this.at[y][x] !== cur) {
                    cur = this.at[y][x];
                    out += `\x1b[${cur}m`;
                }
                out += this.ch[y][x];
            }
        }
        return `${out}\x1b[0m`;
    }
}

export class Tui {
    readonly tty = Boolean(process.stdout.isTTY && process.stdin.isTTY);
    private readonly logLines: string[] = [];
    private timer?: NodeJS.Timeout;
    private lastSummary = 0;
    private dialog?: Dialog;
    private active = false;
    private cursor?: { x: number; y: number };

    /**
     * `keys`: the function-key bar, labels for F1..F10 (empty for none);
     * `onKey` is called with 1..10 for a function key pressed on the main screen.
     */
    constructor(private readonly model: TuiModel, private readonly keys: string[], private readonly onKey: (n: number) => void) {}

    start(): void {
        if (!this.tty) {
            this.timer = setInterval(() => {
                if (Date.now() - this.lastSummary >= SUMMARY_MS) {
                    this.lastSummary = Date.now();
                    process.stdout.write(`${stamp()}  ${this.model.summary()}\n`);
                }
            }, 1000);
            return;
        }
        this.active = true;
        // Alternate screen, no autowrap (a full last row must not scroll), cursor off.
        process.stdout.write('\x1b[?1049h\x1b[?7l\x1b[?25l');
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (d: string) => this.input(d));
        process.stdout.on('resize', () => this.render());
        process.on('exit', () => this.restore());
        this.timer = setInterval(() => this.render(), 500);
        this.render();
    }

    /** Leave the screen as it was, and print the last log lines on it. */
    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
        }
        if (this.active) {
            this.restore();
            process.stdout.write(this.logLines.slice(-15).map(l => `${l}\n`).join(''));
        }
    }

    log(text: string): void {
        const line = `${stamp()}  ${text}`;
        this.logLines.push(line);
        if (this.logLines.length > LOG_KEEP) {
            this.logLines.splice(0, this.logLines.length - LOG_KEEP);
        }
        if (this.active) {
            this.render();
        } else {
            process.stdout.write(`${line}\n`);
        }
    }

    /** An edit dialog; resolves to the text entered, or undefined on Esc. `validate` returns an error to show, or undefined. */
    prompt(o: { title: string; lines: string[]; label: string; value: string; validate?: (v: string) => string | undefined }): Promise<string | undefined> {
        return new Promise(resolve => {
            const d: Dialog = {
                title: o.title, lines: o.lines, buttons: 'Enter OK    Esc Cancel',
                input: { label: o.label, value: o.value, cursor: [...o.value].length },
                onKey: k => {
                    const inp = d.input!;
                    const chars = [...inp.value];
                    if (k.name === 'escape') {
                        this.close(d);
                        resolve(undefined);
                        return;
                    }
                    if (k.name === 'enter') {
                        const v = inp.value.trim();
                        const err = o.validate?.(v);
                        if (err) {
                            d.error = err;
                        } else {
                            this.close(d);
                            resolve(v);
                            return;
                        }
                    } else if (k.name === 'backspace' && inp.cursor > 0) {
                        chars.splice(inp.cursor - 1, 1);
                        inp.cursor--;
                    } else if (k.name === 'delete' && inp.cursor < chars.length) {
                        chars.splice(inp.cursor, 1);
                    } else if (k.name === 'left') {
                        inp.cursor = Math.max(0, inp.cursor - 1);
                    } else if (k.name === 'right') {
                        inp.cursor = Math.min(chars.length, inp.cursor + 1);
                    } else if (k.name === 'home') {
                        inp.cursor = 0;
                    } else if (k.name === 'end') {
                        inp.cursor = chars.length;
                    } else if (k.name === 'char' && k.ch) {
                        chars.splice(inp.cursor, 0, k.ch);
                        inp.cursor++;
                    }
                    inp.value = chars.join('');
                    if (k.name !== 'enter') {
                        d.error = undefined;
                    }
                },
            };
            this.open(d);
        });
    }

    /** A yes/no dialog. */
    confirm(title: string, lines: string[]): Promise<boolean> {
        return new Promise(resolve => {
            const d: Dialog = {
                title, lines, buttons: 'Y Yes    N No',
                onKey: k => {
                    const c = k.ch?.toLowerCase();
                    if (c === 'y' || k.name === 'enter') {
                        this.close(d);
                        resolve(true);
                    } else if (c === 'n' || k.name === 'escape') {
                        this.close(d);
                        resolve(false);
                    }
                },
            };
            this.open(d);
        });
    }

    /** A dialog with text only. */
    message(title: string, lines: string[]): Promise<void> {
        return new Promise(resolve => {
            const d: Dialog = {
                title, lines, buttons: 'Enter / Esc  Close',
                onKey: k => {
                    if (k.name === 'enter' || k.name === 'escape') {
                        this.close(d);
                        resolve();
                    }
                },
            };
            this.open(d);
        });
    }

    get busy(): boolean {
        return this.dialog !== undefined;
    }

    private open(d: Dialog): void {
        this.dialog = d;
        this.render();
    }

    private close(d: Dialog): void {
        if (this.dialog === d) {
            this.dialog = undefined;
        }
        this.render();
    }

    private restore(): void {
        if (!this.active) {
            return;
        }
        this.active = false;
        try {
            process.stdin.setRawMode(false);
        } catch {
            // stdin already gone
        }
        process.stdin.pause();
        process.stdout.write('\x1b[0m\x1b[?7h\x1b[?25h\x1b[?1049l');
    }

    // --- input --------------------------------------------------------------------

    private input(data: string): void {
        for (const k of parseKeys(data)) {
            if (k.name === 'ctrl-c') {
                this.onKey(10);
                continue;
            }
            if (this.dialog) {
                this.dialog.onKey(k);
                continue;
            }
            const fn = k.name.startsWith('f') ? Number(k.name.slice(1))
                : k.name === 'char' && k.ch && /^[0-9]$/.test(k.ch) ? (k.ch === '0' ? 10 : Number(k.ch))
                    : k.name === 'char' && k.ch?.toLowerCase() === 'q' ? 10 : 0;
            if (fn >= 1 && fn <= 10) {
                this.onKey(fn);
            }
        }
        this.render();
    }

    // --- drawing ------------------------------------------------------------------

    private render(): void {
        if (!this.active) {
            return;
        }
        const W = Math.max(60, process.stdout.columns ?? 80), H = Math.max(20, process.stdout.rows ?? 25);
        const g = new Grid(W, H, C.panel);
        this.cursor = undefined;

        // The panel: everything but the key bar.
        const ph = H - 1;
        g.box(0, 0, W, ph, C.panel, this.model.title(), C.title);
        const info = this.model.info();
        const labelW = Math.max(...info.map(r => r.label.length)) + 2;
        let y = 1;
        for (const r of info) {
            g.put(2, y, r.label, C.panel);
            let x = 2 + labelW;
            if (r.bar !== undefined) {
                const bw = Math.max(10, Math.min(40, W - x - 30));
                const full = Math.round(Math.max(0, Math.min(1, r.bar)) * bw);
                g.put(x, y, '█'.repeat(full), C.barFull);
                g.put(x + full, y, '░'.repeat(bw - full), C.barEmpty);
                x += bw + 2;
            }
            g.put(x, y, r.value, C[r.tone ?? 'value'], W - 2 - x);
            y++;
        }
        const threads = this.model.threads();
        const room = ph - 1 - y - 2; // rows below the info, inside the frame, less two dividers
        const threadRows = Math.max(1, Math.min(threads.length, room - Math.max(3, Math.floor(room / 3))));
        g.divider(0, y++, W, C.panel, 'Threads');
        for (let i = 0; i < threadRows; i++) {
            const t = i === threadRows - 1 && threads.length > threadRows ? `… ${threads.length - i} more` : threads[i] ?? '';
            g.put(2, y++, t, t.includes('idle') ? C.dim : C.value, W - 4);
        }
        g.divider(0, y++, W, C.panel, 'Log');
        const logRows = ph - 1 - y;
        const shown = this.logLines.slice(-logRows);
        for (const l of shown) {
            g.put(2, y++, l, /fail|lost|refus|turned away|not signed/i.test(l) ? C.bad : C.value, W - 4);
        }

        // The key bar: a digit in white on black, its label in black on cyan.
        const slot = Math.floor(W / 10);
        for (let i = 0; i < 10; i++) {
            const n = String(i + 1);
            const x = i * slot;
            g.put(x, H - 1, n, C.keyNum);
            g.put(x + n.length, H - 1, (this.keys[i] ?? '').padEnd(slot - n.length).slice(0, slot - n.length), C.keyLabel);
        }
        g.fill(10 * slot, H - 1, W - 10 * slot, 1, C.keyNum);

        if (this.dialog) {
            this.drawDialog(g, this.dialog);
        }
        const cur = this.cursor as { x: number; y: number } | undefined;
        process.stdout.write(g.serialize() + (cur ? `\x1b[${cur.y + 1};${cur.x + 1}H\x1b[?25h` : '\x1b[?25l'));
    }

    private drawDialog(g: Grid, d: Dialog): void {
        const w = Math.min(g.w - 6, Math.max(50, ...d.lines.map(l => l.length + 6), d.title.length + 8));
        const h = d.lines.length + (d.input ? 3 : 0) + 6;
        const x = Math.floor((g.w - w) / 2), y = Math.max(1, Math.floor((g.h - 1 - h) / 2));
        g.fill(x, y, w, h, C.dialog);
        // A shadow, as the old dialogs had.
        g.fill(x + 2, y + h, w, 1, '0;37;40');
        g.fill(x + w, y + 1, 2, h, '0;37;40');
        g.box(x + 1, y, w - 2, h, C.dialog, d.title, C.dialogTitle);
        let r = y + 2;
        for (const l of d.lines) {
            g.put(x + 3, r++, l, C.dialog, w - 6);
        }
        if (d.input) {
            r++;
            g.put(x + 3, r++, d.input.label, C.dialog, w - 6);
            const fw = w - 6;
            const chars = [...d.input.value];
            const start = Math.max(0, d.input.cursor - fw + 1);
            g.fill(x + 3, r, fw, 1, C.input);
            g.put(x + 3, r, chars.slice(start, start + fw).join(''), C.input, fw);
            this.cursor = { x: x + 3 + d.input.cursor - start, y: r };
            r++;
        }
        r++;
        if (d.error) {
            g.put(x + 3, r, d.error, C.dialogBad, w - 6);
        }
        g.put(x + Math.floor((w - d.buttons.length - 2) / 2), y + h - 2, ` ${d.buttons} `, C.button);
    }
}

const stamp = () => new Date().toLocaleTimeString();

/**
 * The keys in a chunk of raw stdin. Function keys come in several dialects:
 * xterm (ESC O P), VT220 (ESC [ 11 ~), and libuv's Windows console (ESC [ [ A).
 */
export function parseKeys(data: string): Key[] {
    const seqs: Array<[string, string]> = [
        ['\x1bOP', 'f1'], ['\x1bOQ', 'f2'], ['\x1bOR', 'f3'], ['\x1bOS', 'f4'],
        ['\x1b[[A', 'f1'], ['\x1b[[B', 'f2'], ['\x1b[[C', 'f3'], ['\x1b[[D', 'f4'], ['\x1b[[E', 'f5'],
        ['\x1b[11~', 'f1'], ['\x1b[12~', 'f2'], ['\x1b[13~', 'f3'], ['\x1b[14~', 'f4'], ['\x1b[15~', 'f5'],
        ['\x1b[17~', 'f6'], ['\x1b[18~', 'f7'], ['\x1b[19~', 'f8'], ['\x1b[20~', 'f9'], ['\x1b[21~', 'f10'],
        ['\x1b[D', 'left'], ['\x1b[C', 'right'], ['\x1b[A', 'up'], ['\x1b[B', 'down'],
        ['\x1b[H', 'home'], ['\x1b[F', 'end'], ['\x1b[1~', 'home'], ['\x1b[4~', 'end'], ['\x1bOH', 'home'], ['\x1bOF', 'end'],
        ['\x1b[3~', 'delete'],
    ];
    const keys: Key[] = [];
    let i = 0;
    while (i < data.length) {
        if (data[i] === '\x1b') {
            const hit = seqs.find(([s]) => data.startsWith(s, i));
            if (hit) {
                keys.push({ name: hit[1] });
                i += hit[0].length;
                continue;
            }
            // An unknown sequence: skip it whole rather than type its letters.
            const m = /^\x1b(\[[0-9;?]*[ -/]*[@-~]|O.)/.exec(data.slice(i));
            if (m) {
                i += m[0].length;
                continue;
            }
            keys.push({ name: 'escape' });
            i++;
            continue;
        }
        const ch = [...data.slice(i)][0];
        i += ch.length;
        if (ch === '\r' || ch === '\n') keys.push({ name: 'enter' });
        else if (ch === '\x7f' || ch === '\b') keys.push({ name: 'backspace' });
        else if (ch === '\x03') keys.push({ name: 'ctrl-c' });
        else if (ch === '\t') keys.push({ name: 'tab' });
        else if (ch >= ' ') keys.push({ name: 'char', ch });
    }
    return keys;
}

export function formatBytes(n: number): string {
    return n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${(n / 1e3).toFixed(0)} KB`;
}

export function formatDuration(ms: number): string {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : m > 0 ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}
