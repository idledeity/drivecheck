"""
analysis.health.curves — Curves from a value to its standalone score, for
factor tests to build on.
"""

import math
from collections.abc import Callable

Curve = Callable[[float], float]


def log_curve(points: list[tuple[float, float]]) -> Curve:
    """A count's standalone score: 100 at 0, then linear in log10(count)
    between points, flat past the last. Counts where each tenfold matters
    about as much as the last (sectors, errors)."""
    def score(n: float) -> float:
        if n <= 0:
            return 100.0
        if n <= points[0][0]:
            return points[0][1]
        for (a, ha), (b, hb) in zip(points, points[1:]):
            if n <= b:
                return ha + (hb - ha) * (math.log10(n) - math.log10(a)) / (math.log10(b) - math.log10(a))
        return points[-1][1]
    return score


def linear_curve(points: list[tuple[float, float]]) -> Curve:
    """A value's standalone score, linear between points, flat outside them
    (hours, cycles, degrees)."""
    def score(x: float) -> float:
        if x <= points[0][0]:
            return points[0][1]
        for (a, ha), (b, hb) in zip(points, points[1:]):
            if x <= b:
                return ha + (hb - ha) * (x - a) / (b - a)
        return points[-1][1]
    return score


def first_where(curve: Curve, test: Callable[[float], bool], hi: int = 10**9) -> int | None:
    """The smallest whole value whose standalone score passes test (curves
    only fall, so once it passes it keeps passing), or None if none does."""
    if not test(curve(hi)):
        return None
    lo = 0
    while lo < hi:
        mid = (lo + hi) // 2
        if test(curve(mid)):
            hi = mid
        else:
            lo = mid + 1
    return lo
