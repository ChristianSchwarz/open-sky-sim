import { APP_BASE_HREF, Location } from '@angular/common';
import { createApplication } from '@angular/platform-browser';
import { NavigationEnd, Router, provideRouter, withRouterConfig } from '@angular/router';

/**
 * The game page's routes, kept by the Angular Router. The free flight, the
 * map (`?map`) and a mission's flight (`?mission=id`) are all index.html,
 * told apart by their query (state/appRoute.ts); no route has a component,
 * since the game draws itself, so every URL matches the one empty route and
 * the game moves itself to each navigation once it ends. Going from one page
 * to another is a router navigation - a history entry, never a load - and
 * Back and Forward come in as the router's own popstate navigations.
 *
 * The camera route (state/cameraRoute.ts) and the map's zoom (mapView.ts)
 * are still rewritten with replaceState as the view moves: the router does
 * not see those, and need not, since each entry's URL is read back whole
 * when the router navigates to it.
 */
export interface AppNavigator {
    /** Go to `url` (as mapViewUrl or missionUrl write it), as a new history entry. */
    navigate(url: string): void;
    back(): void;
}

/**
 * Start the router on the page as loaded and call `onRoute` with the URL of
 * every later navigation. The first one is the page the boot has already
 * built, so it is not passed on.
 */
export async function startAppRouter(onRoute: (url: string) => void): Promise<AppNavigator> {
    // Wherever the page is served from: the dev server's root or the published game's folder.
    const base = location.pathname.slice(0, location.pathname.lastIndexOf('/') + 1);
    const app = await createApplication({
        providers: [
            // A Back onto an entry the router last saw under the same URL still has to reach the game.
            provideRouter([{ path: '**', children: [] }], withRouterConfig({ onSameUrlNavigation: 'reload' })),
            { provide: APP_BASE_HREF, useValue: base },
        ],
    });
    const router = app.injector.get(Router);
    const loc = app.injector.get(Location);
    let first = true;
    router.events.subscribe(e => {
        if (!(e instanceof NavigationEnd)) {
            return;
        }
        if (first) {
            first = false;
            return;
        }
        onRoute(e.urlAfterRedirects);
    });
    // Without a bootstrapped component nothing starts it: this also listens for popstate.
    router.initialNavigation();
    return {
        navigate: url => void router.navigateByUrl(url.startsWith('/') ? url : `/${url}`),
        back: () => loc.back(),
    };
}
