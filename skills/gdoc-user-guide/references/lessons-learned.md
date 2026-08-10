# Lessons Learned — GDoc User Guide Skill

Derived from building a real end-user guide for a custom Frappe app. Every item here was an actual failure or discovery during that build, not a hypothetical.

---

## Google Drive HTML Conversion

### What Survives the Conversion

- Inline `style=` attributes on individual elements ✅
- `font-family` if the font is a Google Font (Bai Jamjuree works) ✅
- `background-color`, `border`, `color`, `font-size`, `font-weight` on `<td>` ✅
- `<strong>` and `<em>` tags ✅
- `<table>`, `<tr>`, `<td>` structure ✅
- `@import` in a `<style>` tag (loads the font) ✅

### What Does NOT Survive

- CSS class selectors (`.warning`, `.step-table`) ❌
- Styles on `<body>` that inherit into children — must repeat inline on every element ❌
- `<style>` block rules applied to elements (only the font import works) ❌
- Media queries, `:hover`, pseudo-classes ❌
- `padding` shorthand on `<td>` in older Docs versions — use `5pt 6pt` form ✅ (works)

---

## Emoji Corruption (Critical)

**Problem**: Emoji characters (📌, ⚠️, ✅, 📋) convert to garbled multi-byte strings (`ð\x9f\x93\x8c` etc.) when HTML is uploaded to Google Drive.

**Lesson**: NEVER use emoji in the HTML content. Replace with plain text:
- ⚠️ WARNING: → `WARNING:`
- 📌 Note: → `NOTE:`  
- ✅ Done → just write "Done"
- 📋 → remove entirely

---

## Font: Bai Jamjuree

**Discovery**: The company uses Bai Jamjuree (a Google Font) as their primary typeface. This was confirmed by downloading reference Google Docs as DOCX files and parsing `word/styles.xml` — the font name appeared as `BaiJamjuree` in the XML.

**How to use**:
```html
<style>
  @import url('https://fonts.googleapis.com/css2?family=Bai+Jamjuree:ital,wght@0,400;0,600;0,700;1,400&display=swap');
</style>
```
Then on every element: `font-family:'Bai Jamjuree',Arial,sans-serif`

**Figure captions**: Use `Arial` (not Bai Jamjuree) — matches the ePump reference where captions use a different font from body.

---

## fileSize: "1" is Normal

When `mcp__claude_ai_Google_Drive__create_file` returns `"fileSize":"1"` for a Google Doc, this is **not an error**. Google Docs have no traditional file size; the API returns 1 as a placeholder. The content is there — verify by calling `read_file_content`.

---

## Always Read Back After Creating

Call `mcp__claude_ai_Google_Drive__read_file_content` with the new doc's ID immediately after creation. Confirm:
- All major sections are present (count the H1s)
- Tables converted (look for `|` in the text output)
- No truncation (large docs may be cut — check the last section is present)

---

## Extracting Reference Formatting from DOCX

When the user shares Google Doc reference files for formatting, the best method is:

1. Download as DOCX via Google Drive's export
2. Unzip the DOCX in the scratchpad (it's a ZIP)
3. Read `word/styles.xml` → named style definitions (Normal, Heading1, etc.)
4. Read `word/document.xml` → actual inline `<w:rPr>` run properties

**Critical insight**: Named styles in `styles.xml` often differ from what the doc actually looks like, because inline run properties in `document.xml` override the style. The inline runs are the ground truth.

Key XML attributes to extract:
- `<w:sz w:val="28"/>` → 14pt (sz is in half-points, divide by 2)
- `<w:color w:val="1F3864"/>` → hex color (no `#`)
- `<w:b/>` → bold
- `<w:i/>` → italic
- `<w:rFonts w:ascii="Bai Jamjuree"/>` → font name
- `<w:shd w:fill="E8F0F8"/>` → cell background color
- `<w:tcMar>` → cell padding (in twips: 1440 twips = 1 inch; 20 twips = 1pt)

---

## Exact Formatting Spec (ePump Provisioning, confirmed June 2026)

Source: `1qS2_-VcfeRLniGQHsOHVbdwJsWtXVQNuN909Bvsj1bw`

| Element | Font | Size | Weight | Color | Background | Border |
|---------|------|------|--------|-------|------------|--------|
| Cover title | Bai Jamjuree | 34pt | 700 | #1f3864 | — | — |
| Cover subtitle | Bai Jamjuree | 20pt | 700 | #1f3864 | — | — |
| Section H1 | Bai Jamjuree | 16pt | 700 | #1f3864 | — | — |
| Subsection H2 | Bai Jamjuree | 13pt | 700 | #1f6fb2 | — | — |
| Body text | Bai Jamjuree | 11pt | 400 | #000000 | — | — |
| Table all cells | Bai Jamjuree | 10pt | 400 | #000000 | — | — |
| Table header | Bai Jamjuree | 10pt | 700 | #1f3864 | #e8f0f8 | 1px #c8d4e0 |
| Step number | Bai Jamjuree | 10pt | 700 | #1f6fb2 | #ffffff | 1px #c8d4e0 |
| Warning text | Bai Jamjuree | 10pt | 700 | #c0392b | #fef3f2 | 1px #c0392b |
| Note text | Bai Jamjuree | 10pt | 700 | #1f6fb2 | #eff4fb | 1px #1f6fb2 |
| Placeholder | Arial | 10pt | 700 | #999999 | #f5f7fa | 1px #cccccc |
| Figure caption | Arial | 9pt | 700+italic | #1f4e79 | — | — |

Cell padding:
- Step/reference tables: `5pt 6pt` (top/bottom 5pt, left/right 6pt)
- Callouts: `5pt 8pt` (slightly wider horizontal)
- Screenshot placeholders: `28pt 6pt` (very tall vertical — approx 560 twips top+bottom)

---

## Codebase Reading — What to Look For

### In doctype.js (JavaScript controller)

| Pattern | What it means for the guide |
|---------|----------------------------|
| `setup_action_buttons(frm)` | Find which buttons appear in which states |
| `frm.add_custom_button(label, fn, group)` | One entry per button in the Action Buttons section |
| `frm.set_df_property(field, "read_only", 1)` | "This field locks when [condition]" |
| `frm.set_query(field, () => {...})` | "This dropdown filters based on [other field]" |
| `state === "Open"` guards | Button only shows when state is Open |
| `frappe.confirm(message, ...)` | "A confirmation dialog appears — read it" |
| `before_workflow_action` | Pre-action validation that can block the workflow |
| `frm.__expt_link_rows` | Internal link panel state (not user-visible but drives button visibility) |

### In Python controller

| Pattern | What it means for the guide |
|---------|----------------------------|
| `frappe.throw(msg)` | WARNING callout with the message text |
| `doc.db_set("workflow_state", ...)` | Cross-document state change — explain as "automatically moves to X" |
| `@frappe.whitelist()` | A callable action — find what JS calls it and what it does |
| `validate(self)` | Silent enforcement on every save — document as "the system ensures X" |
| `scheduler_events` in hooks.py | Nightly/hourly automation — document as "automatically expires/updates" |

### In workflow JSON/fixture

| Field | What it means for the guide |
|-------|----------------------------|
| `states[].state` | Every status badge the user will see |
| `transitions[].action` | Exact button labels in the workflow action dropdown |
| `transitions[].allowed` | Which role can click this button |
| `transitions[].condition` | When the button appears (translate to plain English) |
| `transitions[].next_state` | The resulting state after clicking |

---

## Content Scope Rules

- End users = PQ User + PQ Lead roles ONLY
- Never document: hooks.py, setup.js, bench commands, DocType configuration, Custom Fields, System Console
- Admin-only actions: mention briefly as "this step is performed by a system administrator"
- Computed/auto fields: explain the observed effect ("status automatically moves to Failure when a Bug Log is linked") — never expose the mechanism
- Cross-module effects: always explain downstream impact (e.g., "Withdrawing this record may also affect linked Issue Logs — the system shows a preview")
