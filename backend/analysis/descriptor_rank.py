"""
analysis.path_rank — Score and rank DriveDescriptor candidates.

When multiple descriptors resolve to the same physical drive (e.g. a direct
path and a megaraid passthrough), score_descriptor picks the best access path
by traits completeness, with controller-specific types as a tiebreaker penalty.
"""

from drive_models import DriveDescriptor, DriveTraits, DriveType

_CONTROLLER_ACCESS_TYPES = ("megaraid", "cciss")


def score_descriptor(descriptor: DriveDescriptor, traits: DriveTraits) -> int:
    """Score an access path by traits completeness. Higher = better."""
    score = sum(1 for v in [
        traits.serial, traits.model, traits.capacity_bytes,
        traits.form_factor, traits.rpm, traits.bus,
    ] if v is not None)
    if traits.drive_type and traits.drive_type != DriveType.UNKNOWN:
        score += 2
    # Tiebreaker: prefer direct access over controller-specific passthrough.
    # When data quality is equal (HBA mode), this picks the simpler path.
    # When a RAID controller is required, it returns richer data and wins on
    # score before this tiebreaker applies.
    if not any(ct in descriptor.access_type for ct in _CONTROLLER_ACCESS_TYPES):
        score += 1
    return score
