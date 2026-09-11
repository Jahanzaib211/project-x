"""Shared loader for the module registry and gate catalogue."""
from __future__ import annotations

import pathlib
import sys

try:
    import yaml
except ImportError:  # pragma: no cover
    sys.exit("PyYAML is required: pip install pyyaml")

ROOT = pathlib.Path(__file__).resolve().parent.parent
REGISTRY = ROOT / "registry" / "modules.yaml"
GATES = ROOT / "gates" / "gates.yaml"


def load_registry() -> dict:
    return yaml.safe_load(REGISTRY.read_text())


def load_gates() -> dict:
    return yaml.safe_load(GATES.read_text())


def modules_by_id(registry: dict) -> dict:
    return {m["id"]: m for m in registry["modules"]}


def gate_order(gates: dict) -> list[str]:
    return list(gates["gates"].keys())


def topo_sort(mods: dict) -> list[str]:
    """Kahn's algorithm. Raises ValueError naming the cycle if one exists."""
    indegree = {k: 0 for k in mods}
    dependents: dict[str, list[str]] = {k: [] for k in mods}
    for mid, m in mods.items():
        for dep in m.get("depends_on") or []:
            indegree[mid] += 1
            dependents[dep].append(mid)

    queue = sorted(k for k, v in indegree.items() if v == 0)
    order: list[str] = []
    while queue:
        node = queue.pop(0)
        order.append(node)
        for child in sorted(dependents[node]):
            indegree[child] -= 1
            if indegree[child] == 0:
                queue.append(child)
                queue.sort()
    if len(order) != len(mods):
        stuck = sorted(k for k in mods if k not in order)
        raise ValueError(f"dependency cycle among: {', '.join(stuck)}")
    return order


def transitive_deps(mods: dict, mid: str) -> set[str]:
    seen: set[str] = set()
    stack = list(mods[mid].get("depends_on") or [])
    while stack:
        cur = stack.pop()
        if cur in seen:
            continue
        seen.add(cur)
        stack.extend(mods[cur].get("depends_on") or [])
    return seen
