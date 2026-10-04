"""Railway points (turnouts) found in the track topology and given their curve.

OSM draws a turnout as a node two tracks share: the through track passes
straight on and the diverging track leaves it at a few degrees, its first
segment a chord to wherever the mapper put the next node. Drawn as is, the
diverging track kinks off the through track at the switch. Here each one
gets what a real turnout has: a circular arc leaving the through track
tangentially at the switch (TURNOUT_RADIUS_M, a 1:12 turnout on a main line
and the German 190 m siding turnout on service track), then a straight
tangent onto the mapped line.

Each turnout also yields two short zone polylines from the switch - the
diverging track's and the through track's, TRACK_ZONE_*_CLASS - for the
stroke bake: inside the zone the diverging track draws no sleepers of its
own and the through track draws long timbers reaching under it (see
tools/bake/drapeRoads.ts, TRACK_FLAG_* in src/script/terrain/ptr.ts).

Nothing here knows about tiles; it runs on the assembled runs, before
clipping, so a turnout at a tile border is one curve.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple

LonLat = Tuple[float, float]

METRES_PER_DEGREE = 111320.0

# The steepest angle a diverging track leaves the through track at and
# still reads as a turnout. Past it two tracks cross or meet at a junction,
# and the two-pass track drawing shows that without any curve.
TURNOUT_MAX_DEG = 25.0
# Below this the two are one line drawn twice; nothing to fit.
TURNOUT_MIN_DEG = 0.3
# Two run ends meeting at a node within this of a straight line are one
# through track (a main line split into two ways at the switch).
THROUGH_MAX_DEG = 10.0
# How far along the diverging track the tangent from the arc is aimed at.
LOOK_AHEAD_M = 80.0
# A diverging track shorter than this keeps its mapped shape.
MIN_DIVERGING_M = 15.0
# The farthest the fitted curve may stray from the mapped line before the
# turnout is left as mapped instead.
MAX_DEVIATION_M = 3.0
# Spacing of the arc's points, metres.
ARC_STEP_M = 2.0
# The switch zone ends where the diverging track's centre is this far from
# the through track's: its sleepers then clear the through track's.
TURNOUT_ZONE_OFFSET_M = 2.8


@dataclass
class Turnout:
    """One fitted switch, for the bake summary and the zone polylines."""
    switch: LonLat
    radius_m: float
    angle_deg: float
    diverging_zone: List[LonLat]
    through_zone: List[LonLat]


@dataclass
class TurnoutStats:
    found: int = 0
    fitted: int = 0
    refused: int = 0
    turnouts: List[Turnout] = field(default_factory=list)


class _Frame:
    """Metres east and north of an origin, equirectangular: exact enough over the few hundred metres a turnout spans."""

    def __init__(self, origin: LonLat):
        self.lon0, self.lat0 = origin
        self.kx = METRES_PER_DEGREE * math.cos(math.radians(self.lat0))
        self.ky = METRES_PER_DEGREE

    def to(self, p: LonLat) -> Tuple[float, float]:
        return ((p[0] - self.lon0) * self.kx, (p[1] - self.lat0) * self.ky)

    def back(self, x: float, y: float) -> LonLat:
        return (self.lon0 + x / self.kx, self.lat0 + y / self.ky)


def _unit(x: float, y: float) -> Optional[Tuple[float, float]]:
    n = math.hypot(x, y)
    return (x / n, y / n) if n > 1e-9 else None


def _angle_deg(a: Tuple[float, float], b: Tuple[float, float]) -> float:
    return math.degrees(math.acos(max(-1.0, min(1.0, a[0] * b[0] + a[1] * b[1]))))


def _direction_from(frame: _Frame, coords: Sequence[LonLat], min_m: float = 1.0) -> Optional[Tuple[float, float]]:
    """Unit direction from coords[0] toward the first point at least min_m away."""
    x0, y0 = frame.to(coords[0])
    for p in coords[1:]:
        x, y = frame.to(p)
        if math.hypot(x - x0, y - y0) >= min_m:
            return _unit(x - x0, y - y0)
    return None


def _walk(frame: _Frame, coords: Sequence[LonLat], length_m: float) -> List[Tuple[float, float]]:
    """The polyline from coords[0], in metres, cut at length_m along it."""
    out = [frame.to(coords[0])]
    run = 0.0
    for p in coords[1:]:
        x, y = frame.to(p)
        px, py = out[-1]
        seg = math.hypot(x - px, y - py)
        if seg <= 1e-9:
            continue
        if run + seg >= length_m:
            t = (length_m - run) / seg
            out.append((px + (x - px) * t, py + (y - py) * t))
            return out
        out.append((x, y))
        run += seg
    return out


def _length(pts: Sequence[Tuple[float, float]]) -> float:
    return sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:]))


def _point_segment(p: Tuple[float, float], a: Tuple[float, float], b: Tuple[float, float]) -> float:
    dx, dy = b[0] - a[0], b[1] - a[1]
    l2 = dx * dx + dy * dy
    t = 0.0 if l2 < 1e-12 else max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2))
    return math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t)


def _distance_to(p: Tuple[float, float], line: Sequence[Tuple[float, float]]) -> float:
    return min(_point_segment(p, a, b) for a, b in zip(line, line[1:]))


def fit_arc(
    tangent: Tuple[float, float], mapped: Sequence[Tuple[float, float]], radius_m: float,
    max_look_m: float = LOOK_AHEAD_M,
) -> Optional[List[Tuple[float, float]]]:
    """The diverging track from the switch at the origin, in metres.

    `tangent` is the through track's direction at the switch, pointing the
    way the diverging track leaves; `mapped` the diverging track as OSM has
    it, from the switch. Returns the arc from the origin, sampled every
    ARC_STEP_M, ending where its tangent runs straight at the look-ahead
    point on the mapped line - followed by that point and the mapped line
    past it - or None when no such curve stays within MAX_DEVIATION_M of the
    mapped line.
    """
    total = _length(mapped)
    if total < MIN_DIVERGING_M:
        return None
    look = min(LOOK_AHEAD_M, max_look_m, total)
    if look < MIN_DIVERGING_M:
        return None
    ahead = _walk_points(mapped, look)
    d = ahead[-1]
    tx, ty = tangent
    # Which way the diverging track turns off the through track.
    side = 1.0 if tx * d[1] - ty * d[0] > 0 else -1.0
    nx, ny = -ty * side, tx * side

    def end(phi: float) -> Tuple[Tuple[float, float], Tuple[float, float]]:
        ex = radius_m * (math.sin(phi) * tx + (1 - math.cos(phi)) * nx)
        ey = radius_m * (math.sin(phi) * ty + (1 - math.cos(phi)) * ny)
        hx = math.cos(phi) * tx + math.sin(phi) * nx
        hy = math.cos(phi) * ty + math.sin(phi) * ny
        return (ex, ey), (hx, hy)

    def miss(phi: float) -> float:
        # Which side of the arc end's tangent the look-ahead point lies on;
        # zero where the tangent runs straight at it.
        (ex, ey), (hx, hy) = end(phi)
        return (hx * (d[1] - ey) - hy * (d[0] - ex)) * side

    lo, hi = 0.0, math.radians(TURNOUT_MAX_DEG) * 1.5
    if miss(lo) <= 0 or miss(hi) >= 0:
        return None
    for _ in range(50):
        mid = 0.5 * (lo + hi)
        if miss(mid) > 0:
            lo = mid
        else:
            hi = mid
    phi = 0.5 * (lo + hi)
    (ex, ey), _h = end(phi)
    arc_len = radius_m * phi
    if math.hypot(ex - d[0], ey - d[1]) < 1.0 or arc_len >= _length(ahead):
        return None
    steps = max(1, int(math.ceil(arc_len / ARC_STEP_M)))
    curve = [end(phi * k / steps)[0] for k in range(steps + 1)]
    curve.append(d)
    # Strays from the mapped line, both ways: the curve from it, and the
    # mapped nodes the curve replaces from the curve.
    for p in curve:
        if _distance_to(p, mapped) > MAX_DEVIATION_M:
            return None
    for p in ahead[1:-1]:
        if _distance_to(p, curve) > MAX_DEVIATION_M:
            return None
    rest = _after(mapped, look)
    return curve + rest


def _walk_points(pts: Sequence[Tuple[float, float]], length_m: float) -> List[Tuple[float, float]]:
    out = [pts[0]]
    run = 0.0
    for p in pts[1:]:
        px, py = out[-1]
        seg = math.hypot(p[0] - px, p[1] - py)
        if seg <= 1e-9:
            continue
        if run + seg >= length_m:
            t = (length_m - run) / seg
            out.append((px + (p[0] - px) * t, py + (p[1] - py) * t))
            return out
        out.append(p)
        run += seg
    return out


def _after(pts: Sequence[Tuple[float, float]], length_m: float) -> List[Tuple[float, float]]:
    """The mapped points strictly past length_m along the line."""
    run = 0.0
    for i in range(1, len(pts)):
        run += math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
        if run > length_m + 1e-6:
            return list(pts[i:])
    return []


def _along_to(pts: Sequence[Tuple[float, float]], p: Tuple[float, float]) -> float:
    """Distance along a polyline to the point on it nearest `p`."""
    best, at, run = float('inf'), 0.0, 0.0
    for a, b in zip(pts, pts[1:]):
        dx, dy = b[0] - a[0], b[1] - a[1]
        seg = math.hypot(dx, dy)
        t = 0.0 if seg < 1e-9 else max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (seg * seg)))
        d = math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t)
        if d < best:
            best, at = d, run + t * seg
        run += seg
    return at


def zone_length_m(radius_m: float) -> float:
    """How far from the switch the diverging track is TURNOUT_ZONE_OFFSET_M off the through track."""
    return math.sqrt(2.0 * radius_m * TURNOUT_ZONE_OFFSET_M)


def fit_turnouts(
    runs: List[Tuple[int, List[int]]], nodes: Dict[int, LonLat], radius_for: Dict[int, float],
    stats: Optional[TurnoutStats] = None,
) -> List[List[LonLat]]:
    """The coordinates of every run, its turnout ends replaced by fitted curves.

    `runs` are (class byte, node ids) for every track run; `radius_for`
    gives the turnout radius by the diverging run's class. Returns one
    coordinate list per run, in order; `stats` collects what was found and
    the switch-zone polylines.
    """
    occurrences: Dict[int, List[Tuple[int, int]]] = {}
    for r, (_cls, ids) in enumerate(runs):
        for i, nid in enumerate(ids):
            occurrences.setdefault(nid, []).append((r, i))
    coords = [[nodes[n] for n in ids] for _cls, ids in runs]
    stats = stats if stats is not None else TurnoutStats()

    # Candidates first, one per node at most: at a Y where two ways end in
    # a near-straight line and a third leaves between them, each branch can
    # look like the diverging one against the other two. The straightest
    # through track wins, then the smallest angle off it.
    best_at: Dict[int, Tuple[float, float, int, bool, Tuple[float, float], List[LonLat]]] = {}
    for r, (cls, ids) in enumerate(runs):
        for at_start in (True, False):
            n = ids[0] if at_start else ids[-1]
            if len(occurrences.get(n, ())) < 2:
                continue
            frame = _Frame(nodes[n])
            mine = coords[r] if at_start else coords[r][::-1]
            out = _direction_from(frame, mine)
            if out is None:
                continue
            found = _through(r, n, out, occurrences, runs, coords, frame)
            if found is None:
                continue
            bend, angle, tangent, through_path = found
            if not (TURNOUT_MIN_DEG < angle < TURNOUT_MAX_DEG):
                continue
            key = (bend, angle)
            held = best_at.get(n)
            if held is None or key < (held[0], held[1]):
                best_at[n] = (bend, angle, r, at_start, tangent, through_path)

    for n, (_bend, angle, r, at_start, tangent, through_path) in best_at.items():
        cls = runs[r][0]
        stats.found += 1
        frame = _Frame(nodes[n])
        mine = coords[r] if at_start else coords[r][::-1]
        radius = radius_for.get(cls, 300.0)
        mapped = [frame.to(p) for p in mine]
        # The curve may not reshape the track past a node another track
        # attaches to: that track would start beside it, its rails ending
        # in the ballast. It ends on that node at the latest.
        ids = runs[r][1] if at_start else runs[r][1][::-1]
        anchor = next((nodes[nid] for nid in ids[1:] if len(occurrences.get(nid, ())) > 1), None)
        max_look = _along_to(mapped, frame.to(anchor)) if anchor is not None else LOOK_AHEAD_M
        curve = fit_arc(tangent, mapped, radius, max_look)
        if curve is None:
            stats.refused += 1
            continue
        stats.fitted += 1
        lonlat = [frame.back(x, y) for x, y in curve]
        coords[r] = lonlat if at_start else lonlat[::-1]
        zone = zone_length_m(radius)
        stats.turnouts.append(Turnout(
            switch=nodes[n], radius_m=radius, angle_deg=angle,
            diverging_zone=[frame.back(x, y) for x, y in _walk_points(curve, zone)],
            through_zone=[frame.back(x, y) for x, y in _walk(frame, through_path, zone)],
        ))
    return coords


def _through(
    r: int, n: int, out: Tuple[float, float], occurrences: Dict[int, List[Tuple[int, int]]],
    runs: List[Tuple[int, List[int]]], coords: List[List[LonLat]], frame: _Frame,
) -> Optional[Tuple[float, float, Tuple[float, float], List[LonLat]]]:
    """The through track at node n for a run r leaving it along `out`.

    Either another run passing through n, or two other runs ending at n in a
    straight line. Returns (how far the through track bends at n in degrees,
    0 for one passing through; angle to `out` in degrees; the through
    track's direction on `out`'s side; its coordinates from n that way), the
    smallest angle of all candidates, or None.
    """
    best: Optional[Tuple[float, float, Tuple[float, float], List[LonLat]]] = None

    def consider(path: List[LonLat], bend: float = 0.0) -> None:
        nonlocal best
        d = _direction_from(frame, path)
        if d is None:
            return
        a = _angle_deg(out, d)
        if best is None or a < best[1]:
            best = (bend, a, d, path)

    ends: List[Tuple[float, float, List[LonLat]]] = []
    for other, i in occurrences.get(n, ()):
        if other == r:
            continue
        c = coords[other]
        if 0 < i < len(c) - 1:
            # Passes through: either way along it is a candidate.
            consider(c[i:])
            consider(c[i::-1])
        else:
            path = c if i == 0 else c[::-1]
            d = _direction_from(frame, path)
            if d is not None:
                ends.append((d[0], d[1], path))
    for a in range(len(ends)):
        for b in range(a + 1, len(ends)):
            ua = (ends[a][0], ends[a][1])
            ub = (ends[b][0], ends[b][1])
            bend = _angle_deg(ua, (-ub[0], -ub[1]))
            if bend < THROUGH_MAX_DEG:
                consider(ends[a][2], bend)
                consider(ends[b][2], bend)
    return best
