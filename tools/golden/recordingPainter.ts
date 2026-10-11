/**
 * A stand-in CanvasPainter that records every call instead of drawing, for
 * golden suites over the overlay code (HUD, cockpit MFDs, moving map). The
 * C# twin is Retro.Game.RecordingPainter; both write the same arrays:
 * [name, ...args], fonts by id, alignment and effect by enum name, omitted
 * optionals as null, images numbered by first appearance ("img0", ...),
 * batch calls prefixed "b.", clip calls "c.".
 *
 * Cast it where a CanvasPainter is expected:
 *   const rec = new RecordingPainter();
 *   hud.render2D(w, h, camera, lists, rec as unknown as CanvasPainter, palette);
 */
import { Font, TextAlignment, TextEffect } from '../../src/script/render/screen/text';

export type PainterCall = (string | number | boolean | null)[];

export class RecordingPainter {
    readonly calls: PainterCall[] = [];
    private readonly images = new Map<unknown, string>();

    private add(...call: PainterCall): void {
        this.calls.push(call);
    }

    setColor(color: string) { this.add('setColor', color); }
    setBackground(color: string) { this.add('setBackground', color); }
    setTextEffect(effect: TextEffect, effectColor: string) { this.add('setTextEffect', TextEffect[effect], effectColor); }
    setLineWidth(width: number) { this.add('setLineWidth', width); }
    clear(x?: number, y?: number, width?: number, height?: number) {
        this.add('clear', x ?? null, y ?? null, width ?? null, height ?? null);
    }
    fillRect(x: number, y: number, width: number, height: number) { this.add('fillRect', x, y, width, height); }
    hLine(x0: number, x1: number, y: number) { this.add('hLine', x0, x1, y); }
    vLine(x: number, y0: number, y1: number) { this.add('vLine', x, y0, y1); }
    line(x0: number, y0: number, x1: number, y1: number) { this.add('line', x0, y0, x1, y1); }
    rightTriangle(x0: number, y0: number, x1: number, y1: number) { this.add('rightTriangle', x0, y0, x1, y1); }
    rectangle(x: number, y: number, width: number, height: number, fill = false) { this.add('rectangle', x, y, width, height, fill); }
    circle(x: number, y: number, radius: number, fill = false) { this.add('circle', x, y, radius, fill); }
    text(font: Font, x: number, y: number, text: string, color?: string, alignment: TextAlignment = TextAlignment.LEFT) {
        this.add('text', font.id, x, y, text, color ?? null, TextAlignment[alignment]);
    }
    image(image: unknown, x: number, y: number, width: number, height: number) {
        let id = this.images.get(image);
        if (id === undefined) {
            id = `img${this.images.size}`;
            this.images.set(image, id);
        }
        this.add('image', id, x, y, width, height);
    }
    pushTransform(originX: number, originY: number, rotation: number, scale: number) {
        this.add('pushTransform', originX, originY, rotation, scale);
    }
    popTransform() { this.add('popTransform'); }

    batch() {
        this.add('batch');
        const self = this;
        const b = {
            hLine(x0: number, x1: number, y: number) { self.add('b.hLine', x0, x1, y); return b; },
            vLine(x: number, y0: number, y1: number) { self.add('b.vLine', x, y0, y1); return b; },
            line(x0: number, y0: number, x1: number, y1: number) { self.add('b.line', x0, y0, x1, y1); return b; },
            rightTriangle(x0: number, y0: number, x1: number, y1: number) { self.add('b.rightTriangle', x0, y0, x1, y1); return b; },
            commit() { self.add('b.commit'); },
        };
        return b;
    }

    clip() {
        this.add('clip');
        const self = this;
        const c = {
            rectangle(x: number, y: number, width: number, height: number) { self.add('c.rectangle', x, y, width, height); return c; },
            circle(x: number, y: number, radius: number) { self.add('c.circle', x, y, radius); return c; },
            clip() { self.add('c.clip'); return c; },
            clear() { self.add('c.clear'); },
        };
        return c;
    }
}
