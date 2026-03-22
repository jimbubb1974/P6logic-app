"""CLI entry point for P6logic-app — Advanced Schedule Explorer."""

from __future__ import annotations
import argparse
import sys

from builder.data_builder import build_payload
from builder.html_builder import build_html


def main() -> None:
    ap = argparse.ArgumentParser(
        description="P6logic-app: Generate an interactive schedule explorer from a Primavera XER file."
    )
    ap.add_argument("--xer", required=True, help="Path to the Primavera XER file")
    ap.add_argument(
        "--categories",
        default=None,
        help="Optional CSV file with columns: activity_id, category  (for node colouring)",
    )
    ap.add_argument(
        "--output", default="output.html",
        help="Output HTML filename (default: output.html)",
    )
    ap.add_argument(
        "--online",
        action="store_true",
        help="Use CDN links instead of inlining JS (smaller file but requires internet to open)",
    )
    args = ap.parse_args()

    print(f"Parsing XER: {args.xer}")
    payload = build_payload(args.xer, args.categories)
    print(f"  {len(payload['tasks'])} tasks, {len(payload['edges'])} edges loaded")
    if payload['categories']:
        print(f"  {len(payload['categories'])} categories: {payload['categories']}")

    print("Building HTML...")
    build_html(payload, args.output, offline=not args.online)
    print("Done.")


if __name__ == "__main__":
    main()
