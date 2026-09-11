import { AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, OnDestroy, viewChild } from '@angular/core';
import { areaPicker } from '../../osd/areaPicker';

/**
 * Hosts the terrain importer in the settings dialog.
 *
 * The importer stays a plain canvas-and-DOM class rather than being rewritten
 * as Angular: it is a slippy map plus a server job monitor, and none of that
 * gains from templates. The tab only lends it a place on the page, and Material
 * creates tab content on activation and destroys it on leaving, which maps
 * straight onto mount and unmount.
 */
@Component({
    selector: 'rfs-terrain-import-tab',
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `<div #host></div>`,
})
export class TerrainImportTab implements AfterViewInit, OnDestroy {
    private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');

    ngAfterViewInit(): void {
        void areaPicker().mount(this.host().nativeElement);
    }

    ngOnDestroy(): void {
        areaPicker().unmount();
    }
}
