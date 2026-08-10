# Email Template Guide for Frappe Newsletters

Reference for building email-safe HTML templates in Frappe's Newsletter system.

---

## Email Client Compatibility Rules

| Rule | Why |
|------|-----|
| Inline `style=""` on every element | Gmail strips `<head><style>` blocks entirely |
| No `flexbox` or `grid` | Outlook 2016+ ignores both |
| Use `<table>` for multi-column layouts | Only layout model with universal support |
| Max width 600px | Smallest common mobile viewport |
| No `<script>` or JavaScript | Stripped by all email clients |
| Use absolute URLs for images | `src="/files/logo.png"` won't work in inbox |
| Alt text on all images | Blocked by default in Outlook |
| No `border-radius` in buttons | Outlook renders as square |

---

## Two-Column Table Layout (Email-Safe)

```html
<table style="width:100%;border-collapse:collapse;">
  <tr>
    <td style="width:50%;padding:8px;vertical-align:top;">
      Left column content
    </td>
    <td style="width:50%;padding:8px;vertical-align:top;">
      Right column content
    </td>
  </tr>
</table>
```

---

## CTA Button (Email-Safe)

```html
<!-- Use <a> styled as button — <button> tags don't render in email -->
<a href="{{ url }}"
   style="display:inline-block;background:#1a3a5c;color:#ffffff;
          padding:12px 28px;text-decoration:none;font-weight:bold;
          font-family:Arial,sans-serif;font-size:14px;">
  View Request
</a>
```

---

## Status Badge (Inline)

```html
<span style="display:inline-block;padding:3px 10px;border-radius:3px;font-size:12px;font-weight:bold;
  background:{% if status == 'Approved' %}#d4edda;color:#155724
             {% elif status == 'Rejected' %}#f8d7da;color:#721c24
             {% elif status == 'Pending Approval' %}#fff3cd;color:#856404
             {% else %}#e2e3e5;color:#383d41{% endif %};">
  {{ status }}
</span>
```

---

## Data Table (Email-Safe)

```html
<table style="width:100%;border-collapse:collapse;font-size:14px;">
  <thead>
    <tr style="background:#f0f4f8;">
      <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #ddd;color:#555;">Request #</th>
      <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #ddd;color:#555;">Department</th>
      <th style="padding:8px 12px;text-align:right;border-bottom:2px solid #ddd;color:#555;">Amount</th>
    </tr>
  </thead>
  <tbody>
    {% for row in records %}
    <tr style="background:{{ '#f9f9f9' if loop.index is odd else '#ffffff' }};">
      <td style="padding:8px 12px;border-bottom:1px solid #eee;">
        <a href="{{ site_url }}/app/purchase-request/{{ row.name }}"
           style="color:#1a3a5c;text-decoration:none;">{{ row.name }}</a>
      </td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;">{{ row.department or '—' }}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;">
        ₹{{ "%.0f"|format(row.total_amount or 0) }}
      </td>
    </tr>
    {% endfor %}
  </tbody>
</table>
```

---

## Frappe Jinja Helpers Available in Email Context

```jinja2
{# Date formatting #}
{{ frappe.format_date(doc.creation) }}                    {# "15 Jan 2025" #}
{{ frappe.utils.formatdate(frappe.utils.today(), "MMMM yyyy") }}  {# "January 2025" #}

{# Number formatting #}
{{ "%.2f"|format(value) }}                                {# "1,234.56" #}
{{ "{:,.0f}".format(value) }}                             {# "1,234" #}

{# Conditional blocks #}
{% if records %}...{% else %}...{% endif %}

{# Loop with index and last flag #}
{% for row in records %}
  {% if loop.last %}<strong>{{ row.name }}</strong>{% else %}{{ row.name }}{% endif %}
{% endfor %}

{# Inject unsubscribe link (auto-added by Frappe Newsletter — reference in footer) #}
<a href="{{ unsubscribe_url }}">Unsubscribe</a>
```

---

## Frappe `frappe.sendmail` Parameters

```python
frappe.sendmail(
    recipients  = ["user@example.com"],          # list or comma-separated string
    subject     = "Subject line",
    message     = html_string,
    sender      = "from@company.com",            # optional, uses default Email Account
    reply_to    = "replyto@company.com",         # optional
    attachments = [{"fname": "file.pdf", "fcontent": bytes_or_base64}],
    now         = False,    # False = queued (async), True = immediate SMTP call
    expose_recipients = "header",  # "header" adds visible To:, "footer" shows in footer
    cc          = ["cc@example.com"],
    bcc         = ["bcc@example.com"],
)
```

---

## Testing Checklist Before Sending

- [ ] Send a test email to yourself first via Newsletter → "Send Test Email"
- [ ] Check render in Gmail (web), Gmail (mobile), and Outlook if possible
- [ ] Verify all links are absolute URLs (`https://...`)
- [ ] Verify unsubscribe link renders correctly
- [ ] Check that images load (hosted, not local paths)
- [ ] Confirm `Email Queue` entries are created in Frappe (Awesome Bar → Email Queue)
- [ ] Monitor queue worker: `bench worker --queue long` for large sends
