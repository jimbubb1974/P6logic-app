"""
Assemble a single self-contained HTML file from:
  - templates/app.html  (the shell)
  - static/app.js       (client-side application code)
  - The JSON payload produced by data_builder
  - CDN JS libraries (fetched once and inlined)

The result is a single .html file with zero external dependencies.
"""

from __future__ import annotations
import json
import os
import urllib.request

# Paths relative to the project root
_HERE = os.path.dirname(__file__)
_ROOT = os.path.dirname(_HERE)
_TEMPLATE = os.path.join(_ROOT, "templates", "app.html")
_APP_JS   = os.path.join(_ROOT, "static", "app.js")

# CDN URLs for JS libraries
_CDN = {
    "plotly":    "https://cdn.plot.ly/plotly-2.32.0.min.js",
    "cytoscape": "https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.28.1/cytoscape.min.js",
    "xlsx":      "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js",
}

# Local cache directory for downloaded scripts (avoids re-downloading every run)
_CACHE_DIR = os.path.join(_ROOT, ".js_cache")


def _fetch_or_cache(name: str, url: str) -> str:
    """Download JS library and cache locally; return the script text."""
    os.makedirs(_CACHE_DIR, exist_ok=True)
    cache_path = os.path.join(_CACHE_DIR, f"{name}.js")
    if os.path.exists(cache_path):
        with open(cache_path, encoding="utf-8") as fh:
            return fh.read()
    print(f"  Downloading {name} from {url} ...")
    with urllib.request.urlopen(url, timeout=30) as resp:
        text = resp.read().decode("utf-8")
    with open(cache_path, "w", encoding="utf-8") as fh:
        fh.write(text)
    return text


def build_html(
    payload: dict,
    output_path: str,
    offline: bool = True,
) -> None:
    """
    Build the self-contained HTML file.

    Parameters
    ----------
    payload      : dict from data_builder.build_payload()
    output_path  : destination .html file path
    offline      : if True, inline all JS; if False, use CDN src= tags (smaller file, requires internet)
    """
    with open(_TEMPLATE, encoding="utf-8") as fh:
        html = fh.read()

    with open(_APP_JS, encoding="utf-8") as fh:
        app_js = fh.read()

    # Inject JS libraries
    if offline:
        plotly_tag    = _fetch_or_cache("plotly",    _CDN["plotly"])
        cytoscape_tag = _fetch_or_cache("cytoscape", _CDN["cytoscape"])
        xlsx_tag      = _fetch_or_cache("xlsx",      _CDN["xlsx"])
        html = html.replace(
            "<script>__PLOTLY_SCRIPT__</script>",
            f"<script>{plotly_tag}</script>",
        )
        html = html.replace(
            "<script>__CYTOSCAPE_SCRIPT__</script>",
            f"<script>{cytoscape_tag}</script>",
        )
        html = html.replace(
            "<script>__XLSX_SCRIPT__</script>",
            f"<script>{xlsx_tag}</script>",
        )
    else:
        # CDN references (small file, needs internet to open)
        html = html.replace(
            "<script>__PLOTLY_SCRIPT__</script>",
            f'<script src="{_CDN["plotly"]}"></script>',
        )
        html = html.replace(
            "<script>__CYTOSCAPE_SCRIPT__</script>",
            f'<script src="{_CDN["cytoscape"]}"></script>',
        )
        html = html.replace(
            "<script>__XLSX_SCRIPT__</script>",
            f'<script src="{_CDN["xlsx"]}"></script>',
        )

    # Inject payload JSON
    payload_json = json.dumps(payload, ensure_ascii=False)
    html = html.replace("__PAYLOAD_JSON__", payload_json)

    # Inject app.js
    html = html.replace("__APP_JS__", app_js)

    with open(output_path, "w", encoding="utf-8") as fh:
        fh.write(html)

    size_kb = os.path.getsize(output_path) / 1024
    print(f"  Output: {output_path}  ({size_kb:.0f} KB)")
