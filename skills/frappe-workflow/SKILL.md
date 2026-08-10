---
name: frappe-workflow
description: Use when designing approval flows, state machines, or multi-step processes with role-based transitions in Frappe. Generates Workflow JSON and supporting code.
---

Design and generate a complete Frappe Workflow — states, transitions, role permissions, email notifications, and auto-assignment logic.

## Pre-Flight Questions

1. **Which DocType?** (must be submittable if workflow involves Submit/Cancel)
2. **List all states** — draw them out: Draft → Pending Approval → Approved / Rejected
3. **Who transitions each state?** (which Role can move from State A to State B)
4. **Email on transition?** (yes/no for each key transition)
5. **Auto-assign approver?** (assign to specific user or role automatically)

---

## Step-by-Step Instructions

### 1. Add `workflow_state` Field to DocType

```json
{
  "fieldname": "workflow_state",
  "fieldtype": "Link",
  "label": "Status",
  "options": "Workflow State",
  "read_only": 1,
  "in_list_view": 1,
  "bold": 1,
  "no_copy": 1,
  "print_hide": 1
}
```

> **Note:** Frappe adds this automatically when you create a Workflow via UI, but include it in JSON for fixture-based setups.

### 2. Workflow JSON Structure

File: `{app}/fixtures/workflow/{workflow_name}.json` (or export via UI)

```json
{
  "doctype": "Workflow",
  "name": "Purchase Request Approval",
  "document_type": "Purchase Request",
  "workflow_state_field": "workflow_state",
  "is_active": 1,
  "send_email_alert": 1,
  "states": [
    {
      "state": "Draft",
      "doc_status": "0",
      "allow_edit": "Purchase User",
      "style": "Warning",
      "message": null
    },
    {
      "state": "Pending Approval",
      "doc_status": "0",
      "allow_edit": "Purchase Manager",
      "style": "Primary",
      "message": "Awaiting manager approval."
    },
    {
      "state": "Approved",
      "doc_status": "1",
      "allow_edit": "",
      "style": "Success",
      "message": null
    },
    {
      "state": "Rejected",
      "doc_status": "0",
      "allow_edit": "Purchase User",
      "style": "Danger",
      "message": "Rejected — revise and resubmit."
    },
    {
      "state": "Cancelled",
      "doc_status": "2",
      "allow_edit": "",
      "style": "Danger",
      "message": null
    }
  ],
  "transitions": [
    {
      "state": "Draft",
      "action": "Submit for Approval",
      "next_state": "Pending Approval",
      "allowed": "Purchase User",
      "allow_self_approval": 1,
      "condition": null
    },
    {
      "state": "Pending Approval",
      "action": "Approve",
      "next_state": "Approved",
      "allowed": "Purchase Manager",
      "allow_self_approval": 0,
      "condition": "doc.total_amount <= 100000"
    },
    {
      "state": "Pending Approval",
      "action": "Reject",
      "next_state": "Rejected",
      "allowed": "Purchase Manager",
      "allow_self_approval": 0,
      "condition": null
    },
    {
      "state": "Rejected",
      "action": "Revise and Resubmit",
      "next_state": "Draft",
      "allowed": "Purchase User",
      "allow_self_approval": 1,
      "condition": null
    },
    {
      "state": "Approved",
      "action": "Cancel",
      "next_state": "Cancelled",
      "allowed": "Purchase Manager",
      "allow_self_approval": 0,
      "condition": null
    }
  ]
}
```

**`doc_status` values:**
- `"0"` = Draft/Saved
- `"1"` = Submitted
- `"2"` = Cancelled

**`style` values:** `"Warning"` | `"Primary"` | `"Success"` | `"Danger"` | `"Inverse"` | `"Info"`

### 3. Email Notification on State Change

In Frappe UI: Awesome Bar → Notification → New

Or in Python (hooks.py doc_events → `on_workflow_action`):

```python
# hooks.py
doc_events = {
    "Purchase Request": {
        "on_workflow_action": "myapp.handlers.purchase_request.on_workflow_action",
    }
}
```

```python
# handlers/purchase_request.py
import frappe
from frappe import _


def on_workflow_action(doc, method=None):
    action = frappe.get_value(
        "Workflow Action",
        {"reference_doctype": doc.doctype, "reference_name": doc.name, "status": "Open"},
        "workflow_action_name",
    )

    if doc.workflow_state == "Pending Approval":
        _notify_approvers(doc)
    elif doc.workflow_state == "Approved":
        _notify_requestor(doc, approved=True)
    elif doc.workflow_state == "Rejected":
        _notify_requestor(doc, approved=False)


def _notify_approvers(doc):
    approvers = frappe.get_list(
        "Has Role",
        filters={"role": "Purchase Manager", "parenttype": "User"},
        fields=["parent"],
    )
    recipients = [a.parent for a in approvers if a.parent != "Guest"]
    if recipients:
        frappe.sendmail(
            recipients=recipients,
            subject=f"Approval Required: {doc.name}",
            message=frappe.render_template(
                "myapp/templates/emails/approval_required.html",
                {"doc": doc},
            ),
            now=False,  # False = queued, True = immediate
        )


def _notify_requestor(doc, approved: bool):
    if not doc.owner:
        return
    status = "Approved" if approved else "Rejected"
    frappe.sendmail(
        recipients=[doc.owner],
        subject=f"Purchase Request {status}: {doc.name}",
        message=f"Your request {doc.name} has been {status.lower()}.",
        now=False,
    )
```

### 4. Conditional Transition (condition field)

The `condition` field in a transition is a Python expression evaluated server-side:

```
doc.total_amount <= 100000
doc.department == "Engineering" and doc.priority == "High"
frappe.session.user == doc.requested_by
```

### 5. Workflow Auto-Assignment

```python
# hooks.py
doc_events = {
    "Purchase Request": {
        "before_workflow_action": "myapp.handlers.purchase_request.before_workflow_action",
    }
}
```

```python
def before_workflow_action(doc, method=None):
    """Auto-assign approver based on department before 'Submit for Approval' action."""
    if doc.workflow_state == "Draft":
        dept_head = frappe.db.get_value(
            "Department", doc.department, "department_head"
        )
        if dept_head:
            doc.approver = dept_head
```

### 6. Fixtures Export

Add to `hooks.py`:
```python
fixtures = [
    "Workflow",
    "Workflow State",
    "Workflow Action",
]
```

Then: `bench --site {site} export-fixtures`

---

## Example

**Input:** "3-state approval for Leave Application: Draft → HR Review → Approved/Rejected. HR Manager approves."

**Output:** Workflow JSON with 4 states (Draft, HR Review, Approved, Rejected), 3 transitions, email notification handler stub.

---

## Context Anchor

- **User:** Solo Process Engineer — models business processes, then builds them in Frappe
- **Key rule:** `doc_status: "1"` means the document is Submitted — use only for final approved states
- **allow_self_approval: 0** — requestor cannot approve their own request
- **Condition field** is Python evaluated server-side, has access to `doc` and `frappe`
- **Always include** a Rejected → Draft "Revise" transition so requestors can correct and resubmit
- **Fixtures** must be exported after any workflow change: `bench export-fixtures`
