---
name: frappe-fixtures
description: Use when managing fixtures, exporting default data, migrating config records, setting up property setters, or packaging default roles and workflows for deployment.
---

Manage Frappe fixtures — define what gets exported, maintain ordering, handle custom fields, property setters, and ensure idempotent data migration.

## Pre-Flight Questions

1. **What needs to be packaged?** (DocTypes, roles, workflows, custom fields, print formats, etc.)
2. **Any filters?** (export only specific records, not all)
3. **New installation or update?** (new = create defaults, update = check before modifying)

---

## Step-by-Step Instructions

### 1. fixtures in hooks.py

```python
# hooks.py

fixtures = [
    # Export entire DocTypes from a module
    {"dt": "DocType", "filters": [["module", "in", ["Procurement", "My Custom Module"]]]},

    # Export all Custom Fields for specific doctypes
    {"dt": "Custom Field", "filters": [["dt", "in", ["Sales Order", "Purchase Order", "Customer"]]]},

    # Export Property Setters (field property overrides)
    {"dt": "Property Setter", "filters": [["doc_type", "in", ["Sales Order", "Purchase Invoice"]]]},

    # Export all records of a type (no filter = all records)
    "Role",
    "Print Format",
    "Report",

    # Export specific named records
    {"dt": "Workflow", "filters": [["name", "in", ["Purchase Request Approval"]]]},
    "Workflow State",
    "Workflow Action",

    # Export Server and Client Scripts
    {"dt": "Server Script", "filters": [["name", "like", "My App%"]]},
    {"dt": "Client Script", "filters": [["name", "like", "My App%"]]},

    # Export Notification templates
    {"dt": "Notification", "filters": [["module", "=", "Procurement"]]},

    # Export Email Templates
    {"dt": "Email Template", "filters": [["name", "like", "PR %"]]},
]
```

### 2. Export Fixtures

```bash
# Export all fixtures defined in hooks.py
bench --site {site_name} export-fixtures

# The JSON files land in:
# {app}/fixtures/{DocType}/{record_name}.json  (individual records)
# OR
# {app}/fixtures/{doctype}.json               (single file per doctype)
```

### 3. Import Fixtures (on new install / migrate)

Fixtures are imported automatically on:
```bash
bench --site {site_name} migrate
bench --site {site_name} install-app {app_name}
```

Or manually:
```bash
bench --site {site_name} import-doc {app}/fixtures/custom_field.json
```

### 4. Custom Field Fixture (JSON example)

File: `{app}/fixtures/custom_field/custom_sales_order_po_reference.json`

```json
{
  "doctype": "Custom Field",
  "name": "Sales Order-custom_po_reference",
  "dt": "Sales Order",
  "label": "PO Reference",
  "fieldname": "custom_po_reference",
  "fieldtype": "Data",
  "insert_after": "po_no",
  "module": "Procurement",
  "is_system_generated": 0
}
```

> **Note:** Frappe v14+ auto-prefixes custom fields with `custom_`. In v13 and below, name it manually.

### 5. Property Setter Fixture

```json
{
  "doctype": "Property Setter",
  "name": "Sales Order-delivery_date-reqd",
  "doc_type": "Sales Order",
  "field_name": "delivery_date",
  "property": "reqd",
  "property_type": "Check",
  "value": "1",
  "doctype_or_field": "DocField"
}
```

Common `property` values: `reqd`, `hidden`, `read_only`, `options`, `default`, `label`, `description`, `in_list_view`, `bold`

### 6. Role Fixture

```json
{
  "doctype": "Role",
  "name": "Procurement Manager",
  "role_name": "Procurement Manager",
  "desk_access": 1,
  "is_custom": 1
}
```

### 7. After Migrate — Programmatic Defaults

```python
# {app}/setup/after_migrate.py

import frappe


def run():
    """Called after every bench migrate. Must be idempotent."""
    _create_default_cost_centers()
    _set_system_settings()
    _create_default_email_templates()


def _create_default_cost_centers():
    company = frappe.defaults.get_global_default("company")
    if not company:
        return
    name = f"Procurement Default - {frappe.db.get_value('Company', company, 'abbr')}"
    if not frappe.db.exists("Cost Center", name):
        frappe.get_doc({
            "doctype": "Cost Center",
            "cost_center_name": "Procurement Default",
            "is_group": 0,
            "company": company,
            "parent_cost_center": f"Main - {frappe.db.get_value('Company', company, 'abbr')}",
        }).insert(ignore_permissions=True)
        frappe.db.commit()


def _set_system_settings():
    # Use db_set to avoid triggering hooks
    frappe.db.set_single_value("System Settings", "enable_two_factor_auth", 0)


def _create_default_email_templates():
    if frappe.db.exists("Email Template", "Purchase Request Approved"):
        return
    frappe.get_doc({
        "doctype": "Email Template",
        "name": "Purchase Request Approved",
        "subject": "Your Purchase Request {{ doc.name }} has been Approved",
        "response": """
<p>Dear {{ doc.requested_by_name }},</p>
<p>Your Purchase Request <strong>{{ doc.name }}</strong> has been approved.</p>
<p>Total Amount: ₹{{ doc.total_amount }}</p>
        """,
    }).insert(ignore_permissions=True)
    frappe.db.commit()
```

### 8. Fixture Ordering

Frappe imports fixtures in the order listed in `hooks.py`. Dependencies matter:

```python
fixtures = [
    "Role",                    # 1. Roles first (workflows depend on them)
    "Workflow State",          # 2. States before workflows
    "Workflow Action",         # 3. Actions before workflows
    "Workflow",                # 4. Workflows after states/actions
    {"dt": "DocType", ...},    # 5. DocTypes
    {"dt": "Custom Field", ...},  # 6. Custom fields after DocTypes
    {"dt": "Property Setter", ...},
    "Print Format",
    "Report",
    {"dt": "Server Script", ...},
    {"dt": "Client Script", ...},
    "Notification",
]
```

---

## Example

**Input:** "Package the Purchase Request workflow and custom fields for deployment."

**Output in hooks.py:**
```python
fixtures = [
    "Role",
    "Workflow State",
    "Workflow Action",
    {"dt": "Workflow", "filters": [["name", "=", "Purchase Request Approval"]]},
    {"dt": "Custom Field", "filters": [["dt", "=", "Purchase Request"]]},
]
```
Then run `bench export-fixtures`.

---

## Context Anchor

- **User:** Solo Process Engineer — fixtures are the deployment mechanism for configurations
- **Golden rule:** Fixtures must be idempotent — importing twice must not create duplicates or errors
- **Export after every config change** — never manually edit fixture JSON; always export fresh
- **Ordering matters** — Roles before Workflows, DocTypes before Custom Fields
- **`after_migrate`** is the place for programmatic defaults that can't be expressed as JSON fixtures
