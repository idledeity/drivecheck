import threading

from drives.tools.timeout import ProbeTimeout, get_timeout


def test_get_timeout_unset_returns_none():
    assert get_timeout() is None


def test_probe_timeout_sets_and_restores():
    assert get_timeout() is None
    with ProbeTimeout(30):
        assert get_timeout() == 30
    assert get_timeout() is None


def test_probe_timeout_nesting_restores_outer_value():
    with ProbeTimeout(30):
        with ProbeTimeout(5):
            assert get_timeout() == 5
        assert get_timeout() == 30
    assert get_timeout() is None


def test_probe_timeout_is_thread_local():
    results = {}

    def worker():
        results["before"] = get_timeout()
        with ProbeTimeout(10):
            results["inside"] = get_timeout()

    with ProbeTimeout(99):
        thread = threading.Thread(target=worker)
        thread.start()
        thread.join()
        assert get_timeout() == 99  # unaffected by the other thread

    assert results["before"] is None
    assert results["inside"] == 10
