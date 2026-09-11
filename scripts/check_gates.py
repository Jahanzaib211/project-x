#!/usr/bin/env python3
"""Enforce the gate rule across the dependency graph.

THE RULE
    A module may not be promoted past a gate if any module it depends on,
    transitively, has not itself passed every gate that dependency declares.

Gate results are read from gates/status.yaml, which CI writes as each module's
gates pass. A module with no recorded status is treated as having passed nothing.

Usage:
    check_gates.py                 # report readiness for every module
    check_gates.py <module-id>     # is this one module allowed to proceed?
    check_gates.py --strict        # exit non-zero if any module is blocked
"""
from __future__ import annotations

import pathlib
import sys

import yaml

from _registry import ROOT, load_registry, modules_by_id, transitive_deps

STATUS_FILE = ROOT / "gates" / "status.yaml"


def load_status() -> dict[str, list[str]]:
    if not STATUS_FILE.exists():
        return {}
    doc = yaml.safe_load(STATUS_FILE.read_text()) or {}
    return {k: list(v or []) for k, v in (doc.get("passed") or {}).items()}


def blockers(mods: dict, status: dict[str, list[str]], mid: str) -> list[str]:
    out: list[str] = []
    for dep in sorted(transitive_deps(mods, mid)):
        required = mods[dep].get("required_gates") or []
        passed = set(status.get(dep, []))
        missing = [g for g in required if g not in passed]
        if missing:
            out.append(f"{dep} has not passed {', '.join(missing)}")
    return out


def main(argv: list[str]) -> int:
    strict = "--strict" in argv
    targets = [a for a in argv if not a.startswith("-")]

    registry = load_registry()
    mods = modules_by_id(registry)
    status = load_status()

    if targets:
        unknown = [t for t in targets if t not in mods]
        if unknown:
            print(f"unknown module(s): {', '.join(unknown)}", file=sys.stderr)
            return 2
        selected = targets
    else:
        selected = list(mods)

    any_blocked = False
    for mid in selected:
        b = blockers(mods, status, mid)
        own_required = mods[mid].get("required_gates") or []
        own_passed = set(status.get(mid, []))
        own_missing = [g for g in own_required if g not in own_passed]

        if b:
            any_blocked = True
            print(f"BLOCKED  {mid}")
            for line in b:
                print(f"         upstream: {line}")
        elif own_missing:
            print(f"READY    {mid}  (own gates outstanding: {', '.join(own_missing)})")
        else:
            print(f"GREEN    {mid}")

    if strict and any_blocked:
        print("\nOne or more modules are blocked by upstream gates.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
