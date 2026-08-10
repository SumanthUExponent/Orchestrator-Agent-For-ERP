---
name: frappe-print-format
description: Use when creating PDF templates, invoice layouts, delivery notes, or any Jinja2 print format in Frappe. Generates clean HTML/CSS with print media rules.
---

Create a production-quality Frappe print format using Jinja2 templating — clean layout, print-safe CSS, letterhead support, child table iteration, and conditional sections.

## Pre-Flight Questions

1. **Which DocType?** (determines available `doc` fields)
2. **Letterhead?** (yes/no — uses Frappe's built-in letterhead)
3. **Paper size?** (A4 / Letter / custom)
4. **Any child tables to display?** (e.g., items, taxes)
5. **Conditional sections?** (e.g., show tax breakdown only if taxes exist)

---

## Step-by-Step Instructions

### 1. Print Format Boilerplate

File created in Frappe UI: Awesome Bar → Print Format → New

Or as JSON fixture: `{app}/fixtures/print_format/{format_name}.json`

```json
{
  "doctype": "Print Format",
  "name": "Purchase Request - Standard",
  "doc_type": "Purchase Request",
  "standard": "No",
  "module": "Procurement",
  "print_format_type": "Jinja",
  "html": "... jinja template here ..."
}
```

### 2. Full Jinja Template Structure

```html
{%- set company = frappe.db.get_value("Company", doc.company, ["company_name", "phone_no", "website"], as_dict=True) -%}

<div class="print-format">

  {# ── HEADER ─────────────────────────────────────────────────── #}
  <div class="header">
    <div class="company-block">
      <h2>{{ company.company_name }}</h2>
      {% if company.phone_no %}
        <div class="muted">Tel: {{ company.phone_no }}</div>
      {% endif %}
    </div>
    <div class="doc-block">
      <h1 class="doc-title">Purchase Request</h1>
      <table class="doc-meta-table">
        <tr>
          <td class="label">Request No.</td>
          <td class="value"><strong>{{ doc.name }}</strong></td>
        </tr>
        <tr>
          <td class="label">Date</td>
          <td class="value">{{ frappe.format_date(doc.request_date) }}</td>
        </tr>
        <tr>
          <td class="label">Status</td>
          <td class="value">{{ doc.workflow_state or doc.status }}</td>
        </tr>
      </table>
    </div>
  </div>

  <hr class="divider">

  {# ── DETAILS ─────────────────────────────────────────────────── #}
  <div class="section">
    <div class="section-title">Request Details</div>
    <div class="row-2col">
      <div>
        <span class="label">Requested By:</span>
        <span>{{ doc.requested_by_name or doc.requested_by }}</span>
      </div>
      <div>
        <span class="label">Department:</span>
        <span>{{ doc.department or "—" }}</span>
      </div>
      <div>
        <span class="label">Required By:</span>
        <span>{{ frappe.format_date(doc.required_by) if doc.required_by else "—" }}</span>
      </div>
      <div>
        <span class="label">Priority:</span>
        <span>{{ doc.priority or "Medium" }}</span>
      </div>
    </div>
  </div>

  {# ── ITEMS TABLE ──────────────────────────────────────────────── #}
  {% if doc.items %}
  <div class="section">
    <div class="section-title">Items Requested</div>
    <table class="items-table">
      <thead>
        <tr>
          <th class="col-no">#</th>
          <th class="col-item">Item</th>
          <th class="col-qty text-right">Qty</th>
          <th class="col-uom">UOM</th>
          <th class="col-rate text-right">Rate (₹)</th>
          <th class="col-amount text-right">Amount (₹)</th>
        </tr>
      </thead>
      <tbody>
        {% for row in doc.items %}
        <tr class="{{ 'alt-row' if loop.index is odd else '' }}">
          <td class="col-no text-center">{{ loop.index }}</td>
          <td class="col-item">
            <strong>{{ row.item_name }}</strong>
            {% if row.description %}
              <br><small class="muted">{{ row.description }}</small>
            {% endif %}
          </td>
          <td class="col-qty text-right">{{ row.qty }}</td>
          <td class="col-uom">{{ row.uom }}</td>
          <td class="col-rate text-right">{{ frappe.format_value(row.rate, "Currency") }}</td>
          <td class="col-amount text-right"><strong>{{ frappe.format_value(row.amount, "Currency") }}</strong></td>
        </tr>
        {% endfor %}
      </tbody>
      <tfoot>
        <tr class="total-row">
          <td colspan="5" class="text-right"><strong>Total</strong></td>
          <td class="text-right"><strong>{{ frappe.format_value(doc.total_amount, "Currency") }}</strong></td>
        </tr>
      </tfoot>
    </table>
  </div>
  {% endif %}

  {# ── REMARKS ──────────────────────────────────────────────────── #}
  {% if doc.remarks %}
  <div class="section">
    <div class="section-title">Remarks</div>
    <p class="remarks-text">{{ doc.remarks }}</p>
  </div>
  {% endif %}

  {# ── SIGNATURES ───────────────────────────────────────────────── #}
  <div class="signature-block">
    <div class="sig-col">
      <div class="sig-line"></div>
      <div class="sig-label">Requested By</div>
    </div>
    <div class="sig-col">
      <div class="sig-line"></div>
      <div class="sig-label">Approved By</div>
    </div>
    <div class="sig-col">
      <div class="sig-line"></div>
      <div class="sig-label">Finance</div>
    </div>
  </div>

</div>

{# ── STYLES ───────────────────────────────────────────────────── #}
<style>
  /* Reset */
  * { box-sizing: border-box; margin: 0; padding: 0; }

  .print-format {
    font-family: 'Helvetica Neue', Arial, sans-serif;
    font-size: 11pt;
    color: #1a1a1a;
    padding: 8mm 10mm;
    max-width: 210mm;
  }

  /* Header */
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8mm; }
  .company-block h2 { font-size: 16pt; font-weight: 700; color: #1a3a5c; }
  .doc-title { font-size: 18pt; font-weight: 800; color: #1a3a5c; text-align: right; }
  .doc-meta-table td { padding: 2px 8px 2px 0; font-size: 10pt; }
  .doc-meta-table .label { color: #666; white-space: nowrap; }
  .doc-meta-table .value { font-weight: 500; }

  /* Divider */
  .divider { border: none; border-top: 2px solid #1a3a5c; margin: 4mm 0; }

  /* Sections */
  .section { margin-bottom: 6mm; }
  .section-title {
    font-size: 9pt; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.06em; color: #1a3a5c;
    border-bottom: 1px solid #ddd; padding-bottom: 2px; margin-bottom: 4px;
  }

  /* Two-column layout */
  .row-2col { display: grid; grid-template-columns: 1fr 1fr; gap: 3mm; }
  .label { color: #666; font-size: 9pt; margin-right: 4px; }

  /* Items table */
  .items-table { width: 100%; border-collapse: collapse; font-size: 10pt; }
  .items-table th {
    background: #1a3a5c; color: #fff;
    padding: 5px 8px; text-align: left; font-size: 9pt; font-weight: 600;
  }
  .items-table td { padding: 5px 8px; border-bottom: 1px solid #eee; }
  .alt-row { background: #f8f9fa; }
  .total-row td { padding: 6px 8px; border-top: 2px solid #1a3a5c; background: #f0f4f8; }
  .col-no { width: 28px; }
  .col-qty, .col-rate, .col-amount { width: 70px; }
  .col-uom { width: 50px; }
  .text-right { text-align: right; }
  .text-center { text-align: center; }

  /* Misc */
  .muted { color: #888; }
  .remarks-text { font-size: 10pt; color: #444; line-height: 1.6; }

  /* Signatures */
  .signature-block {
    display: flex; justify-content: space-between;
    margin-top: 15mm; padding-top: 5mm; border-top: 1px solid #ddd;
  }
  .sig-col { text-align: center; width: 30%; }
  .sig-line { border-bottom: 1px solid #333; margin-bottom: 4px; height: 10mm; }
  .sig-label { font-size: 9pt; color: #666; }

  /* Print rules */
  @media print {
    .print-format { padding: 0; }
    @page { size: A4; margin: 15mm; }
    .items-table thead { display: table-header-group; } /* repeat header on multi-page */
    tr { page-break-inside: avoid; }
    .signature-block { page-break-inside: avoid; }
  }
</style>
```

### 3. Useful Jinja Functions in Print Context

```jinja2
{# Format date #}
{{ frappe.format_date(doc.date) }}            {# e.g., "15 Jan 2025" #}
{{ frappe.format_date(doc.date, "dd/MM/yyyy") }}

{# Format currency #}
{{ frappe.format_value(doc.amount, "Currency") }}

{# Format number #}
{{ frappe.format_value(doc.qty, "Float", precision=2) }}

{# Get company details #}
{% set co = frappe.get_doc("Company", doc.company) %}

{# Conditional display #}
{% if doc.taxes %}
  ... tax table ...
{% endif %}

{# Loop with index #}
{% for row in doc.items %}
  {{ loop.index }}  {# 1-based #}
  {{ loop.first }}  {# True on first iteration #}
  {{ loop.last }}   {# True on last iteration #}
{% endfor %}

{# Translate #}
{{ _("Item Description") }}
```

---

## Context Anchor

- **User:** Solo Process Engineer building Frappe/ERPNext tools
- **CSS in print formats:** Always include `@media print` rules — screen rendering ≠ PDF rendering
- **`frappe.format_value`** is the correct function for currencies and numbers — don't use Python `format()`
- **Child tables** accessed as `doc.items`, `doc.taxes`, etc. — same fieldname as in DocType
- **Page breaks:** Use `page-break-before: always` / `page-break-inside: avoid` in CSS
- **Letterhead:** Set `print_format_builder: "HTML"` and enable letterhead in Print Settings
