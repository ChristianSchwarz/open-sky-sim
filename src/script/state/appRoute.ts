/**
 * Which of the game's pages a URL names. Three share index.html: the free
 * flight (or fixed camera), the map (`?map`, F12, mapView.ts) and a
 * mission's flight (`?mission=id`). The Angular Router moves between them
 * without a reload (ui/appRouter.ts) and Game.applyRoute moves the game to
 * match; this only reads and writes the URLs.
 */

export interface AppRoute {
    map: boolean;
    /** The mission flown, by its saved id. */
    mission?: string;
}

export function parseAppRoute(search: string = location.search): AppRoute {
    const q = new URLSearchParams(search);
    const mission = q.get('mission');
    return { map: q.has('map'), mission: mission ? mission : undefined };
}

/** The game page flying a saved mission. */
export function missionUrl(id: string): string {
    return `index.html?mission=${encodeURIComponent(id)}`;
}

/** A router URL (`/index.html?...#...`) split as location would give it. */
export function splitAppUrl(url: string): { search: string; hash: string } {
    const u = new URL(url, 'http://page/');
    return { search: u.search, hash: u.hash };
}
