---
name: frappe-doctype
description: Use when creating a new DocType, adding fields to an existing DocType, or modeling a data entity. Scaffolds JSON, Python controller, permissions, and fixtures.
---

Scaffold a complete Frappe DocType — JSON definition, Python controller with lifecycle hooks, permissions matrix, and optional fixtures entry.

## Pre-Flight Questions (ask before generating)

1. **Is this DocType submittable?** (triggers `on_submit`, `on_cancel`, `on_amend` hooks and adds `docstatus`)
2. **Does it need a Frappe Workflow?** (if yes, invoke `/frappe-workflow` after this)
3. **Is it a Single?** (singleton — one record, no list view)
4. **Is it a Child Table?** (`istable: 1`, used inside a parent DocType)
5. **Naming rule?** (Autoname: `naming_series`, field value, `hash`, or manual)

---

## Step-by-Step Instructions

### 1. Generate the DocType JSON

File: `{app}/{module}/doctype/{doctype_name}/{doctype_name}.json`

```json
{
  "name": "Purchase Request",
  "module": "Procurement",
  "doctype": "DocType",
  "is_submittable": 1,
  "issingle": 0,
  "istable": 0,
  "custom": 0,
  "autoname": "naming_series:",
  "naming_series": "PROC-REQ-.YYYY.-",
  "title_field": "item_name",
  "track_changes": 1,
  "track_seen": 1,
  "fields": [...],
  "permissions": [...],
  "actions": [],
  "links": []
}
```

**Field object pattern:**
```json
{
  "fieldname": "item_name",
  "fieldtype": "Data",
  "label": "Item Name",
  "reqd": 1,
  "in_list_view": 1,
  "bold": 0,
  "no_copy": 0,
  "read_only": 0,
  "hidden": 0,
  "set_only_once": 0,
  "allow_on_submit": 0,
  "translatable": 0,
  "idx": 1
}
```

See `references/field-types.md` for the full field type quick-reference.

**Link field pattern:**
```json
{
  "fieldname": "supplier",
  "fieldtype": "Link",
  "label": "Supplier",
  "options": "Supplier",
  "reqd": 1
}
```

**Child Table field pattern:**
```json
{
  "fieldname": "items",
  "fieldtype": "Table",
  "label": "Items",
  "options": "Purchase Request Item"
}
```

**Select field pattern:**
```json
{
  "fieldname": "priority",
  "fieldtype": "Select",
  "label": "Priority",
  "options": "Low\nMedium\nHigh\nCritical",
  "default": "Medium"
}
```

### 2. Permissions Matrix

```json
"permissions": [
  {
    "role": "System Manager",
    "read": 1, "write": 1, "create": 1,
    "delete": 1, "submit": 1, "cancel": 1, "amend": 1
  },
  {
    "role": "Purchase User",
    "read": 1, "write": 1, "create": 1,
    "delete": 0, "submit": 1, "cancel": 0, "amend": 0
  },
  {
    "role": "Purchase Manager",
    "read": 1, "write": 1, "create": 1,
    "delete": 1, "submit": 1, "cancel": 1, "amend": 1
  }
]
```

### 3. Python Controller

File: `{app}/{module}/doctype/{doctype_name}/{doctype_name}.py`

```python
import frappe
from frappe.model.document import Document


class PurchaseRequest(Document):
    # Called on save (both insert and update)
    def validate(self):
        self.validate_mandatory_fields()
        self.calculate_totals()

    # Called before insert only
    def before_insert(self):
        self.set_defaults()

    # Called before save (both insert and update)
    def before_save(self):
        pass

    # Called after insert
    def after_insert(self):
        pass

    # Called when submitted (docstatus 0 → 1)
    def on_submit(self):
        self.update_linked_records(status="Submitted")

    # Called when cancelled (docstatus 1 → 2)
    def on_cancel(self):
        self.update_linked_records(status="Cancelled")

    # Called when amended (creates a new doc from cancelled)
    def on_amend(self):
        pass

    # ---------- helpers ----------

    def validate_mandatory_fields(self):
        if not self.supplier:
            frappe.throw(frappe._("Supplier is mandatory"))

    def calculate_totals(self):
        total = sum(row.amount for row in self.get("items") or [])
        self.total_amount = total

    def set_defaults(self):
        if not self.requested_by:
            self.requested_by = frappe.session.user

    def update_linked_records(self, status):
        pass
```

### 4. Fixtures Entry (optional)

If this DocType should be exported as a fixture, add to `hooks.py`:

```python
fixtures = [
    {"dt": "DocType", "filters": [["module", "in", ["Procurement"]]]},
]
```

Export: `bench --site {site} export-fixtures`

### 5. Run After Creating

```bash
bench --site {site} migrate
bench --site {site} clear-cache
```

---

## Example

**Input:** "Create a DocType called `Site Visit Report` with fields: site name (Link to Customer), visit date, engineer name, status (Open/In Progress/Closed), notes. Submittable."

**Output structure:**
- `site_visit_report.json` — DocType with 5 fields, is_submittable=1
- `site_visit_report.py` — controller with `on_submit` updating Customer status
- Permissions: System Manager (full), Site Engineer (create/write/submit)

---

## Context Anchor

- **User:** Solo Process Engineer building custom Frappe/ERPNext tools
- **Stack:** Frappe Framework + ERPNext (always use Context7 for current API docs)
- **UI Rule:** Simple enough for a caveman, robust for every edge case
- **Always check:** Is it submittable? Does it need a workflow? What's the naming rule?
- **After generating:** Run `bench migrate` + `bench clear-cache`
- **Reference:** See `references/field-types.md` for all field types
