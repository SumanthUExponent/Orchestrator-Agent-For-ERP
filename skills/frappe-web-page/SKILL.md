---
name: frappe-web-page
description: Use when building portal pages, website routes, customer-facing pages, or public/authenticated web interfaces in Frappe. Covers portal pattern and JS interactivity.
---

Build Frappe web pages — from simple static content pages to authenticated portal pages with data access, forms, and JavaScript interactivity.

## Pre-Flight Questions

1. **Authenticated or public?** (guest vs. logged-in user)
2. **Static content or dynamic data?** (if dynamic, need `get_context` in Python)
3. **Route?** (e.g., `/my-requests`, `/portal/orders/{name}`)
4. **Form submission?** (POST handler needed)

---

## Step-by-Step Instructions

### 1. Simple Web Page (via Frappe UI)

Awesome Bar → Web Page → New

- **Route:** `my-page` → accessible at `{site}/my-page`
- **Content Type:** Markdown / HTML / Page Builder
- Set `Published: 1` and `Show in Navbar: 0/1`

### 2. Portal Page (Custom Route with Python)

File structure in your app:
```
{app}/
  www/
    my-requests.html        ← Jinja template
    my-requests.py          ← Python context provider
    my-requests.js          ← Optional page JS
    my-requests.css         ← Optional page CSS
```

**Python context file (`my-requests.py`):**
```python
import frappe
from frappe import _


# Controls who can access this page
def get_context(context):
    # Redirect unauthenticated users to login
    if frappe.session.user == "Guest":
        frappe.local.flags.redirect_location = "/login?redirect-to=/my-requests"
        raise frappe.Redirect

    context.no_cache = 1    # Don't cache this page
    context.title = _("My Requests")

    # Fetch data for the current user
    context.requests = frappe.get_list(
        "Purchase Request",
        filters={"owner": frappe.session.user},
        fields=["name", "status", "total_amount", "creation"],
        order_by="creation desc",
        limit=50,
    )

    context.pending_count = frappe.db.count(
        "Purchase Request",
        {"owner": frappe.session.user, "status": "Pending Approval"},
    )


# Handle POST form submission
def get_context_on_post(context):
    action = frappe.form_dict.get("action")
    name   = frappe.form_dict.get("name")

    if action == "cancel" and name:
        doc = frappe.get_doc("Purchase Request", name)
        if doc.owner != frappe.session.user:
            frappe.throw(_("Not permitted"), frappe.PermissionError)
        doc.cancel()
        frappe.db.commit()
        frappe.local.flags.redirect_location = "/my-requests?cancelled=1"
        raise frappe.Redirect
```

**HTML Template (`my-requests.html`):**
```html
{% extends "templates/web.html" %}

{% block page_content %}
<div class="container my-4">

  {# Page title #}
  <div class="d-flex justify-content-between align-items-center mb-4">
    <h2>{{ title }}</h2>
    <a href="/purchase-request/new" class="btn btn-primary btn-sm">
      + New Request
    </a>
  </div>

  {# Flash message #}
  {% if frappe.form_dict.get("cancelled") %}
  <div class="alert alert-success">Request cancelled successfully.</div>
  {% endif %}

  {# Stats bar #}
  <div class="row mb-4">
    <div class="col-md-3">
      <div class="card text-center p-3">
        <div class="h3">{{ pending_count }}</div>
        <div class="text-muted small">Pending Approval</div>
      </div>
    </div>
    <div class="col-md-3">
      <div class="card text-center p-3">
        <div class="h3">{{ requests | length }}</div>
        <div class="text-muted small">Total Requests</div>
      </div>
    </div>
  </div>

  {# Requests table #}
  {% if requests %}
  <div class="table-responsive">
    <table class="table table-hover">
      <thead class="thead-light">
        <tr>
          <th>Request #</th>
          <th>Date</th>
          <th>Amount</th>
          <th>Status</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {% for req in requests %}
        <tr>
          <td>
            <a href="/purchase-request/{{ req.name }}">
              {{ req.name }}
            </a>
          </td>
          <td>{{ frappe.format_date(req.creation) }}</td>
          <td>₹{{ "{:,.0f}".format(req.total_amount or 0) }}</td>
          <td>
            <span class="badge badge-{{
              'success' if req.status == 'Approved'
              else 'danger' if req.status == 'Rejected'
              else 'warning' if req.status == 'Pending Approval'
              else 'secondary'
            }}">
              {{ req.status }}
            </span>
          </td>
          <td>
            {% if req.status == 'Draft' %}
            <form method="POST" style="display:inline">
              <input type="hidden" name="action" value="cancel">
              <input type="hidden" name="name" value="{{ req.name }}">
              <button type="submit" class="btn btn-sm btn-outline-danger"
                onclick="return confirm('Cancel this request?')">
                Cancel
              </button>
            </form>
            {% endif %}
          </td>
        </tr>
        {% endfor %}
      </tbody>
    </table>
  </div>

  {% else %}
  <div class="text-center py-5 text-muted">
    <div class="mb-3" style="font-size:2rem">📋</div>
    <p>No requests yet. <a href="/purchase-request/new">Create your first request.</a></p>
  </div>
  {% endif %}

</div>
{% endblock %}
```

### 3. Detail Page with URL Parameter

```
www/
  purchase-request.html
  purchase-request.py
```

**Python (`purchase-request.py`):**
```python
import frappe
from frappe import _


def get_context(context):
    if frappe.session.user == "Guest":
        frappe.local.flags.redirect_location = "/login"
        raise frappe.Redirect

    name = frappe.form_dict.get("name") or frappe.request.path.split("/")[-1]
    if not name or name == "new":
        context.is_new = True
        context.title = "New Purchase Request"
        return

    try:
        doc = frappe.get_doc("Purchase Request", name)
    except frappe.DoesNotExistError:
        frappe.throw(_("Request not found"), frappe.DoesNotExistError)

    if doc.owner != frappe.session.user and not frappe.has_permission("Purchase Request", "read", doc):
        frappe.throw(_("Not permitted"), frappe.PermissionError)

    context.doc = doc
    context.title = f"Request {doc.name}"
```

### 4. Interactive JS (`my-requests.js`)

```javascript
frappe.ready(function () {
    // Use frappe.call for AJAX to your whitelisted APIs
    document.querySelector('#refresh-btn')?.addEventListener('click', function () {
        frappe.call({
            method: 'myapp.api.get_my_requests',
            callback(r) {
                if (r.message) renderTable(r.message);
            }
        });
    });

    function renderTable(rows) {
        const tbody = document.querySelector('#requests-tbody');
        if (!tbody) return;
        tbody.innerHTML = rows.map(r => `
            <tr>
                <td><a href="/purchase-request/${r.name}">${r.name}</a></td>
                <td>${r.status}</td>
            </tr>
        `).join('');
    }
});
```

---

## Context Anchor

- **User:** Solo Process Engineer — builds internal tools and portals for business operations
- **Auth pattern:** Always check `frappe.session.user == "Guest"` and redirect first
- **`get_context`** runs on GET; **`get_context_on_post`** runs on POST form submissions
- **Template inheritance:** `{% extends "templates/web.html" %}` uses Frappe's base portal template
- **URL routing:** File name = URL path. `www/my-page.html` → `/my-page`
- **UI principle:** Simple enough for a caveman, beautiful enough to impress a stakeholder
