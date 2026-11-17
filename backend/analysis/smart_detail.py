"""
analysis.smart_detail — The Health -> SMART page's view of one smartctl read.

Built when served from a stored raw snapshot's smartctl JSON (facts), so every
stored read gets it and every status reflects the current rules. Only what
smartctl reported is shown: no vitals, no values from other probes.

  groups          named fields, in the same groups for ATA, SAS and NVMe
  attributes      ATA: every SMART attribute, all columns
  scsi_error_counters  SAS: the read/write/verify error counter log
  nvme_health_log NVMe: every field of the SMART/Health Information log
  tables          further logs as generic tables (title, columns, rows with
                  a status): ATA device statistics and SATA PHY event
                  counters; SAS background scan results and phy counters
  raw_sections    bulky raw lists, each shown collapsed by the page (ATA log
                  directory, SCT temperature history), by JSON path
  other_fields    every other leaf value smartctl reported, by JSON path

Each value is judged on its own number: a field showing a DCSignals quantity
takes that signal's thresholds (analysis.health.SIGNAL_THRESHOLDS) applied to
the value shown, not the drive's current flag, so a status never comes from a
different read than its value.
"""

import logging
import re
from collections.abc import Iterable

from analysis.health import SIGNAL_THRESHOLDS
from analysis.severity import flag
from analysis.smart_attributes import METRIC_RULES

logger = logging.getLogger(__name__)

_RANK = {"ok": 0, "warn": 1, "crit": 2}

# smartctl bookkeeping, and the device path (the drive header shows it).
_META_KEYS = {"json_format_version", "smartctl", "local_time", "device"}

# Every group a field can go in, in display order.
_GROUPS = [
    ("status",       "Status"),
    ("lifetime",     "Lifetime & wear"),
    ("media",        "Media errors"),
    ("interface",    "Interface"),
    ("temperature",  "Temperature"),
    ("data",         "Data processed"),
    ("capabilities", "Capabilities"),
]


def build_smart_detail(smartctl: dict) -> dict:
    """The SMART page's structure for one stored smartctl -j read."""
    protocol = smartctl.get("device", {}).get("protocol")
    builder = _BUILDERS.get(protocol)
    if builder is None:
        logger.debug("no SMART detail builder for protocol %r", protocol)
        fields, extra, consumed = [], {}, set()
    else:
        fields, extra, consumed = builder(smartctl)

    by_group: dict[str, list[dict]] = {}
    for f in fields:
        by_group.setdefault(f.pop("_group"), []).append(f)
    groups = [{"key": key, "label": label, "fields": by_group[key]}
              for key, label in _GROUPS if key in by_group]

    # consumed holds top-level keys, or dotted paths within one (a value the
    # page shows from a section it doesn't otherwise list).
    skip = _META_KEYS | consumed
    other = [{"path": path, "value": value}
             for key in smartctl if key not in skip
             for path, value in _leaves(smartctl[key], key)
             if not _shown(path, consumed)]

    return {"protocol": protocol, "groups": groups, "tables": [], "raw_sections": [],
            **extra, "other_fields": other}


# ── fields ────────────────────────────────────────────────────────────────────

def _field(group: str, key: str, label: str, value, unit: str | None = None, *,
           status: str = "ok", source: str | None = None, detail: str | None = None,
           limit: dict | None = None, attribute_id: int | None = None) -> dict:
    """One named field. unit is how the frontend formats value: hours, minutes,
    seconds, ms, count, celsius, bytes, percent, or None for text/booleans.
    limit is a bound the drive reports for it: {value, kind: rated|trip|threshold}."""
    return {"_group": group, "key": key, "label": label, "value": value, "unit": unit,
            "status": status, "source": source, "detail": detail, "limit": limit,
            "attribute_id": attribute_id}


def _worst(*statuses: str) -> str:
    return max(statuses, key=_RANK.__getitem__, default="ok")


def _signal_status(signal: str | None, value) -> str:
    """The signal's thresholds applied to this value (not the drive's live flag)."""
    if signal is None or not isinstance(value, (int, float)) or isinstance(value, bool):
        return "ok"
    return flag(value, **SIGNAL_THRESHOLDS[signal])


def _metric_status(kind: str, measured, drive_threshold=None) -> str:
    if measured is None:
        return "ok"
    return METRIC_RULES[kind](measured, drive_threshold)


def _passed_status(passed) -> str:
    return "crit" if passed is False else "ok"


def _self_test_status(result: str | None, passed: bool | None, nonzero: bool = False) -> str:
    """As the self-test log judges an entry (smartctl_self_test_log): a failure
    is crit; an abort, interruption or other non-zero SCSI result is warn."""
    text = (result or "").lower()
    if passed is False or "fail" in text:
        return "crit"
    if "aborted" in text or "interrupted" in text or nonzero:
        return "warn"
    return "ok"


def _shown(path: str, consumed: set[str]) -> bool:
    """Whether path is, or lies under, a consumed path."""
    return any(path == c or path.startswith((f"{c}.", f"{c}[")) for c in consumed)


def _leaves(node, path: str) -> Iterable[tuple[str, object]]:
    """Every scalar under node, as (dotted.path[i], value)."""
    if isinstance(node, dict):
        for key, child in node.items():
            yield from _leaves(child, f"{path}.{key}")
    elif isinstance(node, list):
        for i, child in enumerate(node):
            yield from _leaves(child, f"{path}[{i}]")
    else:
        yield path, node


def _common_status_fields(data: dict) -> list[dict]:
    passed = data.get("smart_status", {}).get("passed")
    rows = []
    if passed is not None:
        rows.append(_field("status", "smart_status", "SMART overall", "PASSED" if passed else "FAILED",
                           status=_passed_status(passed), source="smart_status.passed"))
    support = data.get("smart_support", {})
    if support:
        rows.append(_field("capabilities", "smart_enabled", "SMART available / enabled",
                           f"{_yes_no(support.get('available'))} / {_yes_no(support.get('enabled'))}",
                           source="smart_support"))
    return rows


def _yes_no(value) -> str:
    return "—" if value is None else "yes" if value else "no"


def _table(key: str, title: str, columns: list[tuple[str, str, bool]], rows: list[dict],
           summarized_by: str | None = None) -> dict:
    """A generic table for the page. columns: (key, label, numeric). Each row
    is {"cells": {column key: value}, "status": ok|warn|crit}. summarized_by
    names the field that already counts its rows' problems, so a summary
    lists that field rather than the table."""
    return {"key": key, "title": title,
            "columns": [{"key": k, "label": label, "numeric": numeric} for k, label, numeric in columns],
            "rows": rows, "summarized_by": summarized_by}


def _row(status: str = "ok", **cells) -> dict:
    return {"cells": cells, "status": status}


def _raw_section(data: dict, key: str, label: str) -> dict | None:
    """A bulky raw list, kept out of other_fields; the page shows it collapsed."""
    if key not in data:
        return None
    return {"key": key, "label": label, "leaves": [{"path": p, "value": v} for p, v in _leaves(data[key], key)]}


# ── ATA ───────────────────────────────────────────────────────────────────────

# Attribute ID -> (group, key, label, unit, signal). Standard meanings that hold
# across vendors; anything else is only in the attribute table.
_ATA_NAMED: dict[int, tuple[str, str, str, str, str | None]] = {
    4:   ("lifetime",  "start_stop_count",      "Start/stop count",            "count", None),
    10:  ("lifetime",  "spin_retry_count",      "Spin retries",                "count", None),
    11:  ("lifetime",  "calibration_retries",   "Calibration retries",         "count", None),
    192: ("lifetime",  "power_off_retracts",    "Power-off retracts",          "count", None),
    193: ("lifetime",  "load_cycle_count",      "Load/unload cycles",          "count", "load_unload_cycles"),
    5:   ("media",     "reallocated_sectors",   "Reallocated sectors",         "count", "reallocated"),
    196: ("media",     "reallocation_events",   "Reallocation events",         "count", None),
    197: ("media",     "pending_sectors",       "Pending sectors",             "count", "pending"),
    198: ("media",     "offline_uncorrectable", "Offline uncorrectable",       "count", "uncorrected"),
    187: ("media",     "reported_uncorrect",    "Reported uncorrectable",      "count", None),
    183: ("media",     "runtime_bad_blocks",    "Runtime bad blocks",          "count", None),
    199: ("interface", "crc_errors",            "UDMA CRC errors",             "count", "crc_errors"),
    188: ("interface", "command_timeouts",      "Command timeouts",            "count", None),
    184: ("interface", "end_to_end_errors",     "End-to-end errors",           "count", None),
}

# Attribute ID -> its DCSignals field, for judging the table's raw values.
_ATA_SIGNALS = {9: "power_on_hours", 12: None, **{i: spec[4] for i, spec in _ATA_NAMED.items()}}

# Bytes per unit of 241/242, by the name smartctl's drive database gives them.
# Other names (e.g. Host_Writes_32MiB) count in other units; left raw.
_LBA_COUNTERS = {241: ("Total_LBAs_Written", "written"), 242: ("Total_LBAs_Read", "read")}

_MIN_MAX = re.compile(r"Min/Max\s+(-?\d+)/(-?\d+)")
_HOURS_PREFIX = re.compile(r"^(\d+)h")


def _ata_attribute_row(entry: dict) -> dict:
    """One attribute with every column smartctl gives, judged by the drive's
    own threshold, its when_failed, and (mapped IDs) the signal thresholds."""
    attr_id = entry.get("id")
    value, worst, thresh = entry.get("value"), entry.get("worst"), entry.get("thresh")
    raw = entry.get("raw", {})
    flags = entry.get("flags", {})
    when_failed = entry.get("when_failed") or None
    status = _worst(
        _metric_status("normalized_value", value, thresh),
        # Failing now is crit; failed once, in the past, warn.
        "crit" if when_failed == "now" else "warn" if when_failed else "ok",
        _signal_status(_ATA_SIGNALS.get(attr_id), raw.get("value")),
    )
    return {
        "id": attr_id,
        "name": entry.get("name"),
        "value": value,
        "worst": worst,
        "thresh": thresh,
        # How far the normalized value sits above the failure threshold; None
        # when the drive sets no threshold (0).
        "margin": value - thresh if value is not None and thresh else None,
        "type": "Pre-fail" if flags.get("prefailure") else "Old-age",
        "updated": "Always" if flags.get("updated_online") else "Offline",
        "flags": flags.get("string", "").strip() or None,
        "raw_value": raw.get("value"),
        "raw_string": raw.get("string"),
        "when_failed": when_failed,
        "status": status,
    }


def _ata(data: dict) -> tuple[list[dict], dict, set[str]]:
    table = data.get("ata_smart_attributes", {}).get("table", [])
    attributes = [_ata_attribute_row(e) for e in table]
    by_id = {a["id"]: a for a in attributes}
    fields = _common_status_fields(data)

    smart_data = data.get("ata_smart_data", {})
    self_test = smart_data.get("self_test", {}).get("status", {})
    if self_test:
        fields.append(_field("status", "self_test_status", "Last self-test", self_test.get("string"),
                             status=_self_test_status(self_test.get("string"), self_test.get("passed")),
                             source="ata_smart_data.self_test.status"))
    offline = smart_data.get("offline_data_collection", {}).get("status", {})
    if offline:
        fields.append(_field("status", "offline_collection", "Offline data collection", offline.get("string"),
                             source="ata_smart_data.offline_data_collection.status"))
    error_log = data.get("ata_smart_error_log", {})
    error_count = (error_log.get("extended") or error_log.get("summary") or {}).get("count")
    if error_count is not None:
        fields.append(_field("status", "error_log_count", "Error log entries", error_count, "count",
                             status=_metric_status("error_log_entries", error_count),
                             source="ata_smart_error_log"))

    def from_attr(group, key, label, value, unit, attr_id, signal=None, detail=None):
        attr = by_id.get(attr_id)
        status = _worst(_signal_status(signal, value), attr["status"] if attr else "ok")
        source = f"ATA {attr_id}" if attr else None
        return _field(group, key, label, value, unit, status=status, source=source,
                      detail=detail, attribute_id=attr_id if attr else None)

    # Power-on hours and power cycles: smartctl's decoded top-level values
    # (vendor raw formats differ), linked to their attribute for the columns.
    poh = data.get("power_on_time", {}).get("hours")
    if poh is not None:
        fields.append(from_attr("lifetime", "power_on_hours", "Power-on hours", poh, "hours", 9, "power_on_hours"))
    cycles = data.get("power_cycle_count")
    if cycles is not None:
        fields.append(from_attr("lifetime", "power_cycles", "Power cycles", cycles, "count", 12))

    for attr_id, (group, key, label, unit, signal) in _ATA_NAMED.items():
        attr = by_id.get(attr_id)
        if attr is not None:
            fields.append(from_attr(group, key, label, attr["raw_value"], unit, attr_id, signal))

    flying = by_id.get(240)
    if flying and flying["name"] == "Head_Flying_Hours":
        match = _HOURS_PREFIX.match(flying["raw_string"] or "")
        hours = int(match.group(1)) if match else flying["raw_value"]
        fields.append(from_attr("lifetime", "head_flying_hours", "Head flying hours", hours, "hours", 240))

    temp = data.get("temperature", {}).get("current")
    if temp is not None:
        temp_attr = 194 if 194 in by_id else 190 if 190 in by_id else None
        fields.append(from_attr("temperature", "temperature", "Current", temp, "celsius",
                                temp_attr, "temp"))
    for attr_id in (190, 194):
        attr = by_id.get(attr_id)
        match = attr and _MIN_MAX.search(attr["raw_string"] or "")
        if match:
            fields.append(from_attr("temperature", f"min_max_{attr_id}", "Min / max",
                                    f"{match.group(1)} / {match.group(2)}", "celsius", attr_id,
                                    detail="From the attribute's raw value; the period it covers is vendor-defined"))

    fields.extend(_ata_temperature_extremes(data.get("temperature", {})))
    fields.extend(_ata_settings(data))
    fields.extend(_device_statistic_fields(data.get("ata_device_statistics", {}).get("pages", [])))

    pending_defects = data.get("ata_pending_defects_log", {}).get("count")
    if pending_defects is not None:
        fields.append(_field("media", "pending_defects_log", "Pending defects (log)", pending_defects, "count",
                             status=_signal_status("pending", pending_defects), source="ata_pending_defects_log",
                             detail="The drive's list of sectors awaiting reallocation"))

    block = data.get("logical_block_size") or 512
    for attr_id, (name, direction) in _LBA_COUNTERS.items():
        attr = by_id.get(attr_id)
        if attr and attr["name"] == name and attr["raw_value"] is not None:
            fields.append(from_attr("data", f"total_{direction}", f"Total {direction}",
                                    attr["raw_value"] * block, "bytes", attr_id,
                                    detail=f"{attr['raw_value']:,} LBAs × {block} bytes"))

    polling = smart_data.get("self_test", {}).get("polling_minutes", {})
    for kind in ("short", "extended", "conveyance"):
        if polling.get(kind) is not None:
            fields.append(_field("capabilities", f"self_test_{kind}_minutes", f"{kind.capitalize()} self-test",
                                 polling[kind], "minutes", source="ata_smart_data.self_test.polling_minutes"))
    offline_secs = smart_data.get("offline_data_collection", {}).get("completion_seconds")
    if offline_secs is not None:
        fields.append(_field("capabilities", "offline_collection_seconds", "Offline data collection",
                             offline_secs, "seconds", source="ata_smart_data.offline_data_collection"))
    sct = data.get("ata_sct_capabilities", {})
    if "error_recovery_control_supported" in sct:
        fields.append(_field("capabilities", "sct_erc", "Error recovery control (SCT ERC)",
                             _yes_no(sct["error_recovery_control_supported"]), source="ata_sct_capabilities"))

    tables = []
    phy = data.get("sata_phy_event_counters", {}).get("table", [])
    if phy:
        by_phy_id = {c.get("id"): c for c in phy}
        icrc = by_phy_id.get(1)
        if icrc is not None and icrc.get("value") is not None:
            fields.append(_field("interface", "phy_icrc_errors", "ICRC errors (PHY)", icrc["value"], "count",
                                 status=_signal_status("crc_errors", icrc["value"]),
                                 source="sata_phy_event_counters", detail=icrc.get("name")))
        tables.append(_table("sata_phy_event_counters", "SATA PHY event counters",
                             [("id", "ID", True), ("name", "Counter", False), ("value", "Value", True),
                              ("overflow", "Overflow", False)],
                             [_row(id=c.get("id"), name=c.get("name"), value=c.get("value"),
                                   overflow=_yes_no(c.get("overflow"))) for c in phy]))

    stats = data.get("ata_device_statistics", {}).get("pages", [])
    if stats:
        tables.append(_table("ata_device_statistics", "Device statistics",
                             [("page", "Page", False), ("name", "Statistic", False), ("value", "Value", True),
                              ("flags", "Flags", False)],
                             [_device_statistic_row(page, entry)
                              for page in stats for entry in page.get("table", [])]))

    raw = [r for r in (_raw_section(data, "ata_log_directory", "Log directory"),
                       _raw_section(data, "ata_sct_temperature_history", "SCT temperature history"))
           if r is not None]

    consumed = {"smart_status", "smart_support", "temperature", "power_on_time",
                "power_cycle_count", "ata_smart_attributes", "ata_smart_self_test_log",
                "sata_phy_event_counters", "ata_device_statistics", "ata_log_directory",
                "ata_sct_temperature_history", "ata_pending_defects_log",
                "ata_security", "write_cache", "read_lookahead", "trim", "interface_speed",
                # Values shown above from sections not otherwise listed.
                "ata_smart_data.self_test.status", "ata_smart_data.self_test.polling_minutes",
                "ata_smart_data.offline_data_collection.status",
                "ata_smart_data.offline_data_collection.completion_seconds",
                "ata_sct_capabilities.error_recovery_control_supported",
                "ata_smart_error_log.extended.count", "ata_smart_error_log.summary.count"}
    # The selective self-test log only says something while a span is tested.
    selective = data.get("ata_smart_selective_self_test_log", {}).get("table", [])
    if selective and all(span.get("status", {}).get("value") == 0 for span in selective):
        consumed.add("ata_smart_selective_self_test_log")
    return fields, {"attributes": attributes, "tables": tables, "raw_sections": raw}, consumed


def _ata_temperature_extremes(temp: dict) -> list[dict]:
    """The ranges -x adds to temperature (from device statistics / SCT)."""
    fields = []
    for key, label, low, high in (
        ("temp_power_cycle", "This power cycle min / max", "power_cycle_min", "power_cycle_max"),
        ("temp_lifetime", "Lifetime min / max", "lifetime_min", "lifetime_max"),
        ("temp_op_limits", "Specified operating range", "op_limit_min", "op_limit_max"),
        ("temp_limits", "Specified limit range", "limit_min", "limit_max"),
    ):
        if temp.get(low) is not None and temp.get(high) is not None:
            # Not judged: one hot spell would flag the drive for life. Time
            # above limit (below) is the drive's own measure of that.
            fields.append(_field("temperature", key, label, f"{temp[low]} / {temp[high]}", "celsius",
                                 source=f"temperature.{low}"))
    over, under = temp.get("lifetime_over_limit_minutes"), temp.get("lifetime_under_limit_minutes")
    if over is not None:
        fields.append(_field("temperature", "temp_over_limit", "Time above limit", over, "minutes",
                             status="warn" if over > 0 else "ok", source="temperature.lifetime_over_limit_minutes"))
    if under is not None:
        fields.append(_field("temperature", "temp_under_limit", "Time below limit", under, "minutes",
                             source="temperature.lifetime_under_limit_minutes"))
    return fields


def _ata_settings(data: dict) -> list[dict]:
    """Drive settings worth knowing before a task: cache, TRIM, security
    (a frozen drive refuses secure erase), and the negotiated link speed."""
    fields = []
    for key, label, path in (("write_cache", "Write cache", "write_cache"),
                             ("read_lookahead", "Read lookahead", "read_lookahead")):
        enabled = data.get(path, {}).get("enabled")
        if enabled is not None:
            fields.append(_field("capabilities", key, label, "enabled" if enabled else "disabled",
                                 source=f"{path}.enabled"))
    trim = data.get("trim", {}).get("supported")
    if trim is not None:
        fields.append(_field("capabilities", "trim", "TRIM", "supported" if trim else "not supported",
                             source="trim.supported"))
    security = data.get("ata_security", {})
    if security.get("string"):
        frozen = security.get("frozen")
        fields.append(_field("capabilities", "ata_security", "Security", security["string"], source="ata_security",
                             detail="Frozen: secure erase is refused until the drive is power-cycled" if frozen else None))

    speed = data.get("interface_speed", {})
    current, maximum = speed.get("current", {}), speed.get("max", {})
    if current.get("string"):
        rate = lambda s: (s.get("units_per_second") or 0) * (s.get("bits_per_unit") or 0)
        slower = bool(maximum) and 0 < rate(current) < rate(maximum)
        fields.append(_field("interface", "link_speed", "Link speed", current["string"],
                             status="warn" if slower else "ok", source="interface_speed.current",
                             detail=(f"Below the drive's {maximum.get('string')}: check the cable, port or backplane"
                                     if slower else f"Drive supports {maximum['string']}" if maximum.get("string") else None)))
    return fields


# Device statistics shown as named fields: (statistic name, group, key, label, signal or judging).
_DEVICE_STATISTIC_FIELDS = [
    ("Number of Mechanical Start Failures",        "lifetime",  "mechanical_start_failures", "Mechanical start failures", "any"),
    ("Number of High Priority Unload Events",      "lifetime",  "emergency_unloads",         "Emergency head unloads",    None),
    ("Read Recovery Attempts",                     "media",     "read_recovery_attempts",    "Read recovery attempts",    None),
    ("Number of Realloc. Candidate Logical Sectors", "media",   "realloc_candidates",        "Reallocation candidates",   "pending"),
    ("Number of Hardware Resets",                  "interface", "hardware_resets",           "Hardware resets",           None),
    ("Number of ASR Events",                       "interface", "asr_events",                "Asynchronous signal recoveries", None),
]


def _device_statistic_fields(pages: list[dict]) -> list[dict]:
    """A few device statistics as named fields (all stay in the table too).
    "any" warns on one or more; a signal name applies that signal's thresholds."""
    by_name = {e.get("name"): e for page in pages for e in page.get("table", [])
               if e.get("flags", {}).get("valid", True)}
    fields = []
    for name, group, key, label, judge in _DEVICE_STATISTIC_FIELDS:
        entry = by_name.get(name)
        if entry is None or entry.get("value") is None:
            continue
        value = entry["value"]
        status = ("warn" if value > 0 else "ok") if judge == "any" else _signal_status(judge, value)
        if entry.get("flags", {}).get("monitored_condition_met"):
            status = _worst(status, "warn")
        fields.append(_field(group, key, label, value, "count", status=status,
                             source=f"ata_device_statistics: {name}"))
    return fields


def _device_statistic_row(page: dict, entry: dict) -> dict:
    """One device statistic. The drive itself marks one past its own threshold
    (monitored_condition_met): warn."""
    flags = entry.get("flags", {})
    return _row("warn" if flags.get("monitored_condition_met") else "ok",
                page=page.get("name"), name=entry.get("name"),
                value=entry.get("value") if flags.get("valid", True) else None,
                flags=(flags.get("string") or "").strip() or None)


# ── SCSI / SAS ────────────────────────────────────────────────────────────────

_SCSI_COUNTER_COLUMNS = [
    ("errors_corrected_by_eccfast",          "ECC fast"),
    ("errors_corrected_by_eccdelayed",       "ECC delayed"),
    ("errors_corrected_by_rereads_rewrites", "Rereads / rewrites"),
    ("total_errors_corrected",               "Total corrected"),
    ("correction_algorithm_invocations",     "Algorithm invocations"),
    ("gigabytes_processed",                  "GB processed"),
    ("total_uncorrected_errors",             "Uncorrected"),
]

_SCSI_PROCESSED_LABELS = {"read": "Total read", "write": "Total written", "verify": "Total verified"}


def _scsi(data: dict) -> tuple[list[dict], dict, set[str]]:
    fields = _common_status_fields(data)

    latest_test = data.get("scsi_self_test_0")
    if latest_test:
        result = latest_test.get("result", {})
        fields.append(_field("status", "self_test_status", "Last self-test",
                             f"{latest_test.get('code', {}).get('string')}: {result.get('string')}",
                             status=_self_test_status(result.get("string"), passed=None,
                                                      nonzero=bool(result.get("value"))),
                             source="scsi_self_test_0"))

    poh = data.get("power_on_time", {}).get("hours")
    if poh is not None:
        fields.append(_field("lifetime", "power_on_hours", "Power-on hours", poh, "hours",
                             status=_signal_status("power_on_hours", poh), source="power_on_time.hours"))

    cycles = data.get("scsi_start_stop_cycle_counter", {})
    for key, label, accumulated, specified, signal in (
        ("start_stop_cycles", "Start/stop cycles", "accumulated_start_stop_cycles",
         "specified_cycle_count_over_device_lifetime", None),
        ("load_unload_cycles", "Load/unload cycles", "accumulated_load_unload_cycles",
         "specified_load_unload_count_over_device_lifetime", "load_unload_cycles"),
    ):
        count, rated = cycles.get(accumulated), cycles.get(specified)
        if count is None:
            continue
        fields.append(_field(
            "lifetime", key, label, count, "count",
            status=_worst(_signal_status(signal, count), _metric_status("rated_lifetime", count, rated)),
            source=f"scsi_start_stop_cycle_counter.{accumulated}",
            detail=f"{count / rated * 100:.1f}% of rated lifetime" if rated else None,
            limit={"value": rated, "kind": "rated"} if rated else None,
        ))
    if cycles.get("year_of_manufacture"):
        fields.append(_field("lifetime", "manufactured", "Manufactured",
                             f"{cycles['year_of_manufacture']} week {cycles.get('week_of_manufacture', '?')}",
                             source="scsi_start_stop_cycle_counter"))

    defects = data.get("scsi_grown_defect_list")
    if defects is not None:
        fields.append(_field("media", "grown_defects", "Grown defect list", defects, "count",
                             status=_signal_status("reallocated", defects), source="scsi_grown_defect_list"))

    counters = data.get("scsi_error_counter_log", {})
    extra = {}
    if counters:
        directions = [d for d in ("read", "write", "verify") if d in counters]
        extra["scsi_error_counters"] = {
            "columns": [{"key": k, "label": label} for k, label in _SCSI_COUNTER_COLUMNS],
            "rows": [{"direction": d, **{k: _number(counters[d].get(k)) for k, _ in _SCSI_COUNTER_COLUMNS}}
                     for d in directions],
        }
        # The uncorrected signal counts read + write (smartctl_telemetry._map_scsi).
        read_u = counters.get("read", {}).get("total_uncorrected_errors")
        write_u = counters.get("write", {}).get("total_uncorrected_errors")
        if read_u is not None or write_u is not None:
            total = (read_u or 0) + (write_u or 0)
            fields.append(_field("media", "uncorrected_errors", "Uncorrected errors", total, "count",
                                 status=_signal_status("uncorrected", total),
                                 source="scsi_error_counter_log", detail=f"Read {read_u or 0} · Write {write_u or 0}"))
        verify_u = counters.get("verify", {}).get("total_uncorrected_errors")
        if verify_u is not None:
            fields.append(_field("media", "verify_uncorrected", "Uncorrected verify errors", verify_u, "count",
                                 source="scsi_error_counter_log.verify"))
        for d in directions:
            gb = _number(counters[d].get("gigabytes_processed"))
            if gb is not None:
                fields.append(_field("data", f"total_{d}", _SCSI_PROCESSED_LABELS[d], round(gb * 1e9), "bytes",
                                     source=f"scsi_error_counter_log.{d}.gigabytes_processed"))

    temp = data.get("temperature", {})
    if temp.get("current") is not None:
        trip = temp.get("drive_trip")
        fields.append(_field("temperature", "temperature", "Current", temp["current"], "celsius",
                             status=_signal_status("temp", temp["current"]), source="temperature.current",
                             limit={"value": trip, "kind": "trip"} if trip is not None else None))
    if "enabled" in data.get("temperature_warning", {}):
        fields.append(_field("capabilities", "temperature_warning", "Temperature warning",
                             "enabled" if data["temperature_warning"]["enabled"] else "disabled",
                             source="temperature_warning"))
    ext_secs = data.get("scsi_extended_self_test_seconds")
    if ext_secs is not None:
        fields.append(_field("capabilities", "self_test_extended_minutes", "Extended self-test",
                             round(ext_secs / 60), "minutes", source="scsi_extended_self_test_seconds"))

    fmt = data.get("scsi_format_status", {})
    if fmt:
        minutes = fmt.get("power_on_minutes_since_format")
        since = f"Formatted {minutes / 60:,.0f} power-on hours ago" if minutes is not None else None
        for key, label, path in (("grown_defects_during_cert", "Grown defects during certification", "grown_defects_during_cert"),
                                 ("blocks_reassigned_during_format", "Blocks reassigned during format",
                                  "blocks_reassigned_during_format")):
            if fmt.get(path) is not None:
                fields.append(_field("media", key, label, fmt[path], "count",
                                     source=f"scsi_format_status.{path}", detail=since))

    tables = []
    scan = data.get("scsi_background_scan")
    if scan:
        scan_fields, scan_table = _scsi_background_scan(scan)
        fields.extend(scan_fields)
        if scan_table:
            tables.append(scan_table)

    ports = sorted((k for k in data if re.fullmatch(r"scsi_sas_port_\d+", k)), key=lambda k: int(k.rsplit("_", 1)[1]))
    phy_rows = [_sas_phy_row(port, data[port][phy]) for port in ports
                for phy in data[port] if re.fullmatch(r"phy_\d+", phy)]
    if phy_rows:
        tables.append(_table("sas_phy_counters", "SAS phy error counters",
                             [("port", "Port", True), ("phy", "Phy", True), ("link_rate", "Link rate", False),
                              ("invalid_dwords", "Invalid dwords", True),
                              ("disparity_errors", "Disparity errors", True),
                              ("loss_of_sync", "Loss of sync", True),
                              ("phy_reset_problems", "Phy reset problems", True)],
                             phy_rows))
    extra["tables"] = tables

    consumed = {"smart_status", "smart_support", "temperature", "temperature_warning",
                "power_on_time", "scsi_start_stop_cycle_counter", "scsi_grown_defect_list",
                "scsi_error_counter_log", "scsi_extended_self_test_seconds", "scsi_background_scan",
                "scsi_format_status",
                *ports, *(k for k in data if k.startswith("scsi_self_test_"))}
    return fields, extra, consumed


# Background scan results' reassign_status value for a medium error the drive
# found but has not reassigned: it needs a write or REASSIGN BLOCKS (SBC).
_SCAN_UNREPAIRED = 1


def _scsi_background_scan(scan: dict) -> tuple[list[dict], dict | None]:
    """The SAS background scan log: its status, and the medium errors it found.
    One not yet reassigned is a pending sector by another name, so the count of
    those is judged by the pending signal's thresholds."""
    fields = []
    status = scan.get("status", {})
    if status:
        scans = status.get("number_scans_performed")
        fields.append(_field("status", "background_scan", "Background scan", status.get("string"),
                             source="scsi_background_scan.status",
                             detail=f"{scans:,} scans performed" if scans is not None else None))
    results = [v for k, v in scan.items() if k.startswith("result_")]
    if status or results:
        unrepaired = sum(1 for r in results if r.get("reassign_status", {}).get("value") == _SCAN_UNREPAIRED)
        fields.append(_field("media", "background_scan_errors", "Background scan medium errors", len(results),
                             "count", status=_signal_status("pending", unrepaired),
                             source="scsi_background_scan",
                             detail=f"{unrepaired:,} not reassigned" if results else None))
    if not results:
        return fields, None
    rows = []
    for r in results:
        minutes = r.get("accumulated_power_on", {}).get("minutes")
        reassign = r.get("reassign_status", {})
        asc, ascq = r.get("asc"), r.get("ascq")
        rows.append(_row(
            _signal_status("pending", 1) if reassign.get("value") == _SCAN_UNREPAIRED else "ok",
            number=r.get("parameter_code"), lba=r.get("lba"),
            power_on_hours=round(minutes / 60, 1) if minutes is not None else None,
            sense=r.get("sense_key", {}).get("string"),
            asc_ascq=f"0x{asc:02x}/0x{ascq:02x}" if asc is not None and ascq is not None else None,
            reassign=reassign.get("string"),
        ))
    table = _table("scsi_background_scan", "Background scan results",
                   [("number", "#", True), ("lba", "LBA", True), ("power_on_hours", "Power-on hours", True),
                    ("sense", "Sense", False), ("asc_ascq", "ASC/ASCQ", False), ("reassign", "Reassign status", False)],
                   rows, summarized_by="background_scan_errors")
    return fields, table


def _sas_phy_row(port: str, phy: dict) -> dict:
    return _row(port=int(port.rsplit("_", 1)[1]), phy=phy.get("identifier"),
                link_rate=phy.get("negotiated_logical_link_rate"),
                invalid_dwords=phy.get("invalid_dword_count"),
                disparity_errors=phy.get("running_disparity_error_count"),
                loss_of_sync=phy.get("loss_of_dword_synchronization_count"),
                phy_reset_problems=phy.get("phy_reset_problem_count"))


def _number(value):
    """smartctl gives some SCSI counters as decimal strings ("2526525.336")."""
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return None
    return value


# ── NVMe ──────────────────────────────────────────────────────────────────────
# Unit-test coverage only: no NVMe drive on the dev box (see smartctl_attributes).

_NVME_DATA_UNIT = 512_000  # bytes per "data unit" (1000 × 512)


def _nvme(data: dict) -> tuple[list[dict], dict, set[str]]:
    log = data.get("nvme_smart_health_information_log", {})
    fields = _common_status_fields(data)
    src = "nvme_smart_health_information_log"

    def add(group, key, label, value, unit, status="ok", **kw):
        if value is not None:
            fields.append(_field(group, key, label, value, unit, status=status, source=f"{src}.{key}", **kw))

    crit = log.get("critical_warning")
    if crit is not None:
        add("status", "critical_warning", "Critical warning", f"0x{crit:02x}", None,
            status="crit" if crit else "ok")
    add("status", "num_err_log_entries", "Error log entries", log.get("num_err_log_entries"), "count",
        status=_metric_status("error_log_entries", log.get("num_err_log_entries")))
    add("lifetime", "power_on_hours", "Power-on hours", log.get("power_on_hours"), "hours",
        status=_signal_status("power_on_hours", log.get("power_on_hours")))
    add("lifetime", "power_cycles", "Power cycles", log.get("power_cycles"), "count")
    add("lifetime", "unsafe_shutdowns", "Unsafe shutdowns", log.get("unsafe_shutdowns"), "count")
    add("lifetime", "percentage_used", "Percentage used", log.get("percentage_used"), "percent",
        status=_metric_status("percentage_used", log.get("percentage_used")))
    spare, spare_threshold = log.get("available_spare"), log.get("available_spare_threshold")
    add("lifetime", "available_spare", "Available spare", spare, "percent",
        status=_metric_status("available_spare", spare, spare_threshold),
        limit={"value": spare_threshold, "kind": "threshold"} if spare_threshold is not None else None)
    add("lifetime", "controller_busy_time", "Controller busy time", log.get("controller_busy_time"), "minutes")
    add("media", "media_errors", "Media errors", log.get("media_errors"), "count",
        status=_signal_status("uncorrected", log.get("media_errors")))
    temp = log.get("temperature")
    if temp is not None:
        add("temperature", "temperature", "Current", temp - 273, "celsius",
            status=_signal_status("temp", temp - 273))
    add("temperature", "warning_temp_time", "Time above warning temp", log.get("warning_temp_time"), "minutes")
    add("temperature", "critical_comp_time", "Time above critical temp", log.get("critical_comp_time"), "minutes")
    for direction in ("read", "written"):
        units = log.get(f"data_units_{direction}")
        if units is not None:
            add("data", f"data_units_{direction}", f"Total {direction}", units * _NVME_DATA_UNIT, "bytes",
                detail=f"{units:,} data units × 512,000 bytes")
    add("data", "host_reads", "Host read commands", log.get("host_reads"), "count")
    add("data", "host_writes", "Host write commands", log.get("host_writes"), "count")

    extra = {"nvme_health_log": [{"path": path.removeprefix(f"{src}."), "value": value}
                                 for path, value in _leaves(log, src)]} if log else {}
    consumed = {"smart_status", "smart_support", "nvme_smart_health_information_log",
                "temperature", "power_on_time", "power_cycle_count"}
    return fields, extra, consumed


_BUILDERS = {"ATA": _ata, "SCSI": _scsi, "NVMe": _nvme}
