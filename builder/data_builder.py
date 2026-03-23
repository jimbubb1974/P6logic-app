"""
Assemble a self-contained JSON payload from a parsed XER file.

The payload is embedded directly in the HTML file and drives both
the Cytoscape network explorer and the Plotly logic diagram.
"""

from __future__ import annotations
import csv
import os
from typing import Optional

import networkx as nx
from dateutil import parser as dateparser

from core.xer_parser import Task, TaskPred, parse_xer
from core.network import build_graph


_HOURS_PER_DAY = 8.0


def _float_days(hr: Optional[float]) -> Optional[float]:
    if hr is None:
        return None
    return round(hr / _HOURS_PER_DAY, 1)


def _parse_date_str(s: Optional[str]) -> Optional[str]:
    """Return ISO date string or None."""
    if not s:
        return None
    try:
        return dateparser.parse(s).strftime("%Y-%m-%d")
    except Exception:
        return None


def load_categories(path: str) -> dict[str, str]:
    """
    Read a two-column CSV: activity_id, category.
    Returns dict mapping task_code -> category string.
    """
    result: dict[str, str] = {}
    if not path or not os.path.exists(path):
        return result
    with open(path, newline="", encoding="utf-8-sig") as fh:
        reader = csv.reader(fh)
        for row in reader:
            if len(row) < 2:
                continue
            code, cat = row[0].strip(), row[1].strip()
            if code.lower() in ("activity_id", "activity id", "task_code", "id"):
                continue  # skip header
            if code and cat:
                result[code] = cat
    return result


def _compute_downstream_lengths(G: nx.DiGraph) -> dict[tuple[str, str], int]:
    """
    For each edge (u→v) in G, count the number of nodes reachable
    downstream from v (inclusive of v).  Used for line-weight-by-sequence-length.
    """
    # Cache descendant counts per node
    cache: dict[str, int] = {}

    def desc_count(node: str) -> int:
        if node not in cache:
            cache[node] = len(nx.descendants(G, node)) + 1
        return cache[node]

    return {(u, v): desc_count(v) for u, v in G.edges()}


def build_payload(
    xer_path: str,
    categories_path: Optional[str] = None,
) -> dict:
    """
    Parse the XER and return a dict ready for json.dumps().

    Structure:
    {
      "tasks": [ {id, code, name, early_start, early_end, late_start, late_end,
                  float_days, task_type, category}, ... ],
      "edges": [ {src_id, tgt_id, pred_type, lag_days, downstream_len,
                  src_float_days, tgt_float_days}, ... ],
      "categories": ["cat1", "cat2", ...],   # sorted unique list
    }
    """
    tasks, preds = parse_xer(xer_path)
    G = build_graph(tasks, preds)

    categories = load_categories(categories_path) if categories_path else {}

    downstream = _compute_downstream_lengths(G)

    # Build task list
    code_to_id = {t.task_code: tid for tid, t in tasks.items()}
    id_to_float: dict[str, Optional[float]] = {
        tid: _float_days(t.total_float_hr_cnt) for tid, t in tasks.items()
    }
    id_to_free_float: dict[str, Optional[float]] = {
        tid: _float_days(t.free_float_hr_cnt) for tid, t in tasks.items()
    }

    tasks_payload = []
    for tid, task in tasks.items():
        tasks_payload.append({
            "id": tid,
            "code": task.task_code,
            "name": task.task_name,
            "early_start": _parse_date_str(task.early_start_date),
            "early_end": _parse_date_str(task.early_end_date),
            "late_start": _parse_date_str(task.late_start_date),
            "late_end": _parse_date_str(task.late_end_date),
            "float_days": id_to_float[tid],
            "free_float_days": id_to_free_float[tid],
            "task_type": task.task_type or "",
            "category": categories.get(task.task_code, ""),
        })

    # Sort by early_start for consistent ordering
    tasks_payload.sort(key=lambda t: (t["early_start"] or "9999", t["code"]))

    # Build edge list
    edges_payload = []
    for pred_task_id, succ_task_id, data in G.edges(data=True):
        lag_days = round((data.get("lag_hr_cnt") or 0) / _HOURS_PER_DAY, 1)
        ds_len = downstream.get((pred_task_id, succ_task_id), 1)
        edges_payload.append({
            "src_id": pred_task_id,
            "tgt_id": succ_task_id,
            "pred_type": data.get("pred_type", "PR_FS"),
            "lag_days": lag_days,
            "downstream_len": ds_len,
            "src_float_days": id_to_float.get(pred_task_id),
            "tgt_float_days": id_to_float.get(succ_task_id),
        })

    unique_cats = sorted({c for c in categories.values() if c})

    return {
        "tasks": tasks_payload,
        "edges": edges_payload,
        "categories": unique_cats,
    }
