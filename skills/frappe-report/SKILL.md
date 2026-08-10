---
name: frappe-report
description: Use when creating Script Reports, Query Reports, or report builders in Frappe. Covers columns, filters, charts, frappe.qb queries, and permissions.
---

Create a complete Frappe report — Script Report (Python) or Query Report (SQL) — with columns, filters, chart configuration, and access permissions.

## Pre-Flight Questions

1. **Script Report or Query Report?** (Script = Python logic, Query = raw SQL)
2. **Which DocType is the primary source?**
3. **What filters does the user need?** (date range, status, department, etc.)
4. **Chart required?** (bar / line / pie)
5. **Who can access it?** (role-based permission)

---

## Step-by-Step Instructions

### 1. Report File Structure

```
{app}/{module}/report/{report_name}/
    {report_name}.json      ← Report definition
    {report_name}.py        ← Python logic (Script Report)
    {report_name}.js        ← Filters and chart config
```

### 2. Report JSON Definition

```json
{
  "doctype": "Report",
  "name": "Purchase Request Summary",
  "report_type": "Script Report",
  "ref_doctype": "Purchase Request",
  "is_standard": "No",
  "module": "Procurement",
  "disabled": 0,
  "roles": [
    {"role": "Purchase Manager"},
    {"role": "System Manager"}
  ]
}
```

`"report_type"` options: `"Script Report"` | `"Query Report"` | `"Report Builder"`

### 3. Script Report — Python

```python
import frappe
from frappe import _
from frappe.utils import getdate


def execute(filters=None):
    """Entry point. Must return (columns, data)."""
    filters = filters or {}
    columns = get_columns()
    data    = get_data(filters)
    chart   = get_chart(data)
    summary = get_summary(data)
    return columns, data, None, chart, summary


def get_columns():
    return [
        {
            "label": _("Request #"),
            "fieldname": "name",
            "fieldtype": "Link",
            "options": "Purchase Request",
            "width": 150,
        },
        {
            "label": _("Date"),
            "fieldname": "request_date",
            "fieldtype": "Date",
            "width": 100,
        },
        {
            "label": _("Requested By"),
            "fieldname": "requested_by",
            "fieldtype": "Link",
            "options": "User",
            "width": 140,
        },
        {
            "label": _("Department"),
            "fieldname": "department",
            "fieldtype": "Link",
            "options": "Department",
            "width": 130,
        },
        {
            "label": _("Status"),
            "fieldname": "status",
            "fieldtype": "Data",
            "width": 110,
        },
        {
            "label": _("Total Amount"),
            "fieldname": "total_amount",
            "fieldtype": "Currency",
            "width": 120,
        },
    ]


def get_data(filters: dict) -> list[dict]:
    conditions = _build_conditions(filters)

    # Use frappe.qb (query builder) for complex queries
    from frappe.query_builder import DocType
    from frappe.query_builder.functions import Sum, Count

    PR = DocType("Purchase Request")

    query = (
        frappe.qb.from_(PR)
        .select(
            PR.name,
            PR.request_date,
            PR.requested_by,
            PR.department,
            PR.status,
            PR.total_amount,
        )
        .where(PR.docstatus < 2)  # exclude cancelled
    )

    if filters.get("from_date"):
        query = query.where(PR.request_date >= getdate(filters["from_date"]))
    if filters.get("to_date"):
        query = query.where(PR.request_date <= getdate(filters["to_date"]))
    if filters.get("department"):
        query = query.where(PR.department == filters["department"])
    if filters.get("status"):
        query = query.where(PR.status == filters["status"])

    return query.orderby(PR.request_date, order=frappe.qb.desc).run(as_dict=True)


def _build_conditions(filters: dict) -> str:
    """Legacy SQL conditions string — prefer frappe.qb above."""
    conditions = ["docstatus < 2"]
    if filters.get("from_date"):
        conditions.append("request_date >= %(from_date)s")
    if filters.get("to_date"):
        conditions.append("request_date <= %(to_date)s")
    return " AND ".join(conditions)


def get_chart(data: list[dict]) -> dict | None:
    if not data:
        return None

    # Group by status for bar chart
    from collections import defaultdict
    by_status = defaultdict(float)
    for row in data:
        by_status[row.get("status", "Unknown")] += float(row.get("total_amount") or 0)

    return {
        "data": {
            "labels": list(by_status.keys()),
            "datasets": [{"values": list(by_status.values())}],
        },
        "type": "bar",       # bar | line | pie | donut | percentage
        "colors": ["#1a3a5c"],
        "fieldtype": "Currency",
    }


def get_summary(data: list[dict]) -> list[dict] | None:
    if not data:
        return None
    total = sum(float(r.get("total_amount") or 0) for r in data)
    return [
        {"label": _("Total Requests"), "value": len(data), "indicator": "blue"},
        {"label": _("Total Value"),    "value": total,     "indicator": "green", "datatype": "Currency"},
    ]
```

### 4. Filters JS File

```javascript
// {report_name}.js
frappe.query_reports["Purchase Request Summary"] = {
    filters: [
        {
            fieldname: "from_date",
            label:     __("From Date"),
            fieldtype: "Date",
            default:   frappe.datetime.month_start(),
            reqd:      1,
        },
        {
            fieldname: "to_date",
            label:     __("To Date"),
            fieldtype: "Date",
            default:   frappe.datetime.month_end(),
            reqd:      1,
        },
        {
            fieldname: "department",
            label:     __("Department"),
            fieldtype: "Link",
            options:   "Department",
        },
        {
            fieldname: "status",
            label:     __("Status"),
            fieldtype: "Select",
            options:   "\nDraft\nPending Approval\nApproved\nRejected",
        },
    ],

    formatter(value, row, column, data, default_formatter) {
        // Colorise the Status column
        if (column.fieldname === "status" && data) {
            const color = {
                "Approved": "green",
                "Rejected": "red",
                "Pending Approval": "orange",
                "Draft": "gray",
            }[data.status] || "gray";
            return `<span style="color:var(--${color})">${value}</span>`;
        }
        return default_formatter(value, row, column, data);
    },
};
```

### 5. Query Report (Raw SQL variant)

```python
def execute(filters=None):
    columns = get_columns()
    data = frappe.db.sql("""
        SELECT
            pr.name,
            pr.request_date,
            pr.requested_by,
            pr.department,
            pr.status,
            pr.total_amount
        FROM `tabPurchase Request` pr
        WHERE
            pr.docstatus < 2
            AND pr.request_date BETWEEN %(from_date)s AND %(to_date)s
            {dept_condition}
        ORDER BY pr.request_date DESC
    """.format(
        dept_condition="AND pr.department = %(department)s" if filters.get("department") else ""
    ), filters, as_dict=True)

    return columns, data
```

---

## Context Anchor

- **User:** Solo Process Engineer — reports are key deliverables for stakeholder visibility
- **`execute(filters)`** must return `(columns, data)` — optionally `(columns, data, message, chart, summary)`
- **`frappe.qb`** is the modern query builder — prefer it over raw SQL for safety
- **Column `fieldtype`** controls formatting: `"Currency"` adds ₹, `"Link"` makes it clickable
- **Chart `type`** options: `bar`, `line`, `pie`, `donut`, `percentage`
- **Summary row** appears at the bottom of the report — use for totals and KPIs
