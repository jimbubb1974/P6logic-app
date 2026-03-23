# P6logic-app — Interactive Primavera XER Schedule Explorer

P6logic-app reads a Primavera P6 XER export file and produces a single, self-contained HTML file that lets you explore a project schedule entirely in your browser — no server, no installation on the viewer's machine.

Two complementary views are provided:

- **Network Explorer** (Cytoscape) — click any activity to expand its predecessor/successor neighbourhood and trace logic paths through the schedule.
- **Logic Diagram** (Plotly) — a swimlane diagram showing your selected key activities and the connecting logic between them.

---

## Features

| Feature | Description |
|---|---|
| Network explorer | Click-to-expand predecessor/successor graph with pan and zoom |
| Logic diagram | Swimlane diagram of key activities with inter-activity connections |
| Float filter | Slider to hide connections above a total float threshold |
| Line weight | Weight edges by total float, link float, downstream sequence length, or uniform |
| Float labels | Toggle connection labels between total float, link float, or off |
| Labels | Toggle node labels between shorthand name, activity ID, or full name |
| Import key activities | Load an Excel/CSV spreadsheet to define key activities, shorthand names, and categories |
| Export key activities | Download the current key activity list as a spreadsheet |
| Import log | Highlights any activity IDs in the import file that were not found in the schedule |
| Key activities editor | In-app modal to add, remove, and rename key activities without a spreadsheet |
| Zoom / pan | Full zoom and pan in both the network explorer and logic diagram |
| Offline output | All JS is inlined — the HTML file opens with no internet connection required |
| Category colouring | Colour nodes by category via the key activities spreadsheet (column C) or the editor |

---

## Requirements

- Python 3.9+
- Dependencies listed in `requirements.txt`:

```
networkx
plotly
python-dateutil
openpyxl
```

Install with:

```bash
pip install -r requirements.txt
```

---

## Usage

```bash
python main.py --xer file.xer [--categories cats.csv] [--output out.html] [--online]
```

### Arguments

| Argument | Required | Description |
|---|---|---|
| `--xer file.xer` | Yes | Path to the Primavera XER export file |
| `--categories cats.csv` | No | CSV file mapping activity IDs to category names (for node colouring) |
| `--output out.html` | No | Output filename (default: `output.html`) |
| `--online` | No | Use CDN links instead of inlining JS — produces a much smaller file but requires an internet connection to open |

### Examples

```bash
# Basic usage — fully self-contained offline file
python main.py --xer myproject.xer

# With category colouring and a custom output name
python main.py --xer myproject.xer --categories categories.csv --output explorer.html

# Smaller file using CDN (requires internet to view)
python main.py --xer myproject.xer --online --output explorer_online.html
```

---

## Key Activities Spreadsheet Format

When importing a key activities spreadsheet via the **Import** button in the toolbar, the file must be an Excel (`.xlsx`) or CSV file with the following layout:

| Column A | Column B | Column C |
|---|---|---|
| Activity ID | Shorthand name | Category |
| `ACT-001` | `Foundation Complete` | `Civil` |
| `ACT-042` | `First Floor Slab` | `Civil` |
| `ACT-107` | `Roof Structure` | `Steel` |

- **Column A** — the Primavera activity ID (task code), e.g. `A1000`. Required.
- **Column B** — a short display name used as the node label in the logic diagram. If omitted, the activity ID is used instead.
- **Column C** — a category string used to colour the node. Activities sharing the same category string get the same colour. If omitted, the category from the XER file (if any) is used.
- No header row is required, but a header row is harmlessly ignored if present.
- Any activity IDs not found in the schedule are reported in a dismissible warning bar after import.

The same format is used when exporting the current key activity list via the **Export** button, so exported files can be re-imported cleanly.

---

## Float Labels and Line Weight

Two independent controls govern how float information is shown on connections in the logic diagram.

**Float labels button** (toolbar) — cycles through:
- **Float: Total** — shows min(total float of src, total float of tgt) on each highlighted connection
- **Float: Link** — shows the link float (relationship float) of each connection: the date gap between the predecessor's early finish and the successor's early start, adjusted for lag and relationship type. Low values indicate driving or near-driving relationships. Values shown are calendar-day approximations.
- **Float: Off**

**Line weight selector** (toolbar) — options:
- **By total float** — thicker lines = lower total float = closer to the critical path
- **By link float** — thicker lines = lower link float = this specific tie is more constraining for the successor. For connections that pass through intermediate activities, the minimum link float along all hops in the path is used (the tightest hop is the binding constraint).
- **By downstream length** — thicker lines = more activities downstream
- **Uniform**

Line weights use a logarithmic scale so near-critical connections are visually distinguished even when the schedule contains a wide range of float values. Weights are normalised to the connections visible around the selected node, so the full thickness range is always used.

> **Note on link float accuracy:** Link float is computed client-side from the early start/finish dates embedded in the HTML. Values are in calendar days, not P6 working days, because the project calendar is not available to the browser. Driving ties on adjacent working days (e.g. Friday→Monday) will show ~1–3 calendar days rather than 0. Values well above this threshold reliably indicate non-driving relationships.

---

## Opening the Output

Simply open the generated HTML file in any modern browser:

```
double-click   output.html
```

or

```
File > Open  in Chrome / Firefox / Edge
```

No web server is needed. The file is entirely self-contained (unless `--online` was used).

---

## Project Structure

```
P6logic-app/
├── main.py                  # CLI entry point
├── requirements.txt
├── builder/
│   ├── data_builder.py      # XER parsing and JSON payload assembly
│   └── html_builder.py      # HTML assembly and JS inlining
├── core/
│   ├── xer_parser.py        # Low-level XER file parser
│   └── network.py           # NetworkX graph construction
├── static/
│   └── app.js               # Client-side application (Cytoscape + Plotly)
└── templates/
    └── app.html             # HTML shell template
```
