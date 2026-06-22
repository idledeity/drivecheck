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
