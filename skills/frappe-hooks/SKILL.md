---
name: frappe-hooks
description: Use when modifying hooks.py, adding scheduler events, overriding ERPNext methods, extending boot session, or registering fixtures and jinja globals.
---

Generate correct `hooks.py` entries and matching Python handler stubs for every Frappe hook type.

## Pre-Flight Questions

1. **Which hook type?** (doc_events / scheduler / override / boot / fixtures / jinja / website)
2. **Is it overriding ERPNext core behavior or adding new behavior?**
3. **Which app's hooks.py?** (get the app name first)

---

## Step-by-Step Instructions

### 1. hooks.py Skeleton

File: `{app}/hooks.py`

```python
from . import __version__ as app_version

app_name = "myapp"
app_title = "My App"
app_publisher = "Your Name"
app_description = "Description"
app_email = "you@example.com"
app_license = "MIT"

# ------- Document Events -------
doc_events = {
    "Sales Order": {
        "on_submit": "myapp.handlers.sales_order.on_submit",
        "on_cancel": "myapp.handlers.sales_order.on_cancel",
        "validate":  "myapp.handlers.sales_order.validate",
    },
    "Purchase Invoice": {
        "before_save": "myapp.handlers.purchase_invoice.before_save",
    },
}

# ------- Scheduler Events -------
scheduler_events = {
    "all":        ["myapp.tasks.run_every_minute"],
    "hourly":     ["myapp.tasks.run_hourly"],
    "daily":      ["myapp.tasks.run_daily"],
    "weekly":     ["myapp.tasks.run_weekly"],
    "monthly":    ["myapp.tasks.run_monthly"],
    "daily_long": ["myapp.tasks.run_daily_long"],   # longer timeout
    "cron": {
        "0 9 * * 1-5": ["myapp.tasks.run_weekday_morning"],  # 9am weekdays
    },
}

# ------- Override Whitelisted Methods -------
override_whitelisted_methods = {
    "erpnext.accounts.doctype.payment_entry.payment_entry.get_payment_entry":
        "myapp.overrides.payment_entry.get_payment_entry",
}

# ------- Boot Session (data sent to every browser session) -------
boot_session = "myapp.startup.boot_session"

# ------- Website Context -------
website_context = {
    "favicon": "/assets/myapp/images/favicon.ico",
    "splash_image": "/assets/myapp/images/splash.png",
}

# ------- Jinja Globals -------
jinja = {
    "methods": [
        "myapp.utils.jinja.format_currency_inr",
        "myapp.utils.jinja.get_company_address",
    ],
    "filters": [
        "myapp.utils.jinja.nl2br",
    ],
}

# ------- Fixtures -------
fixtures = [
    {"dt": "Custom Field",    "filters": [["dt", "in", ["Sales Order", "Purchase Order"]]]},
    {"dt": "Property Setter", "filters": [["doc_type", "in", ["Sales Order"]]]},
    {"dt": "DocType",         "filters": [["module", "in", ["My Module"]]]},
    "Role",
    "Workflow",
    "Workflow State",
    "Workflow Action",
    "Print Format",
    "Report",
    "Server Script",
    "Client Script",
]

# ------- After Migrate -------
after_migrate = ["myapp.setup.after_migrate.run"]

# ------- Overrides (class-level) -------
override_doctype_class = {
    "Sales Order": "myapp.overrides.sales_order.CustomSalesOrder",
}

# ------- App Include JS/CSS -------
app_include_js = ["/assets/myapp/js/myapp.min.js"]
app_include_css = ["/assets/myapp/css/myapp.min.css"]

# ------- Web Include -------
web_include_js = ["/assets/myapp/js/myapp_web.js"]
web_include_css = ["/assets/myapp/css/myapp_web.css"]
```

### 2. Handler Function Stub

File: `{app}/handlers/sales_order.py`

```python
import frappe
from frappe import _


def validate(doc, method=None):
    """Called before every save on Sales Order."""
    _check_credit_limit(doc)


def on_submit(doc, method=None):
    """Called when Sales Order is submitted."""
    _create_procurement_request(doc)


def on_cancel(doc, method=None):
    """Called when Sales Order is cancelled."""
    _cancel_linked_requests(doc)


def _check_credit_limit(doc):
    limit = frappe.db.get_value("Customer", doc.customer, "credit_limit") or 0
    if doc.grand_total > limit > 0:
        frappe.msgprint(
            _("Warning: Order total exceeds credit limit for {0}").format(doc.customer),
            indicator="orange",
        )


def _create_procurement_request(doc):
    pass  # TODO


def _cancel_linked_requests(doc):
    pass  # TODO
```

### 3. Boot Session Handler

File: `{app}/startup.py`

```python
import frappe


def boot_session(bootinfo):
    """
    Adds data to the boot payload sent to every browser session.
    Access in JS as: frappe.boot.my_key
    """
    bootinfo.my_custom_config = {
        "feature_flag_x": True,
        "support_email": "support@example.com",
    }

    if frappe.session.user != "Guest":
        bootinfo.my_pending_tasks = frappe.get_list(
            "Task",
            filters={"assigned_to": frappe.session.user, "status": "Open"},
            fields=["name", "subject"],
            limit=10,
        )
```

### 4. Jinja Globals

File: `{app}/utils/jinja.py`

```python
import frappe


def format_currency_inr(value) -> str:
    """Usage in Jinja: {{ doc.amount | format_currency_inr }}"""
    return "₹{:,.2f}".format(float(value or 0))


def get_company_address(company: str) -> str:
    addr = frappe.db.get_value(
        "Address",
        {"is_primary_address": 1, "link_name": company},
        "address_line1",
    )
    return addr or ""


def nl2br(value: str) -> str:
    """Convert newlines to <br> in Jinja templates."""
    if not value:
        return ""
    return value.replace("\n", "<br>")
```

### 5. Override DocType Class

File: `{app}/overrides/sales_order.py`

```python
from erpnext.selling.doctype.sales_order.sales_order import SalesOrder


class CustomSalesOrder(SalesOrder):
    def validate(self):
        super().validate()          # always call super first
        self.custom_validation()

    def custom_validation(self):
        if self.custom_po_required and not self.po_no:
            frappe.throw("PO Number is required for this customer.")
```

### 6. After Migrate

File: `{app}/setup/after_migrate.py`

```python
import frappe


def run():
    """Runs after every bench migrate. Idempotent — safe to run multiple times."""
    _create_default_records()
    _set_property_setters()


def _create_default_records():
    if not frappe.db.exists("Cost Center", "Custom Default - MC"):
        frappe.get_doc({
            "doctype": "Cost Center",
            "cost_center_name": "Custom Default",
            "company": frappe.defaults.get_global_default("company"),
        }).insert(ignore_permissions=True)


def _set_property_setters():
    pass
```

---

## Example

**Input:** "Add a doc event so that when a Sales Invoice is submitted, it creates a custom Delivery Confirmation record."

**Output in hooks.py:**
```python
doc_events = {
    "Sales Invoice": {
        "on_submit": "myapp.handlers.sales_invoice.on_submit",
    }
}
```
**Plus** handler stub in `myapp/handlers/sales_invoice.py`.

---

## Context Anchor

- **User:** Solo Process Engineer — builds Frappe/ERPNext custom apps
- **Key rule:** Handler functions always accept `(doc, method=None)` signature
- **Override order:** `override_doctype_class` calls `super()` first unless intentionally replacing behavior
- **After migrate:** Must be idempotent — check if records exist before creating
- **Fixtures:** Export with `bench --site {site} export-fixtures` after changes
- **Use Context7** to verify hook type names and signatures against current Frappe version
