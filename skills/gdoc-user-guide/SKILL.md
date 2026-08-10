---
name: gdoc-user-guide
description: Use when creating a user guide, end-user manual, training document, or how-to guide for a Frappe/ERPNext custom app or module — delivered as a Google Doc via the Google Drive MCP. Reads the codebase directly to derive workflow states, action buttons, fields, and validation rules. Triggers on "user guide", "user manual", "end user doc", "training guide", "how to use", "google doc guide", "operator guide".
---

# Role

Senior Technical Writer and Frappe Systems Analyst. Your job is to READ the actual codebase — DocType JSON, JavaScript controllers, Python modules, workflow definitions — and translate the technical architecture into a natural, user-friendly Google Doc that end users can open and immediately understand. You never guess; you derive from code.

Output is a **Google Doc** created via `mcp__claude_ai_Google_Drive__create_file` with `contentMimeType: "text/html"`. Not a markdown file. Not a chat response. A real Google Doc.

---

# Pipeline (MANDATORY — two-stop gate)

## Phase 1 — Code Analysis & Blueprint (STOP AND PRESENT)

Read the codebase before writing a single word of documentation. Execute this analysis:

### 1a. DocType Field Discovery
For each core DocType in scope, read the `.json` file:
- Extract all fields: `fieldname`, `label`, `fieldtype`, `reqd`, `read_only`, `depends_on`, `description`
- Note which fields are mandatory, which are computed/locked, which show conditionally
- Identify child table fields (important for "add row" steps)

### 1b. Workflow State Machine
Find the workflow JSON or Python workflow definition:
- List every `state` and what `doc_status` it maps to
- List every `transition`: action name (= button label), from-state, to-state, allowed role
- Note any `condition` expressions — these explain when actions appear/disappear

### 1c. JavaScript Controller Analysis
Read every `doctype.js` file for the DocType(s) in scope:
- Find all `setup_*` functions — these define action buttons
- Find all `frm.add_custom_button(...)` calls — extract button label, group, and what it does
- Find all `frm.set_df_property(fieldname, "read_only", ...)` — explains field locking rules
- Find all `frm.set_query(...)` — explains filtered dropdowns
- Find `refresh(frm)` body — the full list of what runs on every form load
- Find `before_workflow_action` — pre-action validation and confirmation dialogs

### 1d. Python Module Analysis
Read the Python controller (`doctype.py`) and any linked API files:
- Find `validate`, `before_save`, `after_save`, `before_submit` hooks — these explain silent enforcements
- Find `@frappe.whitelist()` methods — these are callable from JS and power action buttons
- Find `frappe.throw(...)` calls — these become Warning callouts in the guide
- Find any cross-document state changes (e.g., saving a Bug Log that auto-closes an Issue Log)

### 1e. Role-Permission Matrix
From workflow transitions and Python permission guards:
- Which roles can create records?
- Which roles can trigger which workflow actions?
- Which roles have read-only access only?

---

### Blueprint Deliverable (present this before generating the doc)

Output a structured outline:

```
## User Guide Blueprint: [App/Module Name]

### Audience
[Roles who will read this doc, what they need to know]

### Scope
[Which DocTypes are covered, which are out of scope]

### Derived Workflow Summary
For each DocType:
- States: [list with plain-English meaning]
- Key transitions (button → who can click it → result)
- Fields end-user must fill (mandatory / optional)
- Fields that are auto-filled or locked (explain why)
- Validation traps (what throws an error or blocks progression)

### Proposed Table of Contents
[Section numbers and titles]

### Formatting Confirmation
- Font: Bai Jamjuree (Google Font)
- Color palette: [confirm hex values from house style]
- Callout types needed: Warning, Note
- Screenshot placeholders: Yes/No
```

**STOP. Wait for sign-off before generating the Google Doc.**

---

## Phase 2 — Generate the Google Doc

After approval, build and upload the full guide using the exact HTML template rules below.

---

# Google Drive Delivery

## Tool Call

```
mcp__claude_ai_Google_Drive__create_file
  title: "[App Name] — User Guide"
  contentMimeType: "text/html"
  textContent: [full HTML string]
```

After creation, **always verify** with `mcp__claude_ai_Google_Drive__read_file_content` to confirm all sections are present.

## Critical Constraints

- `fileSize: "1"` returned by the API is **normal** — Google Docs don't have a traditional file size. This is NOT an error.
- **Never use emoji** in the HTML content. Characters like 📌 📋 ⚠️ ✅ corrupt to gibberish (`ð`, etc.) during HTML→GDoc conversion. Use bold text labels instead: `WARNING:`, `NOTE:`, `TIP:`.
- Complex CSS (`@media`, CSS classes, `:hover`, etc.) does NOT survive conversion. Every style must be an **inline `style=` attribute** on the exact element it applies to.
- `font-family` must be set inline on **every** element (`p`, `td`, `h1`, `li`, `span`), not just `body`. GDocs strips inherited styles.

---

# HTML Template Rules

## Document Shell

```html
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Bai+Jamjuree:ital,wght@0,400;0,600;0,700;1,400&display=swap');
</style>
</head>
<body style="font-family:'Bai Jamjuree',Arial,sans-serif;font-size:11pt;">
<!-- content here -->
</body>
</html>
```

## Cover Block

```html
<p style="font-family:'Bai Jamjuree',Arial,sans-serif;font-size:34pt;font-weight:700;color:#1f3864;margin-bottom:4pt;margin-top:36pt;">[App Name]</p>
<p style="font-family:'Bai Jamjuree',Arial,sans-serif;font-size:20pt;font-weight:700;color:#1f3864;margin-top:0;margin-bottom:4pt;">User Guide</p>
<p style="font-family:'Bai Jamjuree',Arial,sans-serif;font-size:11pt;color:#555555;margin-top:0;margin-bottom:32pt;">For [Role Names] &nbsp;|&nbsp; Version 1.0 &nbsp;|&nbsp; [Month YYYY]</p>
<hr style="border:none;border-top:2px solid #1f3864;margin-bottom:24pt;">
```

## Section Heading (H1)

```html
<h1 style="font-family:'Bai Jamjuree',Arial,sans-serif;font-size:16pt;font-weight:700;color:#1f3864;margin-top:24pt;">N. Section Title</h1>
```

## Subsection Heading (H2)

```html
<h2 style="font-family:'Bai Jamjuree',Arial,sans-serif;font-size:13pt;font-weight:700;color:#1f6fb2;margin-top:16pt;">N.N Subsection Title</h2>
```

## Body Paragraph

```html
<p style="font-family:'Bai Jamjuree',Arial,sans-serif;font-size:11pt;">Text here.</p>
```

## Bulleted List

```html
<ul style="font-family:'Bai Jamjuree',Arial,sans-serif;font-size:11pt;margin:6pt 0 6pt 24pt;">
  <li style="font-family:'Bai Jamjuree',Arial,sans-serif;font-size:11pt;margin:3pt 0;">Item text</li>
</ul>
```

## Step Table (3-column: Step | Action | Notes)

```html
<table style="border-collapse:collapse;width:100%;margin:12pt 0;">
  <!-- Header row -->
  <tr>
    <td style="background-color:#e8f0f8;border:1px solid #c8d4e0;padding:5pt 6pt;font-family:'Bai Jamjuree',Arial,sans-serif;font-size:10pt;font-weight:700;color:#1f3864;width:8%;">Step</td>
    <td style="background-color:#e8f0f8;border:1px solid #c8d4e0;padding:5pt 6pt;font-family:'Bai Jamjuree',Arial,sans-serif;font-size:10pt;font-weight:700;color:#1f3864;">Action</td>
    <td style="background-color:#e8f0f8;border:1px solid #c8d4e0;padding:5pt 6pt;font-family:'Bai Jamjuree',Arial,sans-serif;font-size:10pt;font-weight:700;color:#1f3864;width:35%;">Notes</td>
  </tr>
  <!-- Body row -->
  <tr>
    <td style="background-color:#ffffff;border:1px solid #c8d4e0;padding:5pt 6pt;font-family:'Bai Jamjuree',Arial,sans-serif;font-size:10pt;font-weight:700;color:#1f6fb2;">1</td>
    <td style="background-color:#ffffff;border:1px solid #c8d4e0;padding:5pt 6pt;font-family:'Bai Jamjuree',Arial,sans-serif;font-size:10pt;">Action description with <strong>bold field names</strong></td>
    <td style="background-color:#ffffff;border:1px solid #c8d4e0;padding:5pt 6pt;font-family:'Bai Jamjuree',Arial,sans-serif;font-size:10pt;color:#555555;">Contextual note</td>
  </tr>
</table>
```

Rules:
- Step number column: `width:8%`, `font-weight:700;color:#1f6fb2`
- Notes column: `width:35%`, `color:#555555`
- Step number = bold `#1f6fb2`, Action = normal weight, Notes = grey `#555555`
- For 2-column tables (no Notes), omit the Notes column and remove the width constraint on Action

## Reference Table (State/Field definitions)

```html
<table style="border-collapse:collapse;width:100%;margin:12pt 0;">
  <tr>
    <td style="background-color:#e8f0f8;border:1px solid #c8d4e0;padding:5pt 6pt;font-family:'Bai Jamjuree',Arial,sans-serif;font-size:10pt;font-weight:700;color:#1f3864;width:28%;">Column A</td>
    <td style="background-color:#e8f0f8;border:1px solid #c8d4e0;padding:5pt 6pt;font-family:'Bai Jamjuree',Arial,sans-serif;font-size:10pt;font-weight:700;color:#1f3864;">Column B</td>
  </tr>
  <tr>
    <td style="background-color:#ffffff;border:1px solid #c8d4e0;padding:5pt 6pt;font-family:'Bai Jamjuree',Arial,sans-serif;font-size:10pt;font-weight:700;color:#1f6fb2;">Value</td>
    <td style="background-color:#ffffff;border:1px solid #c8d4e0;padding:5pt 6pt;font-family:'Bai Jamjuree',Arial,sans-serif;font-size:10pt;">Explanation</td>
  </tr>
</table>
```

## Warning Callout (blocking error, data-loss risk, irreversible action)

```html
<table style="border-collapse:collapse;width:100%;margin:12pt 0;">
  <tr>
    <td style="background-color:#fef3f2;border:1px solid #c0392b;padding:5pt 8pt;font-family:'Bai Jamjuree',Arial,sans-serif;font-size:10pt;font-weight:700;color:#c0392b;">
      WARNING: [Clear statement of what will go wrong and how to avoid it.]
    </td>
  </tr>
</table>
```

## Note Callout (helpful context, non-blocking tip)

```html
<table style="border-collapse:collapse;width:100%;margin:12pt 0;">
  <tr>
    <td style="background-color:#eff4fb;border:1px solid #1f6fb2;padding:5pt 8pt;font-family:'Bai Jamjuree',Arial,sans-serif;font-size:10pt;font-weight:700;color:#1f6fb2;">
      NOTE: [Helpful clarification or pro-tip.]
    </td>
  </tr>
</table>
```

## Screenshot Placeholder

```html
<table style="border-collapse:collapse;width:100%;margin:12pt 0;">
  <tr>
    <td style="background-color:#f5f7fa;border:1px solid #cccccc;padding:28pt 6pt;font-family:Arial,sans-serif;font-size:10pt;font-weight:700;color:#999999;text-align:center;">
      Screenshot: [Specific description of what the screenshot should show]
    </td>
  </tr>
</table>
<p style="font-family:Arial,sans-serif;font-size:9pt;font-weight:700;font-style:italic;color:#1f4e79;text-align:center;margin-top:2pt;">Figure N — [Caption]</p>
```

Rules:
- Screenshot cell padding is `28pt 6pt` (tall vertical padding, matches ePump reference spec)
- Caption uses Arial (not Bai Jamjuree), 9pt, bold, italic, `#1f4e79`
- Always center-aligned

## Page Footer (document end)

```html
<hr style="border:none;border-top:1px solid #c8d4e0;margin-top:32pt;margin-bottom:12pt;">
<p style="font-family:'Bai Jamjuree',Arial,sans-serif;font-size:9pt;color:#888888;text-align:center;">[App Name] User Guide &nbsp;|&nbsp; [Target Roles] &nbsp;|&nbsp; v1.0 &nbsp;|&nbsp; [Month YYYY]</p>
```

---

# Color Palette (house standard — ePump Provisioning reference)

| Token | Hex | Usage |
|-------|-----|-------|
| Dark Heading | `#1f3864` | H1, cover title, table header text |
| Accent Blue | `#1f6fb2` | H2, step numbers, reference value column, note border+text |
| Navy Caption | `#1f4e79` | Figure captions (Arial only) |
| Warning Red | `#c0392b` | Warning border + text |
| Warning Bg | `#fef3f2` | Warning callout background |
| Note Bg | `#eff4fb` | Note callout background |
| Table Header Bg | `#e8f0f8` | Step table and reference table header rows |
| Table Border | `#c8d4e0` | All table cell borders |
| Placeholder Bg | `#f5f7fa` | Screenshot placeholder cells |
| Placeholder Border | `#cccccc` | Screenshot placeholder border |
| Notes Text | `#555555` | Step table Notes column, secondary text |

---

# Content Writing Rules

## Translate Technical → Human

| Code artifact | What to write in the guide |
|---|---|
| `frappe.throw("X must be set before Y")` | Warning callout: "WARNING: X must be filled before clicking Y." |
| `frm.set_df_property("field", "read_only", 1)` | "This field is automatically locked once [condition]. You cannot edit it." |
| `frappe.confirm(message, ...)` | "A confirmation dialog will appear. Read it carefully — it lists all downstream changes." |
| `state === "Open"` condition on button | "This button only appears when the record is in Open state." |
| `has_linked_bug` guard on button | "This button is hidden once a Bug Log is linked." |
| `frappe.route_options.source_bug_log` | "If you opened this form from a Bug Log, the Source Bug Log field is pre-filled." |
| Workflow transition `allowed: "PQ Lead"` | Show button only in PQ Lead role column; add Note callout for PQ Users |
| `reqd: 1` field | Bold in field lists; call out in step table Notes column |
| `scheduler_events daily` | "The system automatically runs this check every night." |

## Voice and Tone

- Address the reader as "you" — direct and respectful
- Use strong imperative verbs: Navigate, Click, Select, Enter, Set, Save, Submit
- Explain the WHY, not just the HOW: "Click Save to create a draft — the record is not yet active"
- Field names in **bold**: `**Observation**`, `**Valid Until**`
- Button names in **bold**: `**Submit for Approval**`, `**Create Bug Log**`
- State names in **bold**: `**Open**`, `**Deviation Accepted**`
- Avoid jargon: "the system" not "the server-side hook"; "a confirmation box appears" not "frappe.confirm fires"

## Scope Discipline

- Write only for the roles specified by the user (e.g., end users, not system admins)
- Do NOT document: configuration, DocType setup, Custom Fields, hooks.py, bench commands, setup.js
- If a feature requires a role the audience doesn't have, mention it briefly: "This step is performed by a PQ Lead"
- Derivations that are not visible to end users (server-side auto-calculations) should be documented as observed effects ("the status automatically moves to Failure") not as technical implementations

---

# Standard Document Structure

Adapt section count to the module's complexity. Suggested structure for a 3-DocType module:

1. **Overview** — what the module does, the three record types, typical end-to-end flow
2. **Roles and Access** — role table with what each role can do
3. **[Primary DocType]** — create, fill, submit; workflow states; key actions
4. **[Secondary DocType]** — same pattern
5. **[Third DocType]** — same pattern (if applicable)
6. **Linked Records** — how the Links tab works, bidirectional linking
7. **Tasks and Assignments** — if the module has task/action-item tracking
8. **Common Action Buttons** — consolidated reference table: button, available on (state), what it does
9. **Quick Reference** — decision table (situation → what to do first), status color table, tips list

---

# Self-Audit Before Generating

Before calling `mcp__claude_ai_Google_Drive__create_file`, verify:

- [ ] Every workflow state is documented with a plain-English meaning and what to do next
- [ ] Every action button in the JS has an entry in the guide (either in a step table or the Common Actions reference)
- [ ] Every `frappe.throw` / validation trap from Python has a WARNING callout
- [ ] Every `confirmation dialog` (frappe.confirm) is mentioned with "read the dialog carefully"
- [ ] Every field that auto-locks has an explanation ("this field locks once X")
- [ ] Every cross-document state change is explained as an observed effect
- [ ] No emoji anywhere in the HTML
- [ ] All styles are inline (no CSS classes)
- [ ] font-family is set on every `<td>`, `<p>`, `<li>`, `<h1>`, `<h2>` — not just `<body>`
- [ ] `border-collapse:collapse` on every `<table>`
- [ ] Screenshot placeholders use `padding:28pt 6pt` (not less)
- [ ] Figure captions use Arial, not Bai Jamjuree

---

# Iteration Protocol

If the user requests formatting changes after the doc is created:
- **Do NOT** create a new doc via `create_file`. Instead, identify exactly what changed and create a new doc with the corrected HTML — delete or supersede the old one.
- Read the reference DOCX files (if provided) by downloading them through Google Drive, unzipping in the scratchpad, and parsing `word/styles.xml` and `word/document.xml` with a Python subagent to extract exact twip values, font names, and hex colors. Named styles in `styles.xml` may differ from actual inline runs in `document.xml` — trust the inline runs as the true visual representation.
- Document the confirmed formatting spec in a memory file for future sessions.

---

# Context Anchor

- **Target output**: Google Doc (not markdown, not PDF, not chat text)
- **Delivery mechanism**: `mcp__claude_ai_Google_Drive__create_file` with `contentMimeType: "text/html"`
- **Font**: Bai Jamjuree — company standard, imported via Google Fonts
- **Reference docs** (confirmed ePump Provisioning style): `1qS2_-VcfeRLniGQHsOHVbdwJsWtXVQNuN909Bvsj1bw` (primary), `1dOCUv9PUKkDtwuxOl0ryAwwj-Kd7O2Op3DljqCgUzWQ` (secondary)
- **Audience default**: PQ User + PQ Lead (end users only — no admin/config content)
- **Verify after creation**: always read the file back to confirm all sections converted correctly
