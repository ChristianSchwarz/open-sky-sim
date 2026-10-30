"""Graded surfaces for airfield pavement: the ground's own profile, held to
the slopes an aeroplane can use.

A runway used to be cut into a single plane fitted once for its whole
airfield. That is right for a field on a table and wrong everywhere else: on
ground that rises or rolls it cut a shelf with a cliff at one end, and the
taxiways leaving the shelf floated or buried themselves. Here every runway,
taxiway and apron follows the DEM's ground instead, at the pyramid's finest
level, and is only changed where that ground is steeper or bumpier than ICAO
Annex 14 lets a paved surface be.

The grade is a least-squares fit of a profile h(s) to the measured heights
along the centreline, subject to

  local     |dh/ds| <= limit                      (slope between stations)
  curve     |d2h/ds2| <= 1 / R                    (minimum vertical curve radius)
  overall   (max h - min h) / length <= limit     (runways only)

solved by ADMM (no scipy here: bake satellites carry numpy only). The fit is
robust against the high tail - a hangar or a tree line the DEM still holds -
by weighting down stations that sit well above the profile.

Each graded profile is classified so a bad one is reported rather than baked
silently:

  ok        the ground already meets the limits; the profile is the ground
  graded    the ground was steeper or bumpier; the profile was cut/filled to
            the limits by at most WARN_EARTHWORK_M
  steep     a short unpaved strip steeper than the limits (hill and glider
            strips are like that); its own slope is kept, up to the limits'
            steep_cap
  suspect   graded by more than WARN_EARTHWORK_M - the DEM and OSM may
            disagree about where the ground is
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Dict, Optional, Sequence, Tuple

import numpy as np


@dataclass(frozen=True)
class Limits:
    """What one kind of pavement may do, ICAO Annex 14 3.1 and 3.9."""
    name: str
    #: Largest slope between neighbouring stations.
    local: float
    #: Smallest vertical curve radius, metres.
    radius_m: float
    #: Largest (max - min) / length, or None where Annex 14 sets none.
    overall: Optional[float]
    #: Largest slope a short unpaved strip may keep (`steep`).
    steep_cap: float


# Runways by code number, which is set by the field length. A code 4 runway
# also wants 0.8 % in its first and last quarter for a precision approach;
# that is not modelled: the overall 1 % already holds most of them there.
RUNWAY_CODE_4 = Limits('runway code 4', 0.0125, 30000.0, 0.01, 0.0125)
RUNWAY_CODE_3 = Limits('runway code 3', 0.015, 15000.0, 0.01, 0.015)
RUNWAY_CODE_12 = Limits('runway code 1/2', 0.02, 7500.0, 0.02, 0.20)
TAXIWAY_LARGE = Limits('taxiway', 0.015, 3000.0, None, 0.015)
TAXIWAY_SMALL = Limits('taxiway small', 0.03, 2500.0, None, 0.12)

#: Annex 14's code 3 and code 4 boundaries, metres of runway.
CODE_3_LENGTH_M = 1200.0
CODE_4_LENGTH_M = 1800.0

#: Apron slope, any direction (Annex 14 3.13.4).
APRON_GRADIENT_LIMIT = 0.01

#: Station spacing the profiles are solved and stored at. A graded profile is
#: smooth - over 20 m a 7.5 km vertical curve bows 7 mm off its chord - so a
#: finer one would store the same line.
PROFILE_STEP_M = 20.0

#: Cut or fill past this is reported (`suspect`): a real airfield on real
#: ground sits within a few metres of it.
WARN_EARTHWORK_M = 15.0

#: Within this the ground already meets the limits.
OK_TOLERANCE = 1.05

#: Stations more than this above the profile are weighted down by the square
#: of how far: the DEM still carries some buildings and trees, an airfield is
#: where they stand, and they are all on the high side of the ground.
HIGH_TAIL_M = 2.0
IRLS_PASSES = 3

#: ADMM over-relaxation.
ALPHA = 1.6

#: Baseline the natural ground's slope is read over: station to station, the
#: DEM's half-metre noise alone reads as 2-3 %.
NATURAL_BASELINE_M = 100.0

#: A pinned station's weight against a measured one's 1.
PIN_WEIGHT = 1e4


def runway_limits(length_m: float, surface: str) -> Limits:
    """Annex 14 limits for a runway of this length."""
    if length_m >= CODE_4_LENGTH_M:
        return RUNWAY_CODE_4
    if length_m >= CODE_3_LENGTH_M:
        return RUNWAY_CODE_3
    return RUNWAY_CODE_12


def taxiway_limits(longest_runway_m: float) -> Limits:
    """Taxiway limits for an airfield whose longest runway is this long: code
    C and up for code 3/4 fields, A/B for the small ones."""
    return TAXIWAY_LARGE if longest_runway_m >= CODE_3_LENGTH_M else TAXIWAY_SMALL


def _difference_rows(n: int, order: int) -> np.ndarray:
    """First or second difference operator, (n - order) x n."""
    m = n - order
    d = np.zeros((m, n))
    i = np.arange(m)
    if order == 1:
        d[i, i] = -1.0
        d[i, i + 1] = 1.0
    else:
        d[i, i] = 1.0
        d[i, i + 1] = -2.0
        d[i, i + 2] = 1.0
    return d


def solve_profile(
    h: np.ndarray, w: np.ndarray, step: float, local: float, radius_m: float,
    band: Optional[Tuple[float, float]] = None, iters: int = 3000,
) -> np.ndarray:
    """Weighted least-squares fit of a profile to `h` (weights `w`) whose
    slopes stay within `local` and whose curvature within 1 / `radius_m`,
    optionally inside a height `band`.

    ADMM over the stacked constraint rows A = [D1; k D2; I], each held to its
    box. The curvature rows are scaled so their box is as wide as the slope
    rows', or their millimetre bounds would converge last by orders of
    magnitude.
    """
    n = len(h)
    if n == 1:
        return h.copy()
    b1 = local * step
    rows = [_difference_rows(n, 1)]
    lo = [np.full(n - 1, -b1)]
    hi = [np.full(n - 1, b1)]
    if n >= 3 and radius_m > 0:
        b2 = step * step / radius_m
        k = b1 / b2 if b2 > 0 else 1.0
        rows.append(_difference_rows(n, 2) * k)
        lo.append(np.full(n - 2, -b1))
        hi.append(np.full(n - 2, b1))
    if band is not None:
        rows.append(np.eye(n))
        lo.append(np.full(n, band[0]))
        hi.append(np.full(n, band[1]))
    a = np.vstack(rows)
    lo_v = np.concatenate(lo)
    hi_v = np.concatenate(hi)
    # rho near the mean weight balances the fit against the constraints;
    # the pins' large weights are the fit's, not ADMM's, and must not set it.
    rho = max(1e-3, float(np.median(w[w > 0])) if np.any(w > 0) else 1.0)
    m = np.diag(w) + rho * (a.T @ a)
    m_inv = np.linalg.inv(m)
    wh = w * h
    g = np.where(np.isfinite(h), h, np.nanmean(h) if np.any(np.isfinite(h)) else 0.0)
    z = np.clip(a @ g, lo_v, hi_v)
    u = np.zeros_like(z)
    for it in range(iters):
        g = m_inv @ (wh + rho * (a.T @ (z - u)))
        # Over-relaxed (Boyd et al. 3.4.3): markedly fewer iterations here.
        ag = ALPHA * (a @ g) + (1 - ALPHA) * z
        z_new = np.clip(ag + u, lo_v, hi_v)
        u += ag - z_new
        if it % 50 == 49:
            primal = float(np.max(np.abs(ag - z_new)))
            dual = float(np.max(np.abs(z_new - z)))
            if primal < 1e-4 * max(1.0, b1) and dual < 1e-4 * max(1.0, b1):
                z = z_new
                break
        z = z_new
    return repair_profile(g, w, wh / np.maximum(w, 1e-12), step, local, radius_m, band)


def repair_profile(
    g: np.ndarray, w: np.ndarray, target: np.ndarray, step: float, local: float, radius_m: float,
    band: Optional[Tuple[float, float]] = None,
) -> np.ndarray:
    """Make an almost-feasible ADMM profile exactly feasible, moving it as
    little as the constraints need.

    ADMM gets within a few percent of the slope limits in a few thousand
    iterations and then crawls. The repair works on the slopes: clipped to
    `local`, then swept forwards and backwards so neighbouring slopes differ by
    no more than the curvature allows (each sweep clips to both boxes, so it
    stays inside them), the two sweeps averaged - the feasible slopes are a
    convex set, so their mean is in it too, and it has neither sweep's lean.
    Integrated back and re-levelled on the weighted residual; squeezed about
    its middle into `band`, which shrinks every slope and curvature with it.
    """
    n = len(g)
    if n < 2:
        return g
    p = np.clip(np.diff(g) / step, -local, local)
    c = step / radius_m if radius_m > 0 else math.inf
    fwd = p.copy()
    for i in range(1, len(p)):
        fwd[i] = min(local, max(-local, min(fwd[i - 1] + c, max(fwd[i - 1] - c, fwd[i]))))
    bwd = p.copy()
    for i in range(len(p) - 2, -1, -1):
        bwd[i] = min(local, max(-local, min(bwd[i + 1] + c, max(bwd[i + 1] - c, bwd[i]))))
    p = 0.5 * (fwd + bwd)
    shape = np.concatenate([[0.0], np.cumsum(p * step)])
    out = shape + float(np.sum(w * (target - shape)) / np.sum(w))
    if band is not None:
        lo, hi = band
        span = hi - lo
        rng = out.max() - out.min()
        if rng > span:
            mid = 0.5 * (out.max() + out.min())
            out = mid + (out - mid) * (span / rng)
        shift = max(0.0, lo - out.min()) - max(0.0, out.max() - hi)
        out = out + shift
    return out


def robust_fit(
    h: np.ndarray, step: float, local: float, radius_m: float,
    band: Optional[Tuple[float, float]] = None, pins: Optional[Dict[int, float]] = None,
) -> np.ndarray:
    """`solve_profile` weighted down against the high tail; NaN stations are
    left to the constraints, pinned ones held to their height."""
    finite = np.isfinite(h)
    base = finite.astype(np.float64)
    target = np.where(finite, h, 0.0)
    if pins:
        for i, v in pins.items():
            base[i] = PIN_WEIGHT
            target[i] = v
    # A run with no measured station at all is still solvable: the slope
    # rows tie the stations together and the tiny weight fixes the level.
    base = np.maximum(base, 1e-6)
    w = base.copy()
    g = solve_profile(target, w, step, local, radius_m, band)
    for _ in range(IRLS_PASSES):
        r = target - g
        w = base.copy()
        over = (r > HIGH_TAIL_M) & finite
        if pins:
            for i in pins:
                over[i] = False
        w[over] = base[over] * (HIGH_TAIL_M / r[over]) ** 2
        g = solve_profile(target, w, step, local, radius_m, band)
    return g


def profile_stats(g: np.ndarray, step: float) -> dict:
    """Overall and worst local slope, and worst slope change, of a profile."""
    n = len(g)
    length = step * (n - 1)
    slopes = np.diff(g) / step if n >= 2 else np.zeros(0)
    curv = np.diff(slopes) / step if n >= 3 else np.zeros(0)
    return {
        'overall': float((g.max() - g.min()) / length) if length > 0 else 0.0,
        'local': float(np.max(np.abs(slopes))) if len(slopes) else 0.0,
        'minRadiusM': float(1.0 / np.max(np.abs(curv))) if len(curv) and np.max(np.abs(curv)) > 0 else math.inf,
    }


def grade_profile(
    h: np.ndarray, step: float, limits: Limits, *, paved: bool,
    pins: Optional[Dict[int, float]] = None,
) -> Tuple[np.ndarray, dict]:
    """The profile one strip is laid on, and what was done to get it.

    `h` is the DEM height per station (NaN where the DEM has none), `paved`
    the surface. Returns the profile and a report: the natural ground's slopes,
    the profile's, the earthwork between them and the classification.
    """
    n = len(h)
    finite = np.isfinite(h)
    # The ground as it is: smoothed to the gentlest radius any strip may use,
    # but free in slope, so what it reads as steep is the ground's own.
    natural = robust_fit(h, step, 1.0, limits.radius_m * 0.1, pins=pins)
    nat = profile_stats(natural, step)
    k = max(1, int(round(NATURAL_BASELINE_M / step)))
    if n > k:
        nat['local'] = float(np.max(np.abs(natural[k:] - natural[:-k])) / (k * step))

    def held(local: float, radius: float, overall: Optional[float]) -> np.ndarray:
        g = robust_fit(h, step, local, radius, pins=pins)
        if overall is not None and n >= 2:
            span = overall * step * (n - 1)
            if g.max() - g.min() > span * (1 + 1e-6):
                mid = 0.5 * (g.max() + g.min())
                g = robust_fit(h, step, local, radius, band=(mid - span / 2, mid + span / 2), pins=pins)
        return g

    meets = (nat['local'] <= limits.local * OK_TOLERANCE
             and (limits.overall is None or nat['overall'] <= limits.overall * OK_TOLERANCE))
    if not meets and not paved and limits in (RUNWAY_CODE_12, TAXIWAY_SMALL) \
            and nat['local'] <= limits.steep_cap:
        # The kind of strip that really is this steep: keep it.
        profile = held(max(limits.local, nat['local']), min(limits.radius_m, 2000.0), None)
        status = 'steep'
    else:
        profile = held(limits.local, limits.radius_m, limits.overall)
        status = 'ok' if meets else 'graded'
    diff = np.abs(profile - natural)[finite] if finite.any() else np.zeros(1)
    earthwork = float(np.max(diff)) if len(diff) else 0.0
    if status == 'graded' and earthwork > WARN_EARTHWORK_M:
        status = 'suspect'
    got = profile_stats(profile, step)
    return profile, {
        'status': status,
        'limits': limits.name,
        'naturalOverall': round(nat['overall'], 5),
        'naturalLocal': round(nat['local'], 5),
        'overall': round(got['overall'], 5),
        'local': round(got['local'], 5),
        'minRadiusM': round(got['minRadiusM'], 0) if math.isfinite(got['minRadiusM']) else None,
        'earthworkM': round(earthwork, 2),
        'measured': round(float(finite.mean()), 3) if n else 0.0,
    }


def fit_apron_plane(
    xs: np.ndarray, ys: np.ndarray, hs: np.ndarray, limit: float = APRON_GRADIENT_LIMIT,
) -> Optional[dict]:
    """``h = a + b x + c y`` through an apron's measured heights (x east, y
    north, metres about its centre), weighted down against the high tail,
    the gradient clamped to `limit` in any direction."""
    ok = np.isfinite(hs)
    if ok.sum() < 3:
        return None
    x, y, h = xs[ok], ys[ok], hs[ok]
    design = np.column_stack([np.ones_like(x), x, y])
    w = np.ones_like(h)
    coef = np.zeros(3)
    for _ in range(IRLS_PASSES + 1):
        sw = np.sqrt(w)
        coef, *_ = np.linalg.lstsq(design * sw[:, None], h * sw, rcond=None)
        r = h - design @ coef
        w = np.where(r > HIGH_TAIL_M, (HIGH_TAIL_M / np.maximum(r, 1e-9)) ** 2, 1.0)
    a, b, c = (float(v) for v in coef)
    grad = math.hypot(b, c)
    raw = grad
    if grad > limit:
        b, c = b * limit / grad, c * limit / grad
        grad = limit
        # The level re-solved against the gradient being used, as fit_plane
        # did, or the plane keeps the steep fit's level and sits off the ground.
        r0 = h - (b * x + c * y)
        a = float(np.average(r0, weights=w))
    residual = h - (a + b * x + c * y)
    return {
        'heightMsl': a,
        'gradient': grad,
        'gradientRaw': raw,
        'gradientHeadingDeg': math.degrees(math.atan2(b, c)) % 360.0 if grad > 0 else 0.0,
        'earthworkM': float(np.max(np.abs(residual))),
    }


def stations_along(length_m: float, step: float = PROFILE_STEP_M) -> np.ndarray:
    """Evenly spaced stations from 0 to `length_m`, ends included, no further
    apart than `step`."""
    n = max(2, int(math.ceil(length_m / step - 1e-9)) + 1)
    return np.linspace(0.0, length_m, n)


def resample(s_from: Sequence[float], h_from: Sequence[float], s_to: np.ndarray) -> np.ndarray:
    """Linear resample of a profile, held level past its ends."""
    return np.interp(s_to, np.asarray(s_from, dtype=np.float64), np.asarray(h_from, dtype=np.float64))
