"""
clock.py — The one way drivecheck reads, stores and parses time: UTC.

Every timestamp is a timezone-aware UTC datetime in memory, and an ISO 8601
string with an explicit "+00:00" offset in the database and the API. Local
time is the browser's business, for display only. Wall-clock (naive local)
times jump an hour at each DST change, which skewed anything spaced in time:
chart buckets, ages, retention cutoffs.

Stored strings all come from iso() — one format, so they sort as text in the
same order as the times they name, which the SQL range filters rely on.

Some older values survive in naive local form (inside JSON blobs written
before the switch; the database's own columns were converted by migration).
parse() reads those as local time, as they were written, so they compare
correctly with everything else.
"""

from datetime import UTC, datetime


def now() -> datetime:
    """The current time, in UTC."""
    return datetime.now(UTC)


def iso(dt: datetime) -> str:
    """dt as a stored/served string: ISO 8601 in UTC, "+00:00" offset. A
    naive datetime is refused rather than guessed at — every time in the app
    should already be aware."""
    if dt.tzinfo is None:
        raise ValueError(f"naive datetime {dt!r}: use clock.now() / clock.parse() for aware times")
    return dt.astimezone(UTC).isoformat()


def now_iso() -> str:
    """The current time as a stored/served string."""
    return iso(now())


def parse(value: str) -> datetime:
    """A stored or received ISO string as an aware UTC datetime. One without
    an offset is a legacy naive local time, read as local."""
    dt = datetime.fromisoformat(value)
    return (dt if dt.tzinfo is not None else dt.astimezone()).astimezone(UTC)


def from_timestamp(ts: float) -> datetime:
    """A Unix timestamp as an aware UTC datetime."""
    return datetime.fromtimestamp(ts, UTC)
