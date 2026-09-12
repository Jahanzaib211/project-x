#!/usr/bin/env python3
"""Run every gate a module declares, in order, failing fast.

    run_gates.py 03-ledger

Each gate maps to a command. A gate with no runnable command yet reports
PENDING rather than passing — an unimplemented gate must never look green.
"""
from __future__ import annotations

import subprocess
import sys

from _registry import ROOT, load_gates, load_registry, modules_by_id

# Gate -> shell command. Commands run from the repo root.
GATE_COMMANDS: dict[str, list[str]] = {
    "G0": ["make", "--no-print-directory", "fmt-check"],
    "G1": ["make", "--no-print-directory", "lint"],
    "G2": ["make", "--no-print-directory", "test"],
    "G3": ["make", "--no-print-directory", "test-property"],
    "G4": ["make", "--no-print-directory", "test-invariants"],
    "G5": ["make", "--no-print-directory", "test-integration"],
    "G6": ["make", "--no-print-directory", "test-replay"],
    "G7": ["make", "--no-print-directory", "chaos"],
    "G8": ["make", "--no-print-directory", "test-security"],
    "G9": ["make", "--no-print-directory", "test-performance"],
}


def main(argv: list[str]) -> int:
    if not argv:
        print("usage: run_gates.py <module-id>", file=sys.stderr)
        return 2

    module_id = argv[0]
    mods = modules_by_id(load_registry())
    gates_doc = load_gates()

    if module_id not in mods:
        print(f"unknown module: {module_id}", file=sys.stderr)
        return 2

    module = mods[module_id]
    required = [g for g in module.get("required_gates") or [] if gates_doc["gates"][g]["stage"] == "ci"]

    print(f"\n{module_id} — {module['name']}  [{module['tier']}]")
    print(f"required CI gates: {' '.join(required)}\n")

    failed: list[str] = []
    pending: list[str] = []

    for gate in required:
        name = gates_doc["gates"][gate]["name"]
        command = GATE_COMMANDS.get(gate) or []
        if not command:
            print(f"  ⋯ {gate}  {name}: PENDING (runs in CI only)")
            pending.append(gate)
            continue

        print(f"  ▸ {gate}  {name}")
        result = subprocess.run(command, cwd=ROOT, check=False)
        if result.returncode == 0:
            print(f"  ✓ {gate}  passed\n")
        else:
            print(f"  ✗ {gate}  FAILED\n")
            failed.append(gate)
            break  # fail fast: a later gate on broken code proves nothing

    print()
    if failed:
        print(f"BLOCKED at {failed[0]}. Fix it before the remaining gates mean anything.")
        return 1
    if pending:
        print(f"Local gates passed. Still to run in CI: {' '.join(pending)}")
    else:
        print("All declared CI gates passed locally.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
