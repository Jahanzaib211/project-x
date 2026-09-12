#!/usr/bin/env python3
"""Every declared invariant must be executed by a test.

An invariant written in a registry and not run in CI is folklore. This check
reads the invariants each module declares, scans the test tree for the tags that
reference them, and fails when a module that is actually being built declares a
law nothing executes.

Scope: modules whose status is `in-progress` or `done`. A `planned` module may
declare its laws before implementing them — that is the point of designing the
graph before building it — but the moment work starts, the laws must run.

Usage:
    check_invariant_coverage.py            # enforce
    check_invariant_coverage.py --all      # report coverage for every module
"""
from __future__ import annotations

import pathlib
import re
import sys

from _registry import ROOT, load_registry, modules_by_id

INV_PATTERN = re.compile(r"\bINV-(\d{3})\b")
TEST_ROOTS = ["tests", "crates", "services", "scripts", "infra", "apps"]
SKIP_DIRS = {"target", "node_modules", ".git", "dist", ".next"}
ENFORCED_STATUSES = {"in-progress", "done"}


def tags_in_tests() -> dict[str, set[pathlib.Path]]:
    """Map INV tag -> the test files that reference it."""
    found: dict[str, set[pathlib.Path]] = {}
    for root_name in TEST_ROOTS:
        root = ROOT / root_name
        if not root.exists():
            continue
        for path in root.rglob("*"):
            # JavaScript suites count too: the edge services and the two apps
            # keep their tests in node:test files beside the code they prove.
            if not path.is_file() or path.suffix not in {".rs", ".ts", ".js", ".py", ".sql", ".sh"}:
                continue
            if any(part in SKIP_DIRS for part in path.parts):
                continue
            try:
                text = path.read_text(errors="ignore")
            except OSError:
                continue
            # Only count a file that actually contains tests.
            if not any(
                marker in text
                for marker in ("#[test]", "fn inv_", "def test_", "it(", "test(", "CREATE TRIGGER", "pass()")
            ):
                continue
            for match in INV_PATTERN.finditer(text):
                found.setdefault(f"INV-{match.group(1)}", set()).add(
                    path.relative_to(ROOT)
                )
    return found


def declared(mods: dict) -> dict[str, tuple[str, str]]:
    """Map INV tag -> (module id, statement)."""
    out: dict[str, tuple[str, str]] = {}
    for mid, m in mods.items():
        for item in m.get("invariants") or []:
            text = str(item)
            match = INV_PATTERN.search(text)
            if match:
                out[f"INV-{match.group(1)}"] = (mid, text)
    return out


def main(argv: list[str]) -> int:
    show_all = "--all" in argv
    mods = modules_by_id(load_registry())
    declarations = declared(mods)
    covered = tags_in_tests()

    missing: list[str] = []
    enforced = 0
    passed = 0

    for tag, (mid, statement) in sorted(declarations.items()):
        status = mods[mid]["status"]
        is_covered = tag in covered
        must_cover = status in ENFORCED_STATUSES

        if must_cover:
            enforced += 1
            if is_covered:
                passed += 1
            else:
                missing.append(
                    f"{tag} ({mid}, status={status}) has no test.\n"
                    f"      {statement.strip()[:110]}\n"
                    f"      Add a test to tests/invariants/ whose name or comment cites {tag}."
                )
        if show_all:
            mark = "✓" if is_covered else ("✗" if must_cover else "·")
            where = ", ".join(str(p) for p in sorted(covered.get(tag, []))) or "—"
            print(f"  {mark} {tag}  {mid:<20} {status:<12} {where}")

    # An orphan tag means a test cites a law the registry no longer declares.
    orphans = sorted(set(covered) - set(declarations))

    print()
    print(
        f"invariant coverage: {passed}/{enforced} enforced "
        f"({len(declarations)} declared across {len(mods)} modules, "
        f"{len(covered)} referenced by tests)"
    )

    if orphans:
        print(f"\nWARNING: tests cite invariants the registry does not declare: {', '.join(orphans)}")
        print("Either add them to registry/modules.yaml or remove the stale reference.")

    if missing:
        print("\nINVARIANT COVERAGE FAILED\n", file=sys.stderr)
        for item in missing:
            print(f"  - {item}\n", file=sys.stderr)
        return 1

    print("✓ every invariant of every in-progress module is executed by a test")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
