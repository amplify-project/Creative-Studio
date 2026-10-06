"""The shared-state store: which changes are accepted, and in what order.

Production runs WITHOUT jsonpatch — it is not in shareState/requirements.txt
and the image installs with --no-deps — so the built-in fallback is the path
that matters. Every behaviour test runs against both.
"""
import asyncio

import pytest

import state_store
from state_store import StateStore, VersionError

WHO = {"identity": "host-1", "role": "host"}


@pytest.fixture(params=["fallback (production)", "jsonpatch"])
def store(request, monkeypatch):
    if request.param == "jsonpatch":
        pytest.importorskip("jsonpatch")
    else:
        monkeypatch.setattr(state_store, "jsonpatch", None)
    return StateStore()


def apply(store, ops, base=None):
    base = store.state["version"] if base is None else base
    return asyncio.run(store.apply_patch(ops, base, WHO))


def test_starts_at_version_zero_with_a_grid_layout():
    s = StateStore()
    assert s.state["version"] == 0
    assert s.state["ui"]["layout"] == "grid"


def test_a_change_bumps_the_version_and_records_who(store):
    entry = apply(store, [{"op": "replace", "path": "/ui/layout", "value": "pin"}])
    assert store.state["ui"]["layout"] == "pin"
    assert store.state["version"] == 1
    assert store.state["meta"]["updatedBy"] == "host-1"
    assert (entry["fromVersion"], entry["toVersion"]) == (0, 1)


def test_a_change_based_on_a_stale_version_is_refused(store):
    apply(store, [{"op": "replace", "path": "/ui/layout", "value": "pin"}])
    with pytest.raises(VersionError) as err:
        apply(store, [{"op": "replace", "path": "/ui/layout", "value": "grid"}], base=0)
    assert err.value.current == 1
    assert store.state["ui"]["layout"] == "pin"  # the refused change left no trace
    assert store.state["version"] == 1


def test_removing_something_already_gone_is_not_an_error(store):
    # Two clients removing the same stage entity must not fail the second.
    apply(store, [{"op": "add", "path": "/entities/TR_1", "value": {"kind": "track"}}])
    apply(store, [{"op": "remove", "path": "/entities/TR_1"}])
    apply(store, [{"op": "remove", "path": "/entities/TR_1"}])
    assert "TR_1" not in store.state["entities"]
    assert store.state["version"] == 3


def test_several_ops_apply_together(store):
    apply(store, [
        {"op": "add", "path": "/entities/TR_1", "value": {"kind": "track", "visible": True}},
        {"op": "replace", "path": "/ui/layout", "value": "pin"},
        {"op": "add", "path": "/ui/pinnedVideo", "value": "TR_1"},
    ])
    assert store.state["ui"]["pinnedVideo"] == "TR_1"
    assert store.state["entities"]["TR_1"]["visible"] is True
    assert store.state["version"] == 1


def test_a_snapshot_is_a_copy():
    s = StateStore()
    snap = s.snapshot()
    snap["ui"]["layout"] = "changed"
    assert s.state["ui"]["layout"] == "grid"


def test_fallback_refuses_ops_it_does_not_implement(monkeypatch):
    monkeypatch.setattr(state_store, "jsonpatch", None)
    s = StateStore()
    with pytest.raises(ValueError):
        apply(s, [{"op": "move", "from": "/ui/layout", "path": "/ui/x"}])
    assert s.state["version"] == 0
