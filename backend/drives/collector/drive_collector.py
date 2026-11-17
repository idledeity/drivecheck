"""
drive_collector.py — Drive collector.

Discovers drives via the scan probe, runs traits and telemetry probes for
each, and maintains a live registry of DriveState objects keyed by GUID.

The collector runs a background daemon thread that wakes every _TICK_INTERVAL
seconds and checks, per drive, whether each channel ("telemetry", "snapshot",
"vitals") is due. Each channel has its own interval (config.yaml: collector.poll_intervals)
and drives are staggered evenly across each interval via a phase derived from
the drive's position in the sorted GUID list — see _compute_next_due. Drive
discovery (scan + reconciliation) runs on its own, non-staggered interval
(collector.scan_interval).

SMART reads are kept rare on purpose: on a drive whose heads have parked
(Seagate Exos parks after ~2 min idle) every smartctl command except -i loads
them again — one load/unload cycle per read, whatever the read asks for. So:
  - "vitals" (10 s) never touches SMART where hwmon has the temperature: sysfs
    I/O counters, hwmon, mounts.
  - "telemetry" is the attribute read (smartctl -A -H, the probes'
    run_attributes): due every poll_intervals.telemetry, but it only runs once
    vitals has seen the drive do I/O within collector.smart_activity_window,
    i.e. while its heads are loaded and the read is free. An idle drive's read
    stays pending until it is busy again, or a full read covers it.
  - "snapshot" is the full read (smartctl -a), saved as a raw snapshot, on a
    fixed interval whatever the drive is doing; with jobs' before/after
    captures and the Probe button, it is the only read that can wake a drive.
  - After a restart each drive's latest saved snapshot is its live state, so
    a restart doesn't read every drive again.

GUIDs are derived from the drive's serial number (uuid5), so they are stable
across reboots even if device paths change. Drives with no serial fall back
to the device name as the key.

Discovery is split from steady-state polling:
  - New descriptors (not seen before) go through _discover(), which runs traits
    on all candidates, groups by GUID, scores by data completeness, and picks
    the best access path. All paths are stored in DriveState.attachment.descriptors.
  - Known descriptors (already in attachment.descriptors of an existing state)
    have their serial re-read to confirm the same drive is still there. A
    different serial means a swap: the path is detached and rediscovered.
  - A failed scan (a scan probe raising or returning None) skips reconciliation,
    so it can't be mistaken for every drive having been removed.
  - Gone drives (GUIDs absent from the scan) are removed from the registry.
"""

import importlib
import json
import logging
import math
import threading
import time
import uuid
from concurrent.futures import Future, ThreadPoolExecutor, wait
from dataclasses import asdict, fields, replace
from datetime import datetime

from settings import cfg
from database import db
from analysis.descriptor_rank import score_descriptor
from analysis.health import score_health
from drives.tools.timeout import ProbeTimeout
from drives.drive_models import (
    DCSignals, DriveContext, DriveDescriptor, DriveSnapshot, DriveState, DriveTelemetry, DriveTraits, DriveVitals,
)
from drives.collector.probes.vitals.block_device import run as resolve_block_device
from drives.collector import probe_registry

logger = logging.getLogger(__name__)

_GUID_NAMESPACE = uuid.UUID("d1a3ec4f-8b2a-4c5e-9f7d-6e8a2b1c3d4e")

# How often the background loop wakes to check for due channels.
_TICK_INTERVAL = 1.0

# How often to check whether history pruning is due.
_PRUNE_INTERVAL = 86400

# How often finished minutes of raw vitals are rolled up into drive_vitals_rollup.
_ROLLUP_INTERVAL = 60
# A minute is rolled up only once this long has passed since it ended, so a
# vitals row that is still being recorded when the minute ends isn't left out.
_ROLLUP_GRACE = 60



def _floor_to_half_hour(dt: datetime) -> datetime:
    return dt.replace(minute=dt.minute - dt.minute % 30, second=0, microsecond=0)


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

cfg.register("collector.scan_interval",
    default=300, type="int", label="Scan interval",
    section="Collector", description="Seconds between drive scans.",
    min=10, max=3600, restart_required=True,
)
cfg.register("collector.keep_history_days",
    default=90, type="int", label="History retention",
    section="Collector", description="Days of time-series history to retain before pruning.",
    min=1, max=3650, restart_required=True,
)
cfg.register("collector.keep_raw_vitals_days",
    default=2, type="int", label="Raw vitals retention",
    section="Collector",
    description="Days to keep every individual vitals reading. History charts use per-minute "
                "averages, which are kept for the full history retention.",
    min=1, max=3650, restart_required=True,
)
cfg.register("collector.keep_job_snapshots",
    default=True, type="bool", label="Keep job SMART snapshots",
    section="Collector",
    description="Keep the full SMART reports taken before and after each job past the history "
                "retention window. Off: they are pruned with the rest of the history (the job keeps "
                "its condensed before/after values either way).",
    restart_required=False,
)
cfg.register("collector.max_workers",
    default=4, type="int", label="Worker threads",
    section="Collector", description="Thread pool size for per-drive channel polling.",
    min=1, max=64, restart_required=True,
)
cfg.register("collector.probe_timeout",
    default=30, type="int", label="Probe timeout",
    section="Collector", description="Subprocess timeout (seconds) for probe calls (e.g. smartctl).",
    min=1, max=600, restart_required=True,
)
cfg.register("collector.poll_intervals.telemetry",
    default=1800, type="int", label="Attribute read interval",
    section="Collector",
    description="Seconds between SMART attribute reads (smartctl -A). A read only runs while the "
                "drive is busy (see the activity window), so it never wakes an idle drive.",
    min=1, max=86400, restart_required=True,
)
cfg.register("collector.poll_intervals.snapshot",
    default=21600, type="int", label="Full SMART read interval",
    section="Collector",
    description="Seconds between full SMART reads (smartctl -a, with the self-test and error logs), "
                "each saved as a snapshot. Runs even on an idle drive, which on drives that park their "
                "heads costs one load/unload cycle.",
    min=60, max=604800, restart_required=True,
)
cfg.register("collector.smart_activity_window",
    default=60, type="int", label="Activity window",
    section="Collector",
    description="An attribute read only runs if the drive did I/O within this many seconds, while its "
                "heads are still loaded. 0 reads on schedule even when the drive is idle.",
    min=0, max=3600, restart_required=True,
)
cfg.register("collector.poll_intervals.vitals",
    default=10, type="int", label="Vitals interval",
    section="Collector", description="Seconds between cheap temperature + disk IO activity reads.",
    min=1, max=86400, restart_required=True,
)
cfg.register("collector.poll_intervals.traits",
    default=86400, type="int", label="Traits interval",
    section="Collector", description="Seconds between traits probe re-runs for already-known drives.",
    min=1, max=2592000, restart_required=True,
)
cfg.register("collector.scan_probes",
    default=["drives.collector.probes.scan.smartctl_scan"], type="module_list", label="Scan probes",
    section="Collector", description="Dotted-path probe modules run to discover attached drives.",
    restart_required=True,
)
cfg.register("collector.traits_probes",
    default=["drives.collector.probes.traits.smartctl_traits"], type="module_list", label="Traits probes",
    section="Collector", description="Dotted-path probe modules run to populate drive traits.",
    restart_required=True,
)
cfg.register("collector.telemetry_probes",
    default=["drives.collector.probes.telemetry.smartctl_telemetry"], type="module_list", label="Telemetry probes",
    section="Collector", description="Dotted-path probe modules run each telemetry poll, chained in order.",
    restart_required=True,
)
cfg.register("collector.vitals_probes",
    default=[
        "drives.collector.probes.vitals.hwmon_temp",
        "drives.collector.probes.vitals.smartctl_vitals",
        "drives.collector.probes.vitals.sysfs_io",
        "drives.collector.probes.vitals.mount_status",
    ], type="module_list", label="Vitals probes",
    section="Collector", description="Dotted-path probe modules run each vitals poll, chained in order.",
    restart_required=True,
)


def _assign_guid(traits: DriveTraits, descriptor: DriveDescriptor) -> str:
    """Return a stable GUID for a drive, keyed on serial number if available."""
    key = traits.serial or descriptor.device_name
    return str(uuid.uuid5(_GUID_NAMESPACE, key))


def _merge_traits(base: DriveTraits, overlay: DriveTraits) -> DriveTraits:
    """Merge overlay onto base, overlay's non-None fields taking precedence.

    Used to combine results from multiple traits probes — last probe with a
    non-None value for a field wins, matching the "last probe has final
    authority" rule used for telemetry/vitals chains.
    """
    updates = {f.name: getattr(overlay, f.name) for f in fields(overlay) if getattr(overlay, f.name) is not None}
    return replace(base, **updates)


class Collector:
    def __init__(
        self,
        scan_interval: int,
        poll_intervals: dict[str, int],
        scan_probes: list[str],
        traits_probes: list[str],
        telemetry_probes: list[str],
        vitals_probes: list[str],
        keep_history_days: int,
        max_workers: int,
        probe_timeout: int,
        keep_raw_vitals_days: int | None = None,
        activity_window: int = 0,
    ):
        self._scan_interval = scan_interval
        self._poll_intervals = poll_intervals  # {"telemetry": ..., "snapshot": ...}
        scan = probe_registry.load_probes(scan_probes, "scan")
        traits = probe_registry.load_probes(traits_probes, "traits")
        telemetry = probe_registry.load_probes(telemetry_probes, "telemetry")
        vitals = probe_registry.load_probes(vitals_probes, "vitals")
        self._scan_probes = scan.modules
        self._traits_probes = traits.modules
        self._telemetry_probes = telemetry.modules
        self._vitals_probes = vitals.modules
        # Keyed by the same cfg key the module_list prop itself uses, so the
        # frontend can match a warning back to the row it came from.
        self.probe_warnings: dict[str, list[dict[str, str]]] = {
            probe_registry.probe_key(loaded.category): loaded.warnings
            for loaded in (scan, traits, telemetry, vitals)
        }
        self._keep_history_days = keep_history_days
        # None: raw vitals follow keep_history_days.
        self._keep_raw_vitals_days = keep_raw_vitals_days
        self._probe_timeout = probe_timeout
        # 0: attribute reads run on schedule, busy or not (see _is_busy).
        self._activity_window = activity_window
        # When vitals last saw each drive do I/O (epoch seconds; 0 = not since
        # start-up). A drive vitals can't measure I/O on is absent.
        self._last_io_at: dict[str, float] = {}
        self._drive_states: dict[str, DriveState] = {}
        # Latest saved raw snapshot summary per drive (scheduled or forced), so a
        # job can reuse a recent one instead of forcing a poll (see capture_smart).
        self._latest_snapshots: dict[str, dict] = {}
        self._phase_fractions: dict[str, float] = {}
        self._scan_due: float = time.time()
        # Initialized lazily on the first tick, from db.get_last_pruned_at() — db.init()
        # hasn't necessarily run yet at construction time.
        self._prune_due: float | None = None
        # Start of the next minute of raw vitals to roll up, as an ISO string;
        # None until the first rollup tick reads it from the database.
        self._rollup_from: str | None = None
        self._rollup_due: float = time.time()
        # Per-drive, per-channel ("telemetry", "snapshot", "vitals") next-due times,
        # epoch seconds. Collector-internal scheduling state, not part of DriveState.
        self._schedules: dict[str, dict[str, float]] = {}
        self._lock = threading.Lock()
        self._poll_lock = threading.Lock()
        self._thread = threading.Thread(target=self._loop, daemon=True, name="collector")
        self._stop_event = threading.Event()
        self._scanned = threading.Event()
        self._executor = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="collector-poll")
        # (guid, channel) -> Future for work currently running on the executor,
        # guarded by self._lock.
        self._inflight: dict[tuple[str, str], Future] = {}

    @classmethod
    def from_config(cls) -> "Collector":
        """Construct a Collector from the registered collector.* cfg values.

        All of these are restart_required — there's no live on_changed path,
        so reading them once here at startup is sufficient.
        """
        return cls(
            scan_interval=cfg.get("collector.scan_interval"),
            poll_intervals={
                "telemetry": cfg.get("collector.poll_intervals.telemetry"),
                "snapshot": cfg.get("collector.poll_intervals.snapshot"),
                "vitals": cfg.get("collector.poll_intervals.vitals"),
                "traits": cfg.get("collector.poll_intervals.traits"),
            },
            scan_probes=cfg.get("collector.scan_probes"),
            traits_probes=cfg.get("collector.traits_probes"),
            telemetry_probes=cfg.get("collector.telemetry_probes"),
            vitals_probes=cfg.get("collector.vitals_probes"),
            keep_history_days=cfg.get("collector.keep_history_days"),
            keep_raw_vitals_days=cfg.get("collector.keep_raw_vitals_days"),
            max_workers=cfg.get("collector.max_workers"),
            probe_timeout=cfg.get("collector.probe_timeout"),
            activity_window=cfg.get("collector.smart_activity_window"),
        )

    def start(self) -> None:
        """Start the background poll loop."""
        logger.info("starting collector poll loop")
        self._thread.start()

    def stop(self) -> None:
        """Signal the background loop to stop and shut down the executor."""
        logger.info("stopping collector poll loop")
        self._stop_event.set()
        self._thread.join(timeout=5)
        self._executor.shutdown(wait=False)

    def wait_for_scan(self) -> None:
        """Block until the first drive scan has completed.

        A no-op after the first scan — the underlying Event stays set, so later
        calls return immediately.
        """
        self._scanned.wait()

    def get_drive_states(self) -> list[DriveState]:
        """Return a snapshot of all current drive states."""
        with self._lock:
            return list(self._drive_states.values())

    def get_drive_context(self, guid: str) -> DriveContext | None:
        """Return the current DriveContext for a drive, or None if unknown."""
        with self._lock:
            state = self._drive_states.get(guid)
            return state.context if state else None

    def capture_smart(self, guid: str, max_age_seconds: float = 0) -> dict | None:
        """Return a SMART snapshot summary for a drive, for recording on a job.

        Reuses the drive's latest saved snapshot if it is at most max_age_seconds
        old (e.g. the previous queued job's "after"); otherwise forces a telemetry
        poll — the same path as a scheduled one, so it also lands in the signal
        history and refreshes the live state — and saves its raw report.

        Returns {snapshot_id, captured_at, signals, reused}, where snapshot_id
        references the full report in drive_raw_snapshots. Facts only: flags and
        health are derived from signals when served (app._with_judgements). Returns
        None if the drive is unknown. A failed poll comes back as
        {"captured_at", "error"} rather than raising, so a failed capture never
        fails the job it belongs to.
        """
        with self._lock:
            state = self._drive_states.get(guid)
            latest = self._latest_snapshots.get(guid)
        if state is None:
            logger.debug("capture_smart: unknown drive %s", guid)
            return None
        if max_age_seconds > 0 and latest is not None:
            age = datetime.now() - datetime.fromisoformat(latest["captured_at"])
            if age.total_seconds() <= max_age_seconds:
                logger.debug("capture_smart: reusing snapshot %s for %s (%.0fs old)",
                             latest["snapshot_id"], guid, age.total_seconds())
                return {**latest, "reused": True}
        try:
            with ProbeTimeout(self._probe_timeout):
                snapshot = self._run_telemetry(state, time.time())
            summary = self._save_snapshot(state, snapshot)
        except Exception as e:
            logger.warning("SMART capture for %s failed: %s", state.context.descriptor.info_name, e)
            return {"captured_at": datetime.now().isoformat(), "error": str(e) or type(e).__name__}
        return {**summary, "reused": False}

    def last_full_read_at(self, guid: str) -> str | None:
        """When the drive's latest saved full SMART read was taken (ISO), or None."""
        with self._lock:
            latest = self._latest_snapshots.get(guid)
        return latest["captured_at"] if latest else None

    def set_drive_label(self, guid: str, label: str | None) -> bool:
        """Update a drive's user-assigned label. Returns False if the drive is unknown."""
        with self._lock:
            state = self._drive_states.get(guid)
            if state is None:
                logger.debug("set_drive_label: unknown drive %s", guid)
                return False
            state.label = label
        db.set_drive_label(guid, label)
        return True

    def set_drive_locked(self, guid: str, locked: bool) -> bool:
        """Update a drive's locked state. Returns False if the drive is unknown."""
        with self._lock:
            state = self._drive_states.get(guid)
            if state is None:
                logger.debug("set_drive_locked: unknown drive %s", guid)
                return False
            state.locked = locked
        db.set_drive_locked(guid, locked)
        return True

    def is_drive_locked(self, guid: str) -> bool | None:
        """Return the locked state for a drive, or None if the drive is unknown."""
        with self._lock:
            state = self._drive_states.get(guid)
            return state.locked if state else None

    def trigger_poll(self, guids: list[str] | None = None) -> bool:
        """Force an immediate full SMART read (and saved snapshot), blocking
        until complete. Someone asked for it, so it runs on idle drives too.

        If guids is given, only those drives' snapshot channels are marked
        due, and False is returned if any guid is unknown. If guids is None,
        all known drives are refreshed.
        """
        now = time.time()
        with self._lock:
            known = set(self._drive_states.keys())
        if guids is not None:
            if not set(guids) <= known:
                logger.debug("trigger_poll: unknown guid(s) in %s", guids)
                return False
            target = guids
        else:
            target = list(known)
        logger.info("triggering immediate full SMART read for %d drive(s)", len(target))
        for g in target:
            sched = self._schedules.get(g)
            if sched:
                sched["snapshot"] = now
        wait(self._tick())
        return True

    def trigger_scan(self) -> None:
        """Force an immediate drive scan, blocking until complete."""
        logger.info("triggering immediate drive scan")
        self._scan_due = 0
        wait(self._tick())

    def _loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                self._tick()
            except Exception as e:
                logger.error("tick failed: %s", e, exc_info=True)
            self._stop_event.wait(_TICK_INTERVAL)

    def _tick(self) -> list[Future]:
        with self._poll_lock:
            return self._do_tick()

    def _do_tick(self) -> list[Future]:
        now = time.time()

        if now >= self._scan_due:
            with ProbeTimeout(self._probe_timeout):
                scanned = self._run_scan(now)
            self._scan_due = now + self._scan_interval
            self._scanned.set()
            if scanned:
                with self._lock:
                    n = len(self._drive_states)
                logger.info("scan complete: %d drive(s)", n)

        if self._prune_due is None:
            last_pruned_at = db.get_last_pruned_at()
            self._prune_due = (
                datetime.fromisoformat(last_pruned_at).timestamp() + _PRUNE_INTERVAL
                if last_pruned_at is not None
                else now + _PRUNE_INTERVAL
            )

        if now >= self._prune_due:
            cutoff = datetime.fromtimestamp(now - self._keep_history_days * 86400).isoformat()
            raw_vitals_cutoff = (
                datetime.fromtimestamp(now - self._keep_raw_vitals_days * 86400).isoformat()
                if self._keep_raw_vitals_days is not None else None
            )
            db.prune_history(
                cutoff,
                keep_job_snapshots=cfg.get("collector.keep_job_snapshots"),
                raw_vitals_cutoff_iso=raw_vitals_cutoff,
            )
            db.set_last_pruned_at(datetime.fromtimestamp(now).isoformat())
            self._prune_due = now + _PRUNE_INTERVAL

        if now >= self._rollup_due:
            self._rollup_vitals(now)
            self._rollup_due = now + _ROLLUP_INTERVAL

        with self._lock:
            active_states = list(self._drive_states.values())

        futures: list[Future] = []
        for state in active_states:
            for channel in ("telemetry", "snapshot", "vitals", "traits"):
                future = self._maybe_run_channel(state, channel, now)
                if future is not None:
                    futures.append(future)
        return futures

    def _maybe_run_channel(self, state: DriveState, channel: str, now: float) -> Future | None:
        """Submit a drive's channel for execution if due, or return its in-flight future.

        If the channel is already running (from a previous tick that hasn't
        finished yet), returns that future rather than skipping silently — so
        callers like trigger_poll() that wait on the returned futures still
        block until in-flight work completes, even if they didn't submit it.

        The next phase-staggered due time is computed and stored immediately on
        submission, independent of how long the probe takes to run — so a slow
        or hung probe doesn't throw off the schedule for subsequent ticks.
        """
        guid = state.context.guid
        sched = self._schedules[guid]
        key = (guid, channel)
        with self._lock:
            existing = self._inflight.get(key)
            if existing is not None:
                return existing
            if now < sched[channel]:
                return None
            # Left due, not rescheduled: it runs on the first tick the drive is busy.
            if channel == "telemetry" and not self._is_busy(guid, now):
                return None
            sched[channel] = self._compute_next_due(guid, channel, now)
            future = self._executor.submit(self._run_channel_safe, state, channel, now)
            self._inflight[key] = future
            return future

    def _is_busy(self, guid: str, now: float) -> bool:
        """Whether an attribute read now is free: the drive did I/O within the
        activity window, so its heads are loaded. A drive vitals can't measure
        I/O on (no block device) counts as busy: nothing says it is idle, and
        those are read for temperature every vitals tick anyway. Caller holds
        self._lock."""
        if self._activity_window <= 0:
            return True
        last = self._last_io_at.get(guid)
        return last is None or now - last <= self._activity_window

    def _run_channel_safe(self, state: DriveState, channel: str, now: float) -> None:
        """Run a channel's probe(s), isolating errors so one drive can't disrupt others."""
        guid = state.context.guid
        logger.debug("running %s channel for %s", channel, guid)
        try:
            with ProbeTimeout(self._probe_timeout):
                if channel == "telemetry":
                    self._run_telemetry(state, now, full=False)
                elif channel == "snapshot":
                    self._run_snapshot(state, now)
                elif channel == "vitals":
                    self._run_vitals(state, now)
                elif channel == "traits":
                    self._run_traits(state, now)
        except Exception as e:
            logger.error("%s channel failed for %s: %s", channel, guid, e, exc_info=True)
        finally:
            with self._lock:
                self._inflight.pop((guid, channel), None)

    def _compute_next_due(self, guid: str, channel: str, now: float) -> float:
        """
        Return the next due time for a drive's channel on a phase-staggered grid.

        Each drive has a phase fraction (its index in the sorted GUID list, divided
        by drive count) so drives spread evenly across the interval instead of
        clumping. If the next natural slot is less than half an interval away
        (e.g. right after a forced refresh), skip to the following slot — this is
        the only debounce needed; there's no separate cooldown state.
        """
        interval = self._poll_intervals[channel]
        phase = self._phase_fractions.get(guid, 0.0) * interval
        k = math.floor((now - phase) / interval) + 1
        next_due = phase + k * interval
        if next_due - now < 0.5 * interval:
            next_due += interval
        return next_due

    def _recompute_phase_fractions(self) -> None:
        """Recompute each drive's phase fraction from its position in the sorted GUID list."""
        with self._lock:
            guids = sorted(self._drive_states.keys())
        n = len(guids)
        self._phase_fractions = {guid: i / n for i, guid in enumerate(guids)} if n else {}

    def _run_scan(self, now: float) -> bool:
        """Run the scan probes and reconcile the registry against what they found.

        A probe that raises or returns None failed to scan, which is not the same
        as finding no drives: reconciliation is skipped for this tick so the
        registry stays as it was. Returns whether the scan succeeded.
        """
        descriptors = []
        for probe in self._scan_probes:
            try:
                found = probe.run()
            except Exception as e:
                logger.warning("scan probe %s failed, keeping the current drive list: %s", probe.__name__, e)
                return False
            if found is None:
                logger.warning("scan probe %s failed, keeping the current drive list", probe.__name__)
                return False
            descriptors.extend(found)
        self._reconcile_descriptors(descriptors, now)
        return True

    def _run_telemetry(self, state: DriveState, now: float, full: bool = True) -> DriveSnapshot:
        """Run the telemetry probe chain for a drive, score its health, and record
        signals + heartbeat.

        full=False is the attribute read: each probe's run_attributes() where it
        has one (a probe without one does its full run()). The extras it leaves
        out (the self-test log, the raw report) are kept from the last full read.
        A full read also puts off the next scheduled reads of both kinds, since it
        just did their work (e.g. a job's after-snapshot).
        """
        snapshot = DriveSnapshot()
        for probe in self._telemetry_probes:
            run = probe.run if full else getattr(probe, "run_attributes", probe.run)
            snapshot = run(snapshot, state.context)
        # Scored here, after the whole chain, not by a probe: probes report facts,
        # and the last probe has final authority over every signal health is judged on.
        snapshot.health = score_health(snapshot.telemetry.signals, snapshot.extras)
        guid = state.context.guid
        with self._lock:
            if not full:
                snapshot.extras = {**state.snapshot.extras, **snapshot.extras}
                # A signal this read's output lacks (one only the full read's
                # logs give) stays as last read, rather than going unknown
                # until the next full read.
                previous = state.snapshot.telemetry.signals
                missing = {f.name: getattr(previous, f.name) for f in fields(DCSignals)
                           if getattr(snapshot.telemetry.signals, f.name) is None}
                snapshot.telemetry.signals = replace(snapshot.telemetry.signals, **missing)
                snapshot.health = score_health(snapshot.telemetry.signals, snapshot.extras)
            state.snapshot = snapshot
            sched = self._schedules.get(guid)
            if sched is not None:
                for channel in ("telemetry", "snapshot") if full else ("telemetry",):
                    sched[channel] = max(sched[channel], self._compute_next_due(guid, channel, now))

        captured_at = snapshot.telemetry.last_polled_at.isoformat()
        db.record_signals(state.context.guid, captured_at, asdict(snapshot.telemetry.signals))
        db.record_heartbeat(state.context.guid, captured_at, snapshot.telemetry.signals.temp)
        return snapshot

    def _run_snapshot(self, state: DriveState, now: float) -> None:
        """Take a full SMART read and save it as the drive's latest snapshot."""
        self._save_snapshot(state, self._run_telemetry(state, now, full=True))

    def _save_snapshot(self, state: DriveState, snapshot: DriveSnapshot) -> dict:
        """Persist a telemetry run's raw report and remember it as the drive's
        latest snapshot (see capture_smart). Returns its summary."""
        captured_at = snapshot.telemetry.last_polled_at.isoformat()
        # The signals ride along so the report can be judged on its own when
        # served (analysis.smart_attributes.judge_report) — facts, not judgements.
        report = {**snapshot.extras, "signals": asdict(snapshot.telemetry.signals)}
        snapshot_id = db.record_raw_snapshot(
            state.context.guid, captured_at, "smartctl_telemetry", json.dumps(report)
        )
        summary = {
            "snapshot_id": snapshot_id,
            "captured_at": captured_at,
            "signals": asdict(snapshot.telemetry.signals),
        }
        with self._lock:
            self._latest_snapshots[state.context.guid] = summary
        return summary

    def _run_traits_chain(self, descriptor: DriveDescriptor, base: DriveTraits) -> DriveTraits:
        """Run the traits probe chain against descriptor, merging results onto base.

        If traits_probes lists more than one, each runs independently and results
        are merged field-by-field — last probe's non-None value wins for each field.
        """
        traits = base
        for probe in self._traits_probes:
            traits = _merge_traits(traits, probe.run(descriptor))
        return traits

    def _run_traits(self, state: DriveState, now: float) -> None:
        """Re-run the traits probe chain for an already-known drive and refresh its identity fields.

        Merges onto the drive's existing traits rather than a blank DriveTraits,
        so a probe that transiently returns None for a field (e.g. a momentary
        smartctl failure) doesn't wipe out previously known identity info.
        """
        descriptor = state.attachment.primary_descriptor
        traits = self._run_traits_chain(descriptor, state.traits)

        with self._lock:
            state.traits = traits
            state.context.traits = traits

        db.upsert_drive_record(
            guid=state.context.guid,
            serial=traits.serial,
            model=traits.model,
            capacity_bytes=traits.capacity_bytes,
            drive_type=traits.drive_type.value if traits.drive_type else None,
            first_seen=datetime.now().isoformat(),
        )

    def _rollup_vitals(self, now: float) -> None:
        """Roll every finished minute of raw vitals not yet rolled up into
        drive_vitals_rollup, then the half-hours they fall in into
        drive_vitals_rollup_30m. The first call after start-up continues from the
        newest rolled-up minute — or, on a database with no rollup yet, rolls up
        all raw vitals still kept."""
        end = datetime.fromtimestamp(now - _ROLLUP_GRACE).replace(second=0, microsecond=0).isoformat()
        if self._rollup_from is None:
            last = db.get_last_vitals_rollup_at()
            # Re-roll the newest minute: it may have been rolled from part of
            # its samples before a restart.
            self._rollup_from = last or ""
        if self._rollup_from >= end:
            return
        written = db.rollup_vitals(end, start_iso=self._rollup_from or None)
        logger.debug("rolled up %d vitals minute(s) from %s to %s", written, self._rollup_from or "the start", end)
        # Re-roll each half-hour those minutes fall in, from all of its minutes
        # so far — the current half-hour is replaced again on each roll.
        half_hour = (
            _floor_to_half_hour(datetime.fromisoformat(self._rollup_from)).isoformat()
            if self._rollup_from else None
        )
        db.rollup_vitals_30m(end, start_iso=half_hour)
        self._rollup_from = end

    def _run_vitals(self, state: DriveState, now: float) -> None:
        """Run the vitals probe chain for a drive and record a vitals row."""
        vitals = DriveVitals(captured_at=datetime.now())
        for probe in self._vitals_probes:
            vitals = probe.run(vitals, state)

        with self._lock:
            state.vitals = vitals
            io = vitals.io
            # No rates (no block device, or the first reading) says nothing either way.
            if io.read_iops is not None and io.write_iops is not None:
                busy = io.read_iops > 0 or io.write_iops > 0
                self._last_io_at[state.context.guid] = (
                    vitals.captured_at.timestamp() if busy else self._last_io_at.get(state.context.guid, 0.0)
                )

        db.record_vitals(state.context.guid, vitals.captured_at.isoformat(), vitals.temp, vitals.temp_source, vitals.io)

    def _reconcile_descriptors(self, descriptors: list[DriveDescriptor], now: float) -> None:
        """Partition scan results into known/unknown, discover new drives, and remove gone ones.

        A known access path is only trusted after its serial is re-read: a
        different drive hot-swapped into the same bay shows up at the same
        (device_name, access_type), and must not inherit the old drive's GUID,
        label, lock or history. A mismatch detaches the path from the old drive
        and sends it through discovery like any new one.
        """
        with self._lock:
            known_keys: dict[tuple[str, str], DriveState] = {
                (d.device_name, d.access_type): state
                for state in self._drive_states.values()
                for d in state.attachment.descriptors
            }

        matched_guids: set[str] = set()
        unknown: list[tuple[DriveDescriptor, DriveTraits]] = []

        for d in descriptors:
            state = known_keys.get((d.device_name, d.access_type))
            if state is None:
                unknown.append((d, self._run_traits_chain(d, DriveTraits())))
                continue
            traits = self._reread_traits(d)
            # No serial back (a failed read, or a drive that never reports one)
            # can't prove a swap, so the path stays with the drive it belongs to.
            if traits is None or traits.serial is None or traits.serial == state.traits.serial:
                matched_guids.add(state.context.guid)
                continue
            logger.warning(
                "serial on %s (%s) changed from %s to %s: treating it as a different drive",
                d.device_name, d.access_type, state.traits.serial or "none", traits.serial,
            )
            self._detach_descriptor(state, d)
            unknown.append((d, traits))

        if unknown:
            logger.debug("reconcile: %d unknown descriptor(s) to discover", len(unknown))
            self._discover(unknown, matched_guids, now)

        self._remove_gone_drives(matched_guids)
        self._refresh_block_devices()
        self._recompute_phase_fractions()

    def _refresh_block_devices(self) -> None:
        """Re-resolve every drive's block device by serial.

        The kernel name can change while smartctl's path doesn't (a replug
        behind a MegaRAID HBA, an NVMe controller reset), and destructive
        operations target the block device, so it can't be resolved only once.
        """
        with self._lock:
            states = list(self._drive_states.values())
        for state in states:
            block_device = resolve_block_device(state.traits.serial)
            with self._lock:
                if block_device != state.context.block_device:
                    logger.info("block device for %s changed: %s -> %s",
                                state.traits.serial, state.context.block_device, block_device)
                state.context.block_device = block_device

    def _reread_traits(self, descriptor: DriveDescriptor) -> DriveTraits | None:
        """Re-run the traits chain for a known path, or None if a probe raised."""
        try:
            return self._run_traits_chain(descriptor, DriveTraits())
        except Exception as e:
            logger.warning("could not re-read traits on %s, assuming the same drive: %s", descriptor.device_name, e)
            return None

    def _detach_descriptor(self, state: DriveState, descriptor: DriveDescriptor) -> None:
        """Remove an access path that now leads to a different drive from state."""
        key = (descriptor.device_name, descriptor.access_type)
        with self._lock:
            state.attachment.descriptors = [
                d for d in state.attachment.descriptors if (d.device_name, d.access_type) != key
            ]
            state.attachment.active_index = 0
            self._sync_primary(state)

    def _sync_primary(self, state: DriveState) -> None:
        """Point context.descriptor at the attachment's active path and re-resolve
        the block device, after a drive's paths changed. Caller holds self._lock.

        With no paths left the context keeps its last descriptor: the drive is
        about to be removed as absent from the scan.
        """
        primary = state.attachment.primary_descriptor
        if primary is None:
            return
        state.context.descriptor = primary
        state.context.block_device = resolve_block_device(state.traits.serial)

    def _discover(
        self,
        candidates: list[tuple[DriveDescriptor, DriveTraits]],
        matched_guids: set[str],
        now: float,
    ) -> None:
        """Deduplicate probed descriptors by GUID and create/update states."""
        probed = [(d, traits, _assign_guid(traits, d)) for d, traits in candidates]

        # Group by GUID — multiple descriptors may resolve to the same physical drive
        groups: dict[str, list[tuple[DriveDescriptor, DriveTraits]]] = {}
        for d, traits, guid in probed:
            groups.setdefault(guid, []).append((d, traits))

        for guid, group in groups.items():
            group.sort(key=lambda dt: score_descriptor(dt[0], dt[1]), reverse=True)
            best_descriptor, best_traits = group[0]
            all_descriptors = [d for d, _ in group]
            self._register_drive(guid, best_descriptor, best_traits, all_descriptors, matched_guids, now)

    def _register_drive(
        self,
        guid: str,
        best_descriptor: DriveDescriptor,
        best_traits: DriveTraits,
        all_descriptors: list[DriveDescriptor],
        matched_guids: set[str],
        now: float,
    ) -> None:
        """Create a new DriveState or append newly discovered paths to an existing one."""
        with self._lock:
            if guid in self._drive_states:
                logger.info(
                    "additional access path discovered for known drive %s: %s (%s)",
                    guid, best_descriptor.device_name, best_descriptor.access_type,
                )
                self._append_descriptors(self._drive_states[guid], all_descriptors)
            else:
                logger.info(
                    "drive discovered: %s %s (%s)",
                    best_traits.model or "unknown model",
                    best_traits.serial or "no serial",
                    best_descriptor.device_name,
                )
                context = DriveContext(guid=guid, descriptor=best_descriptor, traits=best_traits)
                state = DriveState(context=context)
                state.traits = best_traits
                state.attachment.descriptors = all_descriptors
                state.attachment.active_index = 0
                state.context.block_device = resolve_block_device(best_traits.serial)
                record = db.get_drive_record(guid)
                state.label = record["label"] if record else None
                state.locked = bool(record["locked"]) if record else False
                state.first_seen = record["first_seen"] if record else None
                self._drive_states[guid] = state
                restored_at = self._restore_snapshot(state)
                # Traits were just populated by discovery, so their first refresh is a
                # full interval out. A drive with no saved snapshot gets its first
                # full read in this same tick. One with a saved snapshot (a restart)
                # carries on from it: no read until its full one falls due, and the
                # first attribute read waits for a slot, by which time vitals know
                # whether the drive is busy.
                self._schedules[guid] = {
                    "telemetry": self._compute_next_due(guid, "telemetry", now),
                    "snapshot": now if restored_at is None
                                else max(now, restored_at + self._poll_intervals["snapshot"]),
                    "vitals": now,
                    "traits": self._compute_next_due(guid, "traits", now),
                }
        matched_guids.add(guid)

        db.upsert_drive_record(
            guid=guid,
            serial=best_traits.serial,
            model=best_traits.model,
            capacity_bytes=best_traits.capacity_bytes,
            drive_type=best_traits.drive_type.value if best_traits.drive_type else None,
            first_seen=datetime.now().isoformat(),
        )

    def _restore_snapshot(self, state: DriveState) -> float | None:
        """Make the drive's latest saved snapshot its live state and its latest
        snapshot for reuse (capture_smart). Returns when it was taken (epoch
        seconds), or None if it has none, or none that can be read back. Caller
        holds self._lock."""
        guid = state.context.guid
        row = db.get_latest_raw_snapshot(guid)
        if row is None:
            return None
        try:
            report = json.loads(row["raw_json"])
            if not isinstance(report.get("signals"), dict):
                raise ValueError("it has no signals")
            # Only the fields DCSignals has now: a snapshot from an older version
            # may lack some (left None) or have some since dropped.
            known = {f.name for f in fields(DCSignals)}
            signals = DCSignals(**{k: v for k, v in report["signals"].items() if k in known})
            captured_at = datetime.fromisoformat(row["captured_at"])
        except (ValueError, TypeError) as e:
            logger.warning("couldn't restore the saved snapshot for %s, reading it again: %s", guid, e)
            return None
        snapshot = DriveSnapshot(
            telemetry=DriveTelemetry(signals=signals, last_polled_at=captured_at),
            extras={k: v for k, v in report.items() if k != "signals"},
        )
        snapshot.health = score_health(signals, snapshot.extras)
        state.snapshot = snapshot
        self._latest_snapshots[guid] = {
            "snapshot_id": row["id"], "captured_at": row["captured_at"], "signals": asdict(signals),
        }
        logger.debug("restored %s from its snapshot of %s", guid, row["captured_at"])
        return captured_at.timestamp()

    def _append_descriptors(self, state: DriveState, descriptors: list[DriveDescriptor]) -> None:
        """Add any descriptors not already recorded to a drive's attachment."""
        had_paths = bool(state.attachment.descriptors)
        existing = {(d.device_name, d.access_type) for d in state.attachment.descriptors}
        for d in descriptors:
            if (d.device_name, d.access_type) not in existing:
                state.attachment.descriptors.append(d)
        # A drive that just lost all its paths (e.g. moved to another bay in the
        # same scan) needs its context and block device pointed at the new one.
        if not had_paths:
            state.attachment.active_index = 0
            self._sync_primary(state)

    def _remove_gone_drives(self, matched_guids: set[str]) -> None:
        """Remove drives from the registry that were absent from the latest scan."""
        with self._lock:
            gone = [g for g in self._drive_states if g not in matched_guids]
            for g in gone:
                state = self._drive_states[g]
                logger.info(
                    "drive removed: %s %s (%s)",
                    state.traits.model or "unknown model",
                    state.traits.serial or "no serial",
                    state.context.descriptor.device_name,
                )
                del self._drive_states[g]
                self._schedules.pop(g, None)
                self._last_io_at.pop(g, None)
