---
name: frappe-api
description: Use when creating API endpoints, whitelisted Python methods, or Server Scripts (DocEvent, API, Scheduler). Covers security, error handling, and response formatting.
---

Create whitelisted Python API methods or Frappe Server Scripts for use by the frontend, external integrations, or scheduled jobs.

## Pre-Flight Questions

1. **Python file or Server Script?** (Python file in a custom app = versioned, testable. Server Script = stored in DB, hot-editable but harder to version)
2. **Who calls it?** (logged-in user / guest / internal scheduler)
3. **Does it modify data?** (if yes, needs `frappe.db.commit()` or is auto-committed on whitelisted calls)

---

## Step-by-Step Instructions

### 1. Whitelisted Python Method

File: `{app}/{module}/api.py` (or inside the controller)

```python
import frappe
from frappe import _


@frappe.whitelist()
def get_supplier_items(supplier: str) -> list[dict]:
    """
    Returns items linked to a supplier.
    Called from JS: frappe.call({ method: 'app.module.api.get_supplier_items', args: { supplier } })
    """
    # Permission check — always explicit
    if not frappe.has_permission("Item", "read"):
        frappe.throw(_("Not permitted"), frappe.PermissionError)

    return frappe.get_list(
        "Item",
        filters={"default_supplier": supplier, "disabled": 0},
        fields=["name", "item_name", "item_code", "stock_uom"],
        order_by="item_name asc",
        limit=100,
    )


@frappe.whitelist()
def update_request_status(docname: str, status: str) -> dict:
    """Transition a Purchase Request status. Validates allowed transitions."""
    allowed = {"Draft": ["Submitted"], "Submitted": ["Approved", "Rejected"]}

    doc = frappe.get_doc("Purchase Request", docname)

    if not frappe.has_permission("Purchase Request", "write", doc):
        frappe.throw(_("Not permitted"), frappe.PermissionError)

    if status not in allowed.get(doc.status, []):
        frappe.throw(_("Invalid transition: {0} → {1}").format(doc.status, status))

    doc.db_set("status", status, update_modified=True)
    frappe.db.commit()

    return {"success": True, "new_status": status}
```

**Call from JavaScript:**
```javascript
frappe.call({
    method: 'myapp.module.api.update_request_status',
    args: { docname: frm.docname, status: 'Approved' },
    callback(r) {
        if (r.message?.success) frappe.show_alert('Status updated', 3);
    },
    error(r) {
        frappe.msgprint(r.message || 'An error occurred');
    }
});
```

### 2. Guest-Accessible Endpoint

```python
@frappe.whitelist(allow_guest=True)
def public_status_check(token: str) -> dict:
    """Public endpoint — validate token first, never expose internal data."""
    # Always validate guest input rigorously
    if not token or len(token) != 32:
        frappe.throw(_("Invalid token"), frappe.AuthenticationError)

    record = frappe.db.get_value(
        "Request Token",
        {"token": token, "expired": 0},
        ["name", "status", "expires_on"],
        as_dict=True,
    )
    if not record:
        frappe.throw(_("Token not found or expired"), frappe.DoesNotExistError)

    return {"status": record.status}
```

### 3. Server Script — DocType Event

In Frappe UI: Awesome Bar → Server Script → New

```python
# Script Type: DocType Event
# DocType: Purchase Request
# Event: Before Save

if doc.total_amount > 50000 and not doc.approved_by:
    frappe.throw("Orders above ₹50,000 require an approver before saving.")

if not doc.department:
    doc.department = frappe.db.get_value(
        "Employee", {"user_id": frappe.session.user}, "department"
    )
```

### 4. Server Script — API Type

```python
# Script Type: API
# API Method: my_custom_method  (accessible as /api/method/my_custom_method)

record_name = frappe.form_dict.get("name")
if not record_name:
    frappe.throw("name is required")

doc = frappe.get_doc("Purchase Request", record_name)
frappe.response["message"] = {
    "status": doc.status,
    "total": doc.total_amount,
}
```

### 5. Server Script — Scheduler

```python
# Script Type: Scheduler Event
# Frequency: Daily

overdue = frappe.get_list(
    "Purchase Request",
    filters={"status": "Submitted", "required_by": ["<", frappe.utils.today()]},
    fields=["name", "owner", "required_by"],
)

for req in overdue:
    frappe.sendmail(
        recipients=[req.owner],
        subject=f"Overdue Request: {req.name}",
        message=f"Purchase Request {req.name} was due on {req.required_by}.",
        now=True,
    )
```

### 6. Error Handling Patterns

```python
# Validation error (shown to user)
frappe.throw(_("Descriptive message here"), exc=frappe.ValidationError)

# Permission error
frappe.throw(_("Not permitted"), frappe.PermissionError)

# Data not found
frappe.throw(_("Record not found"), frappe.DoesNotExistError)

# Warning (non-blocking)
frappe.msgprint(_("Warning: something may need attention"), indicator="orange")

# Log for debugging (not shown to user)
frappe.log_error(frappe.get_traceback(), "My API Error Context")
```

### 7. Security Checklist

- [ ] Always call `frappe.has_permission()` before reading/writing
- [ ] Never use raw string interpolation in SQL — use `frappe.db.sql` with `%s` params
- [ ] Validate and sanitize all user inputs
- [ ] Guest endpoints (`allow_guest=True`) need extra scrutiny — rate-limit in production
- [ ] Never expose internal usernames, emails, or system paths in error messages

---

## Example

**Input:** "Create a whitelisted API to fetch all open site visits for the logged-in engineer."

**Output:**
```python
@frappe.whitelist()
def get_my_open_visits() -> list[dict]:
    return frappe.get_list(
        "Site Visit Report",
        filters={"engineer": frappe.session.user, "status": "Open"},
        fields=["name", "customer", "visit_date", "status"],
        order_by="visit_date asc",
    )
```

---

## Context Anchor

- **User:** Solo Process Engineer building Frappe/ERPNext tools
- **Security:** Always explicit permission checks — never trust client input
- **Server Scripts:** Stored in DB, hot-editable, but not version-controlled — prefer Python files for production
- **safe_exec restrictions (Server Scripts):** No `.format()`, no `frappe.get_roles()`, no `doc.reload()`, no `__import__`. Use string concatenation, `frappe.db.get_all("Has Role")`, `frappe.get_doc()` instead
- **Use Context7** to verify current Frappe API signatures before generating
