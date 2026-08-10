# Frappe Field Types — Quick Reference

## Core Data Fields

| FieldType | JSON Key | Options Format | Notes |
|-----------|----------|----------------|-------|
| `Data` | `"fieldtype": "Data"` | — | Single-line text. Max 140 chars by default |
| `Small Text` | `"fieldtype": "Small Text"` | — | Multi-line, stored as TEXT |
| `Text` | `"fieldtype": "Text"` | — | Long text, stored as LONGTEXT |
| `Long Text` | `"fieldtype": "Long Text"` | — | Very long text |
| `Text Editor` | `"fieldtype": "Text Editor"` | — | Rich text / HTML editor |
| `Markdown Editor` | `"fieldtype": "Markdown Editor"` | — | Markdown with preview |
| `Code` | `"fieldtype": "Code"` | `"options": "Python"` | Code editor. Options: Python, JS, JSON, etc. |
| `Password` | `"fieldtype": "Password"` | — | Stored encrypted |

## Numeric Fields

| FieldType | Notes |
|-----------|-------|
| `Int` | Integer. Stored as INT |
| `Float` | Decimal. `"precision"` key sets decimal places |
| `Currency` | Float formatted as currency. Respects System Currency |
| `Percent` | Float displayed as %. Stored as 0–100 |
| `Duration` | Stored in seconds. Displayed as Xh Ym |
| `Rating` | Integer 1–5 (star display) |

## Date & Time Fields

| FieldType | Notes |
|-----------|-------|
| `Date` | YYYY-MM-DD |
| `Time` | HH:MM:SS |
| `Datetime` | YYYY-MM-DD HH:MM:SS |

## Selection Fields

| FieldType | Options Format | Notes |
|-----------|----------------|-------|
| `Select` | `"options": "Option1\nOption2\nOption3"` | First option = blank allowed if no default |
| `Check` | — | Boolean. Stored as 0/1. Default: `"default": "0"` |
| `Autocomplete` | `"options": "..."` or link to a field | Single value with autocomplete |
| `Color` | — | Hex colour picker |
| `Icon` | — | Bootstrap icon picker |
| `Rating` | — | 1–5 star |

## Link & Relationship Fields

| FieldType | Options | Notes |
|-----------|---------|-------|
| `Link` | `"options": "DocType Name"` | FK to another DocType |
| `Dynamic Link` | `"options": "fieldname_of_doctype_select"` | Runtime link type |
| `Table` | `"options": "Child DocType Name"` | Child table (istable: 1 required on child) |
| `Table MultiSelect` | `"options": "Child DocType Name"` | Multi-select stored as child rows |

## File & Attachment Fields

| FieldType | Notes |
|-----------|-------|
| `Attach` | Single file attachment |
| `Attach Image` | Image only. Displays inline |
| `Image` | Reference to an Attach Image field. Displays in list view |
| `Signature` | Signature pad widget |

## Layout Fields (no data stored)

| FieldType | Notes |
|-----------|-------|
| `Section Break` | `"label"` is the section heading. `"collapsible": 1` to collapse |
| `Column Break` | Splits the section into columns |
| `Tab Break` | Creates a tabbed layout (Frappe v14+) |
| `Fold` | Everything below is hidden until expanded |
| `HTML` | Static HTML snippet in the form |
| `Heading` | Bold heading text |
| `Button` | Clickable button. Use `"options"` for JS function name |

## Special Fields

| FieldType | Options | Notes |
|-----------|---------|-------|
| `Phone` | — | Stored as Data, formatted as phone |
| `Read Only` | — | Computed/display-only field |
| `Geolocation` | — | JSON GeoJSON field with map widget |
| `Barcode` | — | Barcode scanner input |

---

## Key Field Properties

| Property | Type | Purpose |
|----------|------|---------|
| `reqd` | 0/1 | Mandatory — throws on save if empty |
| `in_list_view` | 0/1 | Show in list view columns |
| `in_standard_filter` | 0/1 | Add to standard filter bar |
| `bold` | 0/1 | Bold in form |
| `hidden` | 0/1 | Hidden by default (can show via JS) |
| `read_only` | 0/1 | Read-only in form |
| `set_only_once` | 0/1 | Cannot be changed after first save |
| `no_copy` | 0/1 | Exclude from document copy |
| `allow_on_submit` | 0/1 | Allow editing after docstatus=1 |
| `translatable` | 0/1 | Mark for translation |
| `unique` | 0/1 | DB-level unique constraint |
| `default` | string | Default value on new doc |
| `description` | string | Help text below field |
| `depends_on` | expr string | `"eval:doc.fieldname == 'value'"` |
| `mandatory_depends_on` | expr string | Conditionally mandatory |
| `read_only_depends_on` | expr string | Conditionally read-only |
| `hidden_depends_on` | expr string | Conditionally hidden |
| `precision` | string | Decimal precision for Float/Currency |
| `length` | int | Max character length for Data fields |

---

## Common Gotchas

1. **Select options:** The first blank line `\n` is required if the field is not mandatory (allows empty selection)
2. **Child Table:** The child DocType MUST have `"istable": 1` in its JSON
3. **Dynamic Link:** The `options` field must point to the **fieldname** of a Select/Link field that holds the DocType name — not the DocType name itself
4. **allow_on_submit:** Without this, fields are read-only on submitted documents — even for System Manager
5. **depends_on syntax:** Must use `eval:` prefix — e.g., `"depends_on": "eval:doc.is_active == 1"`
6. **naming_series autoname:** Format: `"autoname": "naming_series:"` + `"naming_series": "PREFIX-.YYYY.-.####"`
7. **Table fields:** Always include a `Section Break` before a `Table` field for cleaner UI
8. **Permissions on child tables:** Set on the parent DocType, not the child
9. **Currency field precision:** Controlled by System Settings > Currency Precision, not field-level
10. **Read Only fields from controller:** Set via `self.field = value` in `validate()` — no `allow_on_submit` needed if you use `db_set()`
