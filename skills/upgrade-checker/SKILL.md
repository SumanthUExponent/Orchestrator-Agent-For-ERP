---
name: upgrade-checker
description: Use when planning a Frappe/ERPNext version upgrade, reviewing breaking changes, or auditing custom scripts for compatibility before a site upgrade. Covers v13→v14→v15 migration paths.
---

Audit a custom Frappe module for upgrade compatibility — identify breaking changes, deprecated APIs, and required code updates before upgrading a site.

## Pre-Flight Questions

1. **From which version?** (v13 / v14 / v14.x)
2. **To which version?** (v14 / v15 / latest)
3. **What custom code exists?** (Server Scripts, Client Scripts, DocTypes, custom fields, hooks)
4. **Frappe Cloud or self-hosted?** (affects upgrade window and rollback options)

---

## Step-by-Step Instructions

### 1. Pre-Upgrade Audit Checklist

```markdown
## Pre-Upgrade Audit — [Site Name]
**From:** Frappe v[N]  **To:** Frappe v[N+1]
**Date:** YYYY-MM-DD

### 1. Custom Fields
- [ ] All `custom_` prefixes in place (v14+ requirement)
- [ ] No hardcoded field names that changed in target version
- [ ] Property Setters still valid for target version's base field list

### 2. Server Scripts (safe_exec sandbox)
- [ ] No `.format()` string method calls
- [ ] No `return` at module level (API scripts only — use frappe.response["message"])
- [ ] No `frappe.get_roles()` — use `frappe.db.get_all("Has Role", ...)`
- [ ] No `doc.reload()` without `frappe.get_doc()` reassignment
- [ ] No `frappe.local.response` (deprecated — use `frappe.response`)

### 3. Client Scripts
- [ ] `frappe.ui.form.on()` syntax unchanged
- [ ] No deprecated `cur_frm` usage — use `frm` parameter
- [ ] `frappe.call()` still works (not changed)
- [ ] Check for removed/renamed `frappe.*` methods

### 4. DocType Controllers (Python files)
- [ ] `validate()` and `on_submit()` signatures unchanged
- [ ] No removed `frappe.db.*` methods used
- [ ] `frappe.get_doc()` still works
- [ ] `frappe.db.sql()` still works (raw SQL — check for table name changes)

### 5. Hooks
- [ ] `doc_events` format unchanged
- [ ] `scheduler_events` format unchanged
- [ ] Removed/renamed hooks — check CHANGELOG

### 6. Reports
- [ ] `execute(filters)` return signature unchanged
- [ ] `frappe.qb` available in target version (added in v14)
- [ ] Column `fieldtype` values still valid

### 7. Fixtures
- [ ] Fixture JSON format still valid
- [ ] No deprecated doctype fields in JSON fixtures
```

### 2. v13 → v14 Breaking Changes

| Area | Change | Action Required |
|------|--------|----------------|
| Custom Fields | Auto-prefix `custom_` added to all custom fieldnames | Update any hardcoded `custom_*` fieldname references |
| `frappe.db.escape()` | Removed | Use `frappe.qb` or parameterized queries |
| `frappe.safe_exec` | Stricter sandbox | Test all Server Scripts in v14 safe_exec |
| `frappe.utils.get_url()` | Still works | No change |
| `doc.db_set()` | Still works | No change |
| `frappe.get_roles()` | Deprecated in safe_exec | Replace with `frappe.db.get_all("Has Role", ...)` |
| Jinja environment | Some filters removed | Test all print formats and email templates |
| `frappe.local.response` | Deprecated | Use `frappe.response` |

### 3. v14 → v15 Breaking Changes

| Area | Change | Action Required |
|------|--------|----------------|
| `frappe.ui.toolbar` | Restructured | Update any toolbar customizations |
| `frappe.boot` | Some keys removed | Check `frappe.boot.sysdefaults` usage |
| Python 3.11+ required | Type hint changes | Update any Python 3.9-incompatible syntax |
| `frappe.db.multisql()` | Removed | Rewrite as separate queries |
| Node.js 18 required | Build tool changes | Rebuild assets after upgrade |
| `frappe.qb` | More stable, additional functions | Update any workarounds |
| Permissions refactor | `perm` table structure | Test all custom permission logic |

### 4. Safe_exec Restrictions (All Versions)

These restrictions apply to **all** Frappe Server Scripts regardless of version:

```python
# ❌ BLOCKED
import os
import subprocess
open("file.txt")
exec("code")
eval("code")
__import__("module")

# ❌ BLOCKED IN SAFE_EXEC (but works in .py controllers)
"field_{}".format(n)          # Use "field_" + str(n) + "_suffix"
frappe.get_roles()             # Use frappe.db.get_all("Has Role", ...)
return value                   # At module level — use frappe.response["message"]

# ✅ ALWAYS WORKS
frappe.db.get_value(...)
frappe.db.get_all(...)
frappe.db.sql(...)
frappe.db.set_value(...)
frappe.get_doc(...)
frappe.response["message"] = ...
frappe.throw(...)
frappe.sendmail(...)
```

### 5. Pre-Upgrade Test Script (Browser Console)

Run on staging before upgrading production:

```javascript
// Quick smoke test — paste in browser console after upgrade
(async () => {
    const tests = [];

    // 1. Test custom DocType exists
    const nss = await frappe.db.get_value('Network Sales Score', {}, 'name');
    tests.push({ test: 'NSS DocType exists', pass: !!nss });

    // 2. Test custom field exists
    const fieldExists = await frappe.db.exists('Custom Field', 'Network Sales Score-approval_1_role');
    tests.push({ test: 'approval_1_role field exists', pass: !!fieldExists });

    // 3. Test API script reachable
    try {
        const r = await frappe.call({ method: 'frappe.client.get_count', args: { doctype: 'Network Sales Score' } });
        tests.push({ test: 'API call works', pass: r.message >= 0 });
    } catch (e) {
        tests.push({ test: 'API call works', pass: false, error: e.message });
    }

    // 4. Test workflow active
    const wf = await frappe.db.get_value('Workflow', 'NSS Approval', 'is_active');
    tests.push({ test: 'Workflow active', pass: wf === 1 });

    console.table(tests);
    const failed = tests.filter(t => !t.pass);
    if (failed.length) {
        console.error('FAILED TESTS:', failed);
    } else {
        console.log('%c All tests passed ✓', 'color:green;font-size:16px');
    }
})();
```

### 6. Rollback Plan

```markdown
## Rollback Plan — [Site Name] Upgrade

**Backup taken:** [Date/Time] — [Backup file name or Frappe Cloud snapshot ID]

### If upgrade fails:
1. Frappe Cloud: Dashboard → Sites → [Site] → Backups → Restore [snapshot]
2. Self-hosted: `bench --site {site} restore {backup_file}`
3. Notify stakeholders: [contact list]

### Go/No-Go Criteria:
- [ ] All smoke tests pass
- [ ] Login works for all user roles
- [ ] Core workflow (Draft → Approved) completes without error
- [ ] Reports load correctly
- [ ] Email notifications send correctly
```

---

## Context Anchor

- **User:** Solo Process Engineer on Frappe Cloud — no bench access, upgrade via Frappe Cloud dashboard
- **Staging first:** Always test on a duplicate/staging site before upgrading production
- **Frappe Cloud snapshots** are the backup mechanism — create one manually before every upgrade
- **safe_exec restrictions don't change** between v14 and v15 — but new restrictions may be added
- **`custom_` prefix** (v14+ auto-added) is the #1 breaking change for v13→v14 migrations
- **Browser console smoke tests** are your only testing tool without bench access
