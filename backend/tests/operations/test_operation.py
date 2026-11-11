from operations.operation import OperationBase, OperationProgress


class _MinimalOperation(OperationBase):
    name = "Minimal"
    category = "Test"
    tool = "none"

    @staticmethod
    def supports(_context):
        return True

    def run(self, _context, _params):
        return {}


def test_default_progress_hooks_return_none():
    op = _MinimalOperation()
    assert op.get_progress() == OperationProgress(percent=None, message=None, eta_seconds=None)


def test_get_progress_assembles_from_overridden_hooks():
    class _ReportingOperation(_MinimalOperation):
        def get_percent(self):
            return 42.0

        def get_message(self):
            return "Halfway there"

        def get_eta_seconds(self):
            return 17.0

    progress = _ReportingOperation().get_progress()
    assert progress == OperationProgress(percent=42.0, message="Halfway there", eta_seconds=17.0)


def test_default_cancel_is_a_noop():
    op = _MinimalOperation()
    op.cancel()  # must not raise


# ---------------------------------------------------------------------------
# validate_params
# ---------------------------------------------------------------------------

import pytest  # noqa: E402

from operations.operation import ParamError, ParamSpec, validate_params  # noqa: E402
from operations.operation_registry import OPERATIONS, discover  # noqa: E402

_SPECS = [
    ParamSpec(name="passes", label="Passes", type="number", default=1, min=1, max=7),
    ParamSpec(name="zero_fill", label="Zero fill", type="boolean", default=True),
    ParamSpec(name="note", label="Note", type="string", default=""),
]


def test_validate_params_merges_defaults_and_coerces_integral_floats():
    assert validate_params(_SPECS, {"passes": 3.0}) == {"passes": 3, "zero_fill": True, "note": ""}


@pytest.mark.parametrize("params, field, message", [
    ({"passes": 8}, "passes", "at most 7"),
    ({"passes": 0}, "passes", "at least 1"),
    ({"passes": 1.5}, "passes", "whole number"),
    ({"passes": "3"}, "passes", "whole number"),
    ({"passes": True}, "passes", "whole number"),
    ({"zero_fill": 1}, "zero_fill", "true or false"),
    ({"note": 5}, "note", "text"),
    ({"passes; rm -rf /": 1}, "passes; rm -rf /", "unknown"),
])
def test_validate_params_rejects(params, field, message):
    with pytest.raises(ParamError) as exc:
        validate_params(_SPECS, params)
    assert exc.value.field == field
    assert message in exc.value.message


def test_every_operation_accepts_its_own_defaults():
    discover()
    for key, op_cls in OPERATIONS.items():
        defaults = {p.name: p.default for p in op_cls.params}
        assert validate_params(op_cls.params, {}) == defaults, key


def test_every_operation_param_has_a_tooltip():
    discover()
    missing = [f"{key}.{p.name}" for key, op_cls in OPERATIONS.items() for p in op_cls.params if not p.tooltip]
    assert missing == []
