#!/usr/bin/env python3
"""Validate the module dependency graph.

Fails the build when:
  - a module depends on something that does not exist
  - the graph contains a cycle (it must be a DAG)
  - a module depends on itself
  - a declared tier is unknown
  - a declared gate is unknown
  - a module's required gates are not a prefix-consistent set (no holes below G4)
"""
from __future__ import annotations

import sys

from _registry import gate_order, load_gates, load_registry, modules_by_id, topo_sort

NON_WAIVABLE_DEFAULT = ["G0", "G1", "G2", "G4"]


def main() -> int:
    registry = load_registry()
    gates_doc = load_gates()
    mods = modules_by_id(registry)
    known_gates = set(gate_order(gates_doc))
    known_tiers = set(registry["tiers"])
    non_waivable = gates_doc.get("non_waivable", NON_WAIVABLE_DEFAULT)

    errors: list[str] = []

    if len(mods) != len(registry["modules"]):
        errors.append("duplicate module id in registry")

    for mid, m in mods.items():
        deps = m.get("depends_on") or []
        if mid in deps:
            errors.append(f"{mid}: depends on itself")
        for dep in deps:
            if dep not in mods:
                errors.append(f"{mid}: depends on unknown module '{dep}'")
        if m.get("tier") not in known_tiers:
            errors.append(f"{mid}: unknown tier '{m.get('tier')}'")
        req = m.get("required_gates") or []
        for g in req:
            if g not in known_gates:
                errors.append(f"{mid}: declares unknown gate '{g}'")
        missing = [g for g in non_waivable if g not in req]
        if missing:
            errors.append(f"{mid}: omits non-waivable gate(s) {', '.join(missing)}")
        # A module that states a law must run that law in CI.
        if (m.get("invariants") or []) and "G4" not in req:
            errors.append(f"{mid}: declares invariants but does not require G4")
        # A module that publishes an SLO must have that SLO defended.
        if m.get("slo") and "G9" not in req:
            errors.append(f"{mid}: declares an SLO but does not require G9")

    try:
        order = topo_sort(mods)
    except ValueError as exc:
        errors.append(str(exc))
        order = []

    if errors:
        print("DAG CHECK FAILED", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 1

    print(f"DAG OK — {len(mods)} modules, acyclic.")
    print("Build order:")
    for i, mid in enumerate(order, 1):
        m = mods[mid]
        print(f"  {i:2d}. {mid:<20} [{m['tier']}] {m['name']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
