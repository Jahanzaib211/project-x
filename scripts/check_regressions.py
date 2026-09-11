#!/usr/bin/env python3
"""Regression ratchet — the repository's memory.

A codebase stays consistent only if it cannot quietly lose what it has already
proven. This check compares the current tree against a committed baseline and
fails when anything moves backwards:

  1. An invariant disappears.          A law may not be dropped silently.
  2. A module drops a required gate.   Proof obligations only ratchet up.
  3. A module's status regresses.      done -> planned needs a reason.
  4. A module disappears.              The graph does not shrink by accident.
  5. Test count falls.                 Deleting tests to go green is a regression.
  6. A dependency edge vanishes.       The DAG's shape is reviewed, not drifted.

None of these are forbidden — they are *deliberate*. Making one requires
updating the baseline in the same PR (`make baseline`), which puts the change in
the diff where a reviewer sees it, instead of in a test run nobody reads.

Usage:
    check_regressions.py            # fail on any regression
    check_regressions.py --update   # accept the current tree as the new baseline
"""
from __future__ import annotations

import json
import re
import subprocess
import sys

from _registry import ROOT, load_registry, modules_by_id

BASELINE = ROOT / "gates" / "baseline.json"
STATUS_RANK = {"planned": 0, "in-progress": 1, "done": 2, "deprecated": -1}
INV_PATTERN = re.compile(r"\bINV-\d{3}\b")


def count_tests() -> int:
    """Count test functions across the tree. Cheap, stable, and hard to fake."""
    total = 0
    for pattern, glob in (
        (rb"#\[test\]", "*.rs"),
        (rb"\bit\(|\btest\(", "*.ts"),
        (rb"def test_", "*.py"),
    ):
        try:
            result = subprocess.run(
                ["grep", "-rcE", pattern.decode(), "--include", glob, "."],
                cwd=ROOT,
                capture_output=True,
                text=True,
                check=False,
            )
        except OSError:
            continue
        for line in result.stdout.splitlines():
            if ":" not in line:
                continue
            path, _, count = line.rpartition(":")
            if "/target/" in path or "/node_modules/" in path:
                continue
            if count.isdigit():
                total += int(count)
    return total


def snapshot() -> dict:
    registry = load_registry()
    mods = modules_by_id(registry)

    invariants: dict[str, str] = {}
    for mid, m in mods.items():
        for item in m.get("invariants") or []:
            for tag in INV_PATTERN.findall(str(item)):
                invariants[tag] = mid

    return {
        "modules": {
            mid: {
                "tier": m["tier"],
                "status": m["status"],
                "required_gates": sorted(m.get("required_gates") or []),
                "depends_on": sorted(m.get("depends_on") or []),
                "invariant_count": len(m.get("invariants") or []),
            }
            for mid, m in sorted(mods.items())
        },
        "invariants": dict(sorted(invariants.items())),
        "test_count": count_tests(),
    }


def compare(base: dict, now: dict) -> list[str]:
    problems: list[str] = []

    # 1. Invariants may not vanish.
    for tag, owner in base.get("invariants", {}).items():
        if tag not in now["invariants"]:
            problems.append(
                f"INVARIANT LOST: {tag} (was owned by {owner}). "
                "Removing or weakening a financial law requires an ADR "
                "(see CONTRIBUTING.md) and `make baseline` in the same PR."
            )

    base_mods = base.get("modules", {})
    for mid, before in base_mods.items():
        after = now["modules"].get(mid)

        # 4. Modules may not vanish.
        if after is None:
            problems.append(
                f"MODULE LOST: {mid} was in the baseline and is no longer in the registry."
            )
            continue

        # 2. Gates only ratchet up.
        dropped = set(before["required_gates"]) - set(after["required_gates"])
        if dropped:
            problems.append(
                f"GATE DROPPED: {mid} no longer requires {', '.join(sorted(dropped))}. "
                "Proof obligations do not decrease without a recorded decision."
            )

        # 3. Status may not regress.
        if STATUS_RANK.get(after["status"], 0) < STATUS_RANK.get(before["status"], 0):
            problems.append(
                f"STATUS REGRESSED: {mid} went {before['status']} -> {after['status']}."
            )

        # 6. Dependency edges are reviewed, not dropped.
        lost_deps = set(before["depends_on"]) - set(after["depends_on"])
        if lost_deps:
            problems.append(
                f"DEPENDENCY REMOVED: {mid} no longer depends on "
                f"{', '.join(sorted(lost_deps))}. If that is intended, update the baseline."
            )

        # Invariant counts per module only ratchet up.
        if after["invariant_count"] < before["invariant_count"]:
            problems.append(
                f"INVARIANTS REDUCED: {mid} went from {before['invariant_count']} "
                f"to {after['invariant_count']} declared invariants."
            )

    # 5. Tests only ratchet up.
    before_tests = base.get("test_count", 0)
    after_tests = now["test_count"]
    if after_tests < before_tests:
        problems.append(
            f"TEST COUNT FELL: {before_tests} -> {after_tests}. "
            "Deleting tests to make a build pass is the regression this check exists to catch."
        )

    return problems


def main(argv: list[str]) -> int:
    now = snapshot()

    if "--update" in argv:
        BASELINE.write_text(json.dumps(now, indent=2, sort_keys=True) + "\n")
        print(
            f"baseline updated: {len(now['modules'])} modules, "
            f"{len(now['invariants'])} invariants, {now['test_count']} tests"
        )
        print("Commit gates/baseline.json in the same PR as the change that moved it.")
        return 0

    if not BASELINE.exists():
        print("No baseline yet. Creating one from the current tree.", file=sys.stderr)
        BASELINE.write_text(json.dumps(now, indent=2, sort_keys=True) + "\n")
        return 0

    base = json.loads(BASELINE.read_text())
    problems = compare(base, now)

    if problems:
        print("REGRESSION CHECK FAILED\n", file=sys.stderr)
        for p in problems:
            print(f"  - {p}\n", file=sys.stderr)
        print(
            "If every item above is intended, run `make baseline` and commit the\n"
            "updated gates/baseline.json alongside your change.",
            file=sys.stderr,
        )
        return 1

    gained_tests = now["test_count"] - base.get("test_count", 0)
    gained_inv = len(now["invariants"]) - len(base.get("invariants", {}))
    print(
        f"REGRESSION CHECK OK — {len(now['modules'])} modules, "
        f"{len(now['invariants'])} invariants (+{gained_inv}), "
        f"{now['test_count']} tests (+{gained_tests})"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
