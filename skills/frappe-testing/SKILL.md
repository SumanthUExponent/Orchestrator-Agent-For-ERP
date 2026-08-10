---
name: frappe-testing
description: Use when writing unit tests, integration tests, or test fixtures for Frappe/ERPNext custom apps. Covers frappe.tests.utils, TestCase patterns, test data factories, and CI configuration.
---

Write maintainable, idempotent Frappe tests — unit tests for business logic, integration tests for workflows, and test factories for repeatable test data.

## Pre-Flight Questions

1. **What to test?** (controller method, API, workflow transition, report)
2. **New record needed?** (use factory helpers — never hardcode names)
3. **DB access required?** (yes → use `frappe.tests.utils.FrappeTestCase`)
4. **Side effects to suppress?** (emails, webhooks → patch or `frappe.flags`)

---

## Step-by-Step Instructions

### 1. File Structure

```
{app}/{module}/tests/
    __init__.py
    test_{doctype_name}.py         ← Controller + lifecycle tests
    test_{feature_name}.py         ← Feature / integration tests
```

Run all tests: `bench --site {site} run-tests --app {app_name}`
Run one file:  `bench --site {site} run-tests --module {app}.{module}.tests.test_purchase_request`

### 2. Basic TestCase Pattern

```python
# test_purchase_request.py
import frappe
from frappe.tests.utils import FrappeTestCase

from myapp.procurement.doctype.purchase_request.purchase_request import PurchaseRequest


class TestPurchaseRequest(FrappeTestCase):
    """Tests for Purchase Request controller."""

    # ── FACTORY ───────────────────────────────────────────────
    @classmethod
    def make_pr(cls, **kwargs) -> PurchaseRequest:
        """Create a minimal, valid Purchase Request. Always rolls back after test."""
        defaults = {
            "doctype":    "Purchase Request",
            "department": frappe.db.get_value("Department", {}, "name") or "_Test Department",
            "items": [
                {
                    "doctype":   "Purchase Request Item",
                    "item_code": "_Test Item",
                    "qty":       1,
                    "rate":      1000,
                },
            ],
        }
        defaults.update(kwargs)
        doc = frappe.get_doc(defaults)
        doc.insert(ignore_permissions=True)
        return doc

    # ── SETUP / TEARDOWN ──────────────────────────────────────
    def setUp(self):
        # Suppress emails during all tests in this class
        frappe.flags.mute_emails = True

    def tearDown(self):
        frappe.flags.mute_emails = False

    # ── TESTS ─────────────────────────────────────────────────
    def test_total_amount_calculated(self):
        doc = self.make_pr()
        self.assertEqual(doc.total_amount, 1000)

    def test_total_with_multiple_items(self):
        doc = self.make_pr(
            items=[
                {"doctype": "Purchase Request Item", "item_code": "_Test Item", "qty": 2, "rate": 500},
                {"doctype": "Purchase Request Item", "item_code": "_Test Item", "qty": 1, "rate": 300},
            ]
        )
        self.assertEqual(doc.total_amount, 1300)

    def test_default_status_is_draft(self):
        doc = self.make_pr()
        self.assertEqual(doc.status, "Draft")

    def test_submit_requires_items(self):
        doc = frappe.get_doc({"doctype": "Purchase Request", "department": "_Test Department"})
        doc.items = []
        with self.assertRaises(frappe.ValidationError):
            doc.insert()

    def test_validate_raises_on_zero_qty(self):
        with self.assertRaises(frappe.ValidationError):
            self.make_pr(
                items=[{"doctype": "Purchase Request Item", "item_code": "_Test Item", "qty": 0, "rate": 100}]
            )
```

### 3. Testing Workflow Transitions

```python
class TestPurchaseRequestWorkflow(FrappeTestCase):

    def _apply_workflow_action(self, doc, action, user=None):
        """Helper: apply a workflow action as a specific user."""
        if user:
            frappe.set_user(user)
        frappe.model.workflow.apply_workflow(doc, action)
        doc.reload()

    def test_submit_for_approval_transition(self):
        frappe.set_user("test.purchaseuser@example.com")
        doc = TestPurchaseRequest.make_pr()

        self._apply_workflow_action(doc, "Submit for Approval")
        self.assertEqual(doc.workflow_state, "Pending Approval")

    def test_only_manager_can_approve(self):
        frappe.set_user("test.purchaseuser@example.com")
        doc = TestPurchaseRequest.make_pr()
        frappe.model.workflow.apply_workflow(doc, "Submit for Approval")
        doc.reload()

        # Non-manager attempt should raise
        frappe.set_user("test.purchaseuser@example.com")
        with self.assertRaises(frappe.PermissionError):
            frappe.model.workflow.apply_workflow(doc, "Approve")

    def tearDown(self):
        frappe.set_user("Administrator")
```

### 4. Testing Whitelisted API Methods

```python
from frappe.tests.utils import FrappeTestCase
import json


class TestPurchaseRequestAPI(FrappeTestCase):

    def test_get_data_returns_expected_keys(self):
        from myapp.procurement.page.procurement_dashboard.procurement_dashboard import get_data

        result = get_data(filters={"from_date": "2024-01-01", "to_date": "2024-12-31"})

        self.assertIn("summary",   result)
        self.assertIn("records",   result)
        self.assertIn("by_status", result)
        self.assertIsInstance(result["records"], list)

    def test_get_data_filters_by_department(self):
        from myapp.procurement.page.procurement_dashboard.procurement_dashboard import get_data

        result = get_data(filters={"from_date": "2024-01-01", "to_date": "2024-12-31", "department": "_Test Dept"})
        for rec in result["records"]:
            self.assertEqual(rec["department"], "_Test Dept")
```

### 5. Mocking / Patching External Calls

```python
from unittest.mock import patch, MagicMock


class TestNotifications(FrappeTestCase):

    @patch("frappe.sendmail")
    def test_approval_email_sent(self, mock_sendmail):
        doc = TestPurchaseRequest.make_pr()
        frappe.model.workflow.apply_workflow(doc, "Submit for Approval")

        # Confirm sendmail was called at least once
        mock_sendmail.assert_called()
        call_kwargs = mock_sendmail.call_args.kwargs
        self.assertIn("Approval Required", call_kwargs.get("subject", ""))

    @patch("frappe.db.get_value", return_value="test.manager@example.com")
    def test_approver_lookup_uses_department_head(self, mock_get_value):
        from myapp.handlers.purchase_request import before_workflow_action
        doc = MagicMock(workflow_state="Draft", department="Engineering", approver=None)
        before_workflow_action(doc)
        self.assertEqual(doc.approver, "test.manager@example.com")
```

### 6. Test Data Setup (`test_records.json`)

Frappe will auto-insert these before running the module's tests:

```json
[
  {
    "doctype":    "Purchase Request",
    "department": "_Test Department",
    "items": [
      {"doctype": "Purchase Request Item", "item_code": "_Test Item", "qty": 1, "rate": 1000}
    ]
  }
]
```

Place at: `{app}/{module}/doctype/{doctype_name}/test_records.json`

---

## Context Anchor

- **User:** Solo Process Engineer — tests are the safety net before deploying to production Frappe Cloud
- **`FrappeTestCase`** wraps each test in a DB transaction that's rolled back — records never persist
- **Never hardcode DocType names** in test data — use `frappe.db.get_value` or `_Test *` fixtures
- **`frappe.flags.mute_emails = True`** suppresses all outgoing mail globally during test run
- **`frappe.set_user()`** changes the active user — always reset to `"Administrator"` in `tearDown`
- **Run with `--verbose`** for full tracebacks: `bench run-tests --verbose`
- **CI pattern:** Add `bench --site test.site run-tests --app myapp` to your GitHub Actions workflow
