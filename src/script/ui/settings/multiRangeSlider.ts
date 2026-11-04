import { ChangeDetectionStrategy, Component, ElementRef, computed, input, linkedSignal, output, viewChild } from '@angular/core';

/**
 * A slider with any number of ordered thumbs over one track, each segment
 * between them tinted: Material's slider stops at two thumbs.
 *
 * Tailwind only, like the rest of the dialog, coloured from Material's
 * documented `--mat-sys-*` tokens. The scale is square-root: the near end,
 * where a kilometre matters, gets most of the track. Each thumb is a
 * `role="slider"` that takes the arrow keys, Page Up/Down, Home and End; a
 * press on the track takes the nearest thumb and drags it. Thumbs never pass
 * one another.
 */
@Component({
    selector: 'rfs-multi-range-slider',
    changeDetection: ChangeDetectionStrategy.OnPush,
    host: { class: 'block' },
    template: `
<div #track class="relative h-10 cursor-pointer touch-none select-none"
    (pointerdown)="press($event)" (pointermove)="drag($event)"
    (pointerup)="release($event)" (pointercancel)="release($event)">
    @for (segment of segments(); track $index) {
        <div class="absolute top-1/2 h-2 -translate-y-1/2" [class]="segment.cls"
            [style.left.%]="segment.left" [style.width.%]="segment.width"></div>
    }
    @for (value of current(); track $index) {
        <div role="slider" tabindex="0"
            class="absolute top-1/2 size-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2
                border-[var(--mat-sys-surface)] bg-[var(--mat-sys-primary)] shadow
                outline-offset-2 focus-visible:outline-2 focus-visible:outline-[var(--mat-sys-primary)]"
            [style.left.%]="toPercent(value)"
            [style.z-index]="active === $index ? 2 : 1"
            [attr.aria-label]="labels()[$index]"
            [attr.aria-valuemin]="0" [attr.aria-valuemax]="max()" [attr.aria-valuenow]="value"
            [attr.aria-valuetext]="format()(value)"
            (keydown)="key($event, $index)"></div>
    }
</div>
`,
})
export class MultiRangeSlider {
    /** Ascending, one per thumb. */
    readonly values = input.required<number[]>();
    readonly max = input.required<number>();
    /** One per thumb, for screen readers. */
    readonly labels = input.required<string[]>();
    /** Tailwind classes per segment: before the first thumb, between each pair, after the last. */
    readonly segmentClasses = input.required<string[]>();
    /** A thumb's value as read out. */
    readonly format = input<(value: number) => string>(v => String(v));
    /** Every change, while dragging too. */
    readonly valuesChange = output<number[]>();

    /**
     * The thumbs as this slider last moved them, following `values` when the
     * parent changes it: a burst of events (key repeat, a fast drag) between
     * two renders must build on its own moves, not on a stale input.
     */
    protected readonly current = linkedSignal(() => this.values());

    private readonly track = viewChild.required<ElementRef<HTMLElement>>('track');
    /** The thumb under the pointer, or -1. */
    protected active = -1;

    protected readonly segments = computed(() => {
        const stops = [0, ...this.current().map(v => this.toPercent(v)), 100];
        const cls = this.segmentClasses();
        return stops.slice(1).map((end, i) => ({
            left: stops[i], width: end - stops[i],
            cls: `${cls[i] ?? ''} ${i === 0 ? 'rounded-l-full' : ''} ${i === stops.length - 2 ? 'rounded-r-full' : ''}`,
        }));
    });

    protected toPercent(value: number): number {
        return Math.sqrt(Math.min(1, Math.max(0, value / this.max()))) * 100;
    }

    private fromFraction(f: number): number {
        const clamped = Math.min(1, Math.max(0, f));
        return snap(this.max() * clamped * clamped, this.max());
    }

    protected press(event: PointerEvent): void {
        const value = this.valueAt(event);
        const values = this.current();
        // The nearest thumb; of several stacked on one spot, the one that can
        // move toward the pointer.
        let best = 0;
        for (let i = 1; i < values.length; i++) {
            const d = Math.abs(values[i] - value), bestD = Math.abs(values[best] - value);
            if (d < bestD || (d === bestD && value > values[i])) {
                best = i;
            }
        }
        this.active = best;
        this.track().nativeElement.setPointerCapture(event.pointerId);
        (this.track().nativeElement.children[this.segments().length + best] as HTMLElement | undefined)?.focus();
        this.move(best, value);
        event.preventDefault();
    }

    protected drag(event: PointerEvent): void {
        if (this.active >= 0) {
            this.move(this.active, this.valueAt(event));
        }
    }

    protected release(event: PointerEvent): void {
        this.active = -1;
        const el = this.track().nativeElement;
        if (el.hasPointerCapture(event.pointerId)) {
            el.releasePointerCapture(event.pointerId);
        }
    }

    protected key(event: KeyboardEvent, index: number): void {
        const value = this.current()[index];
        const max = this.max();
        const step = stepAt(value, max);
        const next: Record<string, number> = {
            ArrowLeft: value - step, ArrowDown: value - step,
            ArrowRight: value + step, ArrowUp: value + step,
            PageDown: value - step * 10, PageUp: value + step * 10,
            Home: 0, End: max,
        };
        if (event.key in next) {
            this.move(index, snap(next[event.key], max));
            event.preventDefault();
        }
    }

    private valueAt(event: PointerEvent): number {
        const rect = this.track().nativeElement.getBoundingClientRect();
        return this.fromFraction((event.clientX - rect.left) / Math.max(1, rect.width));
    }

    /** Move one thumb, held between its neighbours. */
    private move(index: number, value: number): void {
        const values = [...this.current()];
        const lo = index > 0 ? values[index - 1] : 0;
        const hi = index < values.length - 1 ? values[index + 1] : this.max();
        const clamped = Math.min(hi, Math.max(lo, value));
        if (clamped !== values[index]) {
            values[index] = clamped;
            this.current.set(values);
            this.valuesChange.emit(values);
        }
    }
}

/** The step a value moves by: finer near the start, where the scale is. */
function stepAt(value: number, max: number): number {
    const share = value / max;
    return share < 0.02 ? 0.5 : share < 0.2 ? 1 : 5;
}

function snap(value: number, max: number): number {
    const v = Math.min(max, Math.max(0, value));
    if (v >= max) {
        return max;
    }
    const step = stepAt(v, max);
    return Math.min(max, Math.round(v / step) * step);
}
