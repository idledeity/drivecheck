from drives.drive_models import DriveAttachment, DriveDescriptor


def test_primary_descriptor_none_when_empty():
    assert DriveAttachment().primary_descriptor is None


def test_primary_descriptor_returns_active_index():
    d0 = DriveDescriptor(device_name="/dev/sda", access_type="scsi", info_name="/dev/sda")
    d1 = DriveDescriptor(device_name="/dev/bus/1", access_type="megaraid,0", info_name="/dev/bus/1")
    attachment = DriveAttachment(descriptors=[d0, d1], active_index=1)
    assert attachment.primary_descriptor is d1


def test_primary_descriptor_defaults_to_first():
    d0 = DriveDescriptor(device_name="/dev/sda", access_type="scsi", info_name="/dev/sda")
    attachment = DriveAttachment(descriptors=[d0])
    assert attachment.primary_descriptor is d0
