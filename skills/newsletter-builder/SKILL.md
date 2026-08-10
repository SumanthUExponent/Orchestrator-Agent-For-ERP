---
name: newsletter-builder
description: Use when creating email newsletters, HTML email templates, or mass email campaigns in Frappe. Covers Newsletter DocType, Jinja templates, subscription management, and send mechanics.
---

Build a Frappe Newsletter campaign — HTML email template, subscriber group, send mechanics, and unsubscribe handling.

## Pre-Flight Questions

1. **Audience?** (Email Group name, or dynamic filter from DocType)
2. **Content?** (announcement, digest, promotion, operational update)
3. **Personalization?** (greeting by name, links per recipient, etc.)
4. **Scheduled or immediate?** (schedule via Frappe Newsletter or trigger manually)
5. **Tracking?** (open tracking, click tracking — enabled in Email Account settings)

---

## Step-by-Step Instructions

### 1. Newsletter via Frappe UI (Quickest Path)

Awesome Bar → Newsletter → New

- **Subject:** Enter plain-text subject (supports `{{ }}` Jinja? — No, subject is static)
- **Email Group:** Select or create a group (Awesome Bar → Email Group)
- **Message:** HTML or Rich Text (recommended: paste from template below)
- **Schedule Send:** Optional datetime, else send immediately
- **Send button** (or bench trigger — see below)

### 2. Email Group Setup

```python
# Programmatically create/populate an Email Group
import frappe

group_name = "Procurement Monthly Digest"
if not frappe.db.exists("Email Group", group_name):
    frappe.get_doc({
        "doctype":    "Email Group",
        "title":      group_name,
        "total_subscribers": 0,
    }).insert(ignore_permissions=True)

# Add subscribers (Email Group Member)
emails = frappe.db.get_all("User", filters={"enabled": 1, "user_type": "System User"}, pluck="email")
for email in emails:
    if not frappe.db.exists("Email Group Member", {"email": email, "email_group": group_name}):
        frappe.get_doc({
            "doctype":    "Email Group Member",
            "email":      email,
            "email_group": group_name,
        }).insert(ignore_permissions=True)

frappe.db.commit()
```

### 3. Newsletter Document (Programmatic)

```python
import frappe

newsletter = frappe.get_doc({
    "doctype": "Newsletter",
    "subject": "Procurement Digest — January 2025",
    "email_group": ["Procurement Monthly Digest"],   # list of Email Group names
    "message": open("path/to/template_rendered.html").read(),
    "send_from": "procurement@company.com",
})
newsletter.insert(ignore_permissions=True)
newsletter.send_emails()    # Send immediately
frappe.db.commit()
```

### 4. HTML Email Template (Jinja)

Use this in the Newsletter `message` field. Renders at send time in Frappe's mailer.

See `references/template-guide.md` for the full annotated template.

**Quick skeleton:**

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{{ subject }}</title>
<style>
  /* Inline all critical styles — email clients strip <head> */
  body { margin:0; padding:0; background:#f4f4f4; font-family:Arial,sans-serif; }
  .wrapper { max-width:600px; margin:0 auto; background:#fff; }
  .header  { background:#1a3a5c; color:#fff; padding:24px 32px; }
  .body    { padding:24px 32px; color:#333; font-size:15px; line-height:1.6; }
  .footer  { background:#f9f9f9; padding:16px 32px; font-size:12px; color:#888; text-align:center; }
  .btn     { display:inline-block; background:#1a3a5c; color:#fff!important; padding:10px 24px;
             border-radius:4px; text-decoration:none; font-weight:bold; margin:8px 0; }
  .divider { border:none; border-top:1px solid #eee; margin:16px 0; }
  table    { border-collapse:collapse; width:100%; }
  td       { padding:8px 12px; border-bottom:1px solid #eee; font-size:14px; }
  th       { background:#f0f4f8; padding:8px 12px; text-align:left; font-size:13px; color:#555; }
</style>
</head>
<body>
<div class="wrapper">

  <!-- HEADER -->
  <div class="header">
    <h1 style="margin:0;font-size:22px;">{{ company_name }}</h1>
    <p style="margin:4px 0 0;opacity:.8;font-size:14px;">Procurement Update</p>
  </div>

  <!-- BODY -->
  <div class="body">
    <p>Hello{% if recipient_name %} {{ recipient_name }}{% endif %},</p>

    <p>Here is your monthly procurement summary for <strong>{{ month_label }}</strong>.</p>

    {% if summary %}
    <hr class="divider">
    <h3 style="color:#1a3a5c;margin-top:0">Summary</h3>
    <table>
      <tr><th>Metric</th><th>Value</th></tr>
      {% for row in summary %}
      <tr><td>{{ row.label }}</td><td><strong>{{ row.value }}</strong></td></tr>
      {% endfor %}
    </table>
    {% endif %}

    {% if pending_approvals %}
    <hr class="divider">
    <h3 style="color:#1a3a5c;">Pending Your Approval</h3>
    <table>
      <tr><th>#</th><th>Request</th><th>Amount</th></tr>
      {% for pr in pending_approvals %}
      <tr>
        <td>{{ loop.index }}</td>
        <td><a href="{{ site_url }}/app/purchase-request/{{ pr.name }}">{{ pr.name }}</a></td>
        <td>₹{{ "%.0f"|format(pr.total_amount or 0) }}</td>
      </tr>
      {% endfor %}
    </table>
    <a href="{{ site_url }}/app/purchase-request" class="btn">Review All Requests</a>
    {% endif %}

  </div>

  <!-- FOOTER -->
  <div class="footer">
    <p>You received this because you are subscribed to Procurement Updates.</p>
    <p><a href="{{ unsubscribe_url }}">Unsubscribe</a></p>
    <p>{{ company_name }} · {{ frappe.format_date(frappe.utils.today()) }}</p>
  </div>

</div>
</body>
</html>
```

### 5. Sending a Templated Newsletter Programmatically

```python
import frappe


def send_monthly_digest():
    """Call from a scheduled Server Script or after_migrate."""
    site_url = frappe.utils.get_url()
    company  = frappe.defaults.get_global_default("company") or ""

    # Build summary data
    summary = frappe.db.sql("""
        SELECT status, COUNT(*) as cnt
        FROM `tabPurchase Request`
        WHERE MONTH(request_date) = MONTH(CURDATE())
          AND YEAR(request_date)  = YEAR(CURDATE())
        GROUP BY status
    """, as_dict=True)

    pending = frappe.db.get_all(
        "Purchase Request",
        filters={"status": "Pending Approval"},
        fields=["name", "total_amount", "owner"],
        limit=20,
    )

    context = {
        "company_name":   company,
        "site_url":       site_url,
        "month_label":    frappe.utils.formatdate(frappe.utils.today(), "MMMM yyyy"),
        "summary":        [{"label": r.status, "value": r.cnt} for r in summary],
        "pending_approvals": pending,
    }

    # Render the HTML template
    html = frappe.render_template("myapp/templates/email/monthly_digest.html", context)

    newsletter = frappe.get_doc({
        "doctype":    "Newsletter",
        "subject":    f"Procurement Digest — {context['month_label']}",
        "email_group": ["Procurement Monthly Digest"],
        "message":    html,
    })
    newsletter.insert(ignore_permissions=True)
    newsletter.send_emails()
    frappe.db.commit()
```

---

## Context Anchor

- **User:** Solo Process Engineer — newsletters are operational digests, not marketing blasts
- **Inline all CSS** — email clients (Outlook, Gmail) strip `<style>` tags; use `style=""` on elements for critical styles
- **`{{ unsubscribe_url }}`** — Frappe injects this automatically in the footer when using Newsletter DocType
- **Max width 600px** — universal safe width for email clients
- **Test with Mailhog** (`bench --site {site} set-config mail_server localhost`) before sending to real recipients
- **Jinja in `message`**: variables passed via `context` in `frappe.render_template()`; `frappe.utils` helpers available
- **`send_emails()`** queues to the Email Queue — actual delivery is async via the queue worker
