---
name: frappe-ui-page
description: Use when building custom desk pages, dashboards, admin panels, or single-page apps in Frappe. Covers Page boilerplate, DataTable, frappe.Chart, realtime, and sidebar navigation.
---

Build a custom Frappe desk page — JavaScript + Python — with sidebar navigation, DataTable, charts, and real-time updates. Aim for caveman-simple UI, robust logic.

## Pre-Flight Questions

1. **Purpose?** (dashboard, data entry form, admin panel, monitoring screen)
2. **Data source?** (DocType query, aggregated report, external API)
3. **Chart needed?** (bar / line / pie)
4. **Real-time updates?** (yes = frappe.realtime; no = on-demand refresh)
5. **Who can see it?** (role-based access)

---

## Step-by-Step Instructions

### 1. File Structure

```
{app}/{module}/page/{page_name}/
    {page_name}.json        ← Page definition
    {page_name}.js          ← All UI logic
    {page_name}.py          ← Optional Python helper (whitelisted methods)
```

### 2. Page JSON Definition

```json
{
  "doctype": "Page",
  "name": "procurement-dashboard",
  "page_name": "procurement-dashboard",
  "title": "Procurement Dashboard",
  "module": "Procurement",
  "standard": "No",
  "system_page": 0,
  "roles": [
    {"role": "Purchase Manager"},
    {"role": "System Manager"}
  ]
}
```

### 3. Page JS Boilerplate

```javascript
// procurement_dashboard.js
frappe.pages['procurement-dashboard'].on_page_load = function (wrapper) {
    const page = frappe.ui.make_app_page({
        parent:    wrapper,
        title:     'Procurement Dashboard',
        single_column: false,   // true = no sidebar
    });

    // ── SIDEBAR FILTERS ───────────────────────────────────────
    const from_date = page.add_field({
        fieldtype: 'Date',
        fieldname: 'from_date',
        label:     'From',
        default:   frappe.datetime.month_start(),
        change() { refresh(); },
    });

    const to_date = page.add_field({
        fieldtype: 'Date',
        fieldname: 'to_date',
        label:     'To',
        default:   frappe.datetime.month_end(),
        change() { refresh(); },
    });

    const dept_filter = page.add_field({
        fieldtype: 'Link',
        fieldname: 'department',
        label:     'Department',
        options:   'Department',
        change() { refresh(); },
    });

    // ── HEADER BUTTON ─────────────────────────────────────────
    page.add_inner_button('Export', () => export_data());
    page.set_primary_action('Refresh', () => refresh(), 'refresh');

    // ── MAIN AREA ─────────────────────────────────────────────
    $(wrapper).find('.layout-main-section').html(`
        <div id="proc-summary" class="row mb-4"></div>
        <div class="row">
            <div class="col-md-8">
                <div class="frappe-card p-3 mb-3">
                    <div class="card-title text-muted small mb-2">REQUESTS BY STATUS</div>
                    <div id="proc-chart" style="height:250px"></div>
                </div>
                <div class="frappe-card p-3">
                    <div class="card-title text-muted small mb-2">RECENT REQUESTS</div>
                    <div id="proc-table"></div>
                </div>
            </div>
            <div class="col-md-4">
                <div class="frappe-card p-3 mb-3">
                    <div class="card-title text-muted small mb-2">PENDING APPROVAL</div>
                    <div id="proc-pending"></div>
                </div>
            </div>
        </div>
    `);

    // ── STATE ─────────────────────────────────────────────────
    let chart_instance = null;
    let table_instance = null;

    // ── REFRESH ───────────────────────────────────────────────
    async function refresh() {
        frappe.show_progress('Loading…', 0, 100);
        try {
            const filters = {
                from_date: from_date.get_value(),
                to_date:   to_date.get_value(),
                department: dept_filter.get_value() || null,
            };

            const r = await frappe.call({
                method: 'myapp.procurement.page.procurement_dashboard.procurement_dashboard.get_data',
                args:   { filters },
            });

            const d = r.message || {};
            render_summary(d.summary || []);
            render_chart(d.by_status || []);
            render_table(d.records || []);
            render_pending(d.pending || []);
        } catch (e) {
            frappe.msgprint({ title: 'Error', indicator: 'red', message: e.message || 'Failed to load data.' });
        } finally {
            frappe.hide_progress();
        }
    }

    // ── SUMMARY TILES ─────────────────────────────────────────
    function render_summary(items) {
        $('#proc-summary').html(
            items.map(item => `
                <div class="col-md-3">
                    <div class="frappe-card text-center p-3">
                        <div class="h3 text-${item.color || 'primary'}">${item.value}</div>
                        <div class="text-muted small">${item.label}</div>
                    </div>
                </div>
            `).join('')
        );
    }

    // ── CHART ─────────────────────────────────────────────────
    function render_chart(by_status) {
        if (chart_instance) {
            chart_instance.update({ labels: by_status.map(r => r.status), datasets: [{ values: by_status.map(r => r.count) }] });
            return;
        }
        chart_instance = new frappe.Chart('#proc-chart', {
            type:     'bar',
            data: {
                labels:   by_status.map(r => r.status),
                datasets: [{ values: by_status.map(r => r.count) }],
            },
            colors:   ['#1a3a5c'],
            height:   220,
            axisOptions: { xIsSeries: false },
        });
    }

    // ── DATATABLE ─────────────────────────────────────────────
    function render_table(records) {
        const columns = [
            { name: 'Request #',    id: 'name',          width: 150, format: v => `<a href="/app/purchase-request/${v}">${v}</a>` },
            { name: 'Date',         id: 'request_date',  width: 100 },
            { name: 'Department',   id: 'department',    width: 130 },
            { name: 'Status',       id: 'status',        width: 130 },
            { name: 'Total (₹)',    id: 'total_amount',  width: 120, align: 'right' },
        ];

        if (table_instance) {
            table_instance.refresh(records);
            return;
        }

        table_instance = new frappe.DataTable('#proc-table', {
            columns,
            data:            records,
            noDataMessage:   'No requests found.',
            dynamicRowHeight: true,
            inlineFilters:   true,
        });
    }

    // ── PENDING LIST ──────────────────────────────────────────
    function render_pending(items) {
        if (!items.length) {
            $('#proc-pending').html('<div class="text-muted small py-3 text-center">No pending approvals</div>');
            return;
        }
        $('#proc-pending').html(`
            <ul class="list-unstyled mb-0">
                ${items.map(r => `
                    <li class="border-bottom py-2">
                        <a href="/app/purchase-request/${r.name}" class="font-weight-bold">${r.name}</a>
                        <div class="text-muted small">${r.owner} · ₹${frappe.format(r.total_amount, { fieldtype: 'Currency' })}</div>
                    </li>
                `).join('')}
            </ul>
        `);
    }

    // ── EXPORT ────────────────────────────────────────────────
    function export_data() {
        if (!table_instance) return;
        table_instance.export('CSV');
    }

    // ── REALTIME ──────────────────────────────────────────────
    frappe.realtime.on('procurement_update', () => refresh());

    // ── INITIAL LOAD ──────────────────────────────────────────
    refresh();
};
```

### 4. Python Backend (`procurement_dashboard.py`)

```python
import frappe
from frappe import _
from frappe.utils import getdate


@frappe.whitelist()
def get_data(filters=None):
    filters = frappe.parse_json(filters) if isinstance(filters, str) else (filters or {})

    from_date  = getdate(filters.get("from_date") or frappe.utils.month_start())
    to_date    = getdate(filters.get("to_date")   or frappe.utils.month_end())
    department = filters.get("department")

    conditions = "pr.docstatus < 2 AND pr.request_date BETWEEN %(from_date)s AND %(to_date)s"
    params     = {"from_date": from_date, "to_date": to_date}

    if department:
        conditions += " AND pr.department = %(department)s"
        params["department"] = department

    records = frappe.db.sql(f"""
        SELECT pr.name, pr.request_date, pr.department, pr.status,
               pr.owner, pr.total_amount
        FROM `tabPurchase Request` pr
        WHERE {conditions}
        ORDER BY pr.request_date DESC
        LIMIT 100
    """, params, as_dict=True)

    by_status = frappe.db.sql(f"""
        SELECT pr.status, COUNT(*) as count
        FROM `tabPurchase Request` pr
        WHERE {conditions}
        GROUP BY pr.status
    """, params, as_dict=True)

    pending = frappe.db.sql(f"""
        SELECT pr.name, pr.owner, pr.total_amount
        FROM `tabPurchase Request` pr
        WHERE pr.status = 'Pending Approval' AND {conditions}
        ORDER BY pr.request_date
        LIMIT 10
    """, params, as_dict=True)

    total_val = sum(r.total_amount or 0 for r in records)
    approved  = sum(1 for r in records if r.status == "Approved")

    return {
        "summary": [
            {"label": _("Total Requests"), "value": len(records),   "color": "primary"},
            {"label": _("Total Value ₹"),  "value": f"{total_val:,.0f}", "color": "success"},
            {"label": _("Approved"),        "value": approved,        "color": "success"},
            {"label": _("Pending"),         "value": len(pending),    "color": "warning"},
        ],
        "records":   records,
        "by_status": by_status,
        "pending":   pending,
    }
```

### 5. Emit Realtime Event (Server Script / Python)

```python
# After a status change on Purchase Request
frappe.publish_realtime(
    event    = "procurement_update",
    message  = {"name": doc.name},
    room     = "procurement-dashboard",   # OR use user= or doctype= targeting
    after_commit = True,
)
```

---

## Context Anchor

- **User:** Solo Process Engineer — builds internal tools for stakeholders who are not technical
- **"caveman-simple, robust logic":** One big button for the most common action; show numbers, not tables by default
- **`frappe.ui.make_app_page`** — use `single_column: true` for full-width layouts (no sidebar filters)
- **`page.add_field`** — sidebar filter fields; changes should trigger `refresh()`
- **`frappe.DataTable`** — built-in, no external libs needed; supports inline filters and CSV export
- **`frappe.Chart`** — built-in chart library; `type` options: `bar`, `line`, `pie`, `donut`, `heatmap`
- **`frappe.realtime.on`** — subscribe to server events; always emit with `after_commit: True` on server side
- **Python must be whitelisted** — `@frappe.whitelist()` is required for `frappe.call()` to reach it
