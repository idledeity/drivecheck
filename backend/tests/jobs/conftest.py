"""
Fixtures for the job registry tests. Autouse: they only touch the database,
JobRegistry and job_registry's own OPERATIONS binding, so other tests in this
folder are unaffected.
"""

import pytest

from database import db
from jobs import job_registry as job_registry_module
from jobs.job_registry import JobRegistry
from job_fakes import ControllableOperation


@pytest.fixture(autouse=True)
def _init_db(isolated_data_dir):
    db.init()


@pytest.fixture(autouse=True)
def _reset_fake_operation():
    ControllableOperation.reset()
    yield
    ControllableOperation.reset()


@pytest.fixture(autouse=True)
def _wait_for_job_threads(_reset_fake_operation, monkeypatch):
    """Don't let a job thread outlive its test.

    A job thread sets its in-memory status before it saves its final row, so a
    test that waits on job.status can end while that save is still pending —
    and once isolated_data_dir is undone, the save would land outside the
    test's own database. At teardown, release every fake operation and wait
    for each registry's threads. Depends on _reset_fake_operation so it tears
    down first, while the operation instances are still listed.
    """
    registries = []
    original_init = JobRegistry.__init__

    def tracking_init(self, *args, **kwargs):
        original_init(self, *args, **kwargs)
        registries.append(self)

    monkeypatch.setattr(JobRegistry, "__init__", tracking_init)
    yield
    for op in ControllableOperation.instances:
        op.release()
    for registry in registries:
        registry._executor.shutdown(wait=True)


@pytest.fixture(autouse=True)
def _fake_operations_registry(monkeypatch):
    """create_jobs() reads job_registry's own OPERATIONS binding — patch that
    name directly rather than operations.operation_registry.OPERATIONS, since
    the two would otherwise be the same shared dict object."""
    monkeypatch.setattr(job_registry_module, "OPERATIONS", {"controllable": ControllableOperation})
