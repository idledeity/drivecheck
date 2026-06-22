from analysis.descriptor_rank import score_descriptor
from drives.drive_models import DriveDescriptor, DriveTraits, DriveType


def _descriptor(access_type="scsi"):
    return DriveDescriptor(device_name="/dev/sda", access_type=access_type, info_name="/dev/sda")


def test_empty_traits_scores_lowest():
    score = score_descriptor(_descriptor(), DriveTraits())
    assert score == 1  # only the direct-access tiebreaker bonus


def test_full_traits_scores_higher():
    traits = DriveTraits(
        serial="SN1", model="ModelX", capacity_bytes=1000,
        form_factor="3.5 inches", rpm=7200, bus="SATA III",
        drive_type=DriveType.HDD,
    )
    score = score_descriptor(_descriptor(), traits)
    # 6 populated fields + 2 for a known drive_type + 1 direct-access bonus
    assert score == 9


def test_unknown_drive_type_does_not_get_type_bonus():
    traits = DriveTraits(drive_type=DriveType.UNKNOWN)
    score = score_descriptor(_descriptor(), traits)
    assert score == 1


def test_controller_access_type_loses_tiebreaker_bonus():
    direct_score = score_descriptor(_descriptor("scsi"), DriveTraits())
    megaraid_score = score_descriptor(_descriptor("megaraid,0"), DriveTraits())
    cciss_score = score_descriptor(_descriptor("cciss,0"), DriveTraits())
    assert direct_score == 1
    assert megaraid_score == 0
    assert cciss_score == 0


def test_richer_data_outweighs_tiebreaker_penalty():
    direct = score_descriptor(_descriptor("scsi"), DriveTraits())
    megaraid_with_traits = score_descriptor(
        _descriptor("megaraid,0"),
        DriveTraits(serial="SN1", model="ModelX", drive_type=DriveType.HDD),
    )
    assert megaraid_with_traits > direct
