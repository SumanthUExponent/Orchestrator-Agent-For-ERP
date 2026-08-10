---
name: context-keeper
description: Use when starting a new Claude session on an existing project, when context has been lost, or when you need to brief Claude on the current state of a Frappe module before continuing work.
---

Re-establish full project context at the start of a new Claude session so work can resume without re-explaining architecture, decisions, or current state.

## Pre-Flight Questions

1. **Which module / file are we working on?**
2. **What was the last thing completed?**
3. **What is the next task?**
4. **Any blockers or constraints to know about?**

---

## Step-by-Step Instructions

### 1. Context Brief Format

When resuming a session, provide this brief to Claude:

```
PROJECT: [Module name]
PLATFORM: Frappe v[version] on [Frappe Cloud / local bench]
APP DIR: [path]

ARCHITECTURE:
- [Key DocType 1]: [purpose]
- [Key DocType 2]: [purpose]
- [Server Script name]: [what it does]
- [Client Script name]: [what it does]

CONSTRAINTS:
- safe_exec: no .format(), no return at module level, no frappe.get_roles()
- Browser console patching only (no bench migrate access)
- All setup via setup.js v[N] pasted in browser console

LAST COMPLETED:
[Brief description of last session's output]

CURRENT STATE:
[File or script name] is at [version/state]
[Any broken things or known issues]

NEXT TASK:
[Specific thing to do now]

FILES TO READ FIRST:
- [path/to/file.js] — [why it matters]
- [path/to/file.py] — [why it matters]
```

### 2. Standard Frappe Module Context Block

Copy and customize this for the Pump Location Assessment module:

```
PROJECT: Pump Location Assessment (PLA) — Network Sales module
PLATFORM: Frappe v15 on Frappe Cloud
APP DIR: G:\My Drive\VS Folders\Network Sales\

KEY DOCTYPES:
- Network Sales Score (NSS): custom scoring + approval form, submittable
- Linked Lead (LL): standard ERPNext Lead with custom NSS result fields

SERVER SCRIPTS (all live in DB, set via setup.js):
- PLA-SS-NSS-AfterSubmit (v5): DocEvent, After Submit — parallel 3-slot approval routing
- PLA-API-NSS-Decision: API, method pla_nss_record_decision — records approve/reject
- PLA-SS-Daily-Reminder: Scheduler Daily — emails pending approvers
- PLA-API-Score-Calc: API, method pla_calculate_score — server-side score calc

CLIENT SCRIPTS (all live in DB, set via setup.js):
- PLA-CS-NSS-Form (v13): frappe.ui.form.on('Network Sales Score', ...) — form UI, approval panel

CRITICAL CONSTRAINTS:
- safe_exec blocks: .format(), return at module level, frappe.get_roles()
- Use string concatenation: "field_" + str(n) + "_name"
- Use frappe.db.get_all("Has Role", ...) for role lookup
- Use frappe.get_doc() + doc.reload() instead of doc.reload() alone
- No bench migrate — all changes via browser console JS (setup.js)

SETUP SCRIPT: pump_location_assessment_setup.js v28 (1921 lines)
- Creates all DocType fields, workflows, server scripts, client scripts, roles
- Fresh-install only — not idempotent for field migrations

PATCH HISTORY: patches 1-69 + permanent_fix all superseded by setup.js v28
  Only permanent_fix.js still needed (one-time data migration for "ERP User" bug)

APPROVAL FLOW:
NSS DocType: 3 approval slots (approval_1/2/3_role/decision/user/time)
Status field on NSS: Draft → Submitted for Approval → Approved/Rejected
LL field nss_approval_status mirrors NSS status
```

### 3. Quick Context Commands

Ask Claude to read these files at session start:

```
Please read these files to get context before we start:
1. [main setup file] — this is the source of truth for all configurations
2. [specific script being worked on] — current version of the file we're editing
```

### 4. Session End — Save State

At end of each work session, note:

```markdown
## Session Notes — [Date]

### Completed
- [X] [what was done]

### Current State
- [file/script]: v[N], [status: working/broken/untested]

### Next Session
- [ ] [next task]
- [ ] [next task]

### Gotchas Discovered
- [unexpected behavior or constraint found]
```

Save to: `docs/session-notes/YYYY-MM-DD.md`

---

## Context Anchor

- **User:** Solo Process Engineer — works in long sessions, often picks up mid-task after gaps
- **Claude loses all context** between sessions — a good brief saves 10-15 minutes every time
- **Always include constraints** — safe_exec restrictions, access limitations, deployment method
- **"Version" numbers matter** — always specify which version of setup.js / which patch is current
- **One source of truth:** setup.js is the master config file — always read it before suggesting changes
