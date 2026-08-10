---
name: business-process-doc
description: Use when documenting a business process, creating SOPs, mapping workflows, or writing handover documentation for Frappe/ERPNext configurations. Produces structured markdown docs.
---

Produce a clear, structured business process document — SOP, workflow map, or handover doc — for a Frappe/ERPNext configuration or operational process.

## Pre-Flight Questions

1. **Who is the audience?** (end-user, new admin, finance team, auditor)
2. **Type of doc?** (SOP, workflow map, admin handover, release note, training guide)
3. **What does the process DO?** (approval flow, data entry, report review, periodic task)
4. **What triggers it?** (user action, schedule, event)
5. **What are the outputs/outcomes?**

---

## Step-by-Step Instructions

### 1. SOP Template

```markdown
# [Process Name] — Standard Operating Procedure

**Version:** 1.0
**Effective Date:** YYYY-MM-DD
**Owner:** [Role / Team]
**Audience:** [Who should read this]

---

## Purpose

One paragraph: what this process achieves and why it matters.

## Scope

What this covers and what it does NOT cover.

## Prerequisites

- Access to: [Module / DocType]
- Role required: [Role Name]
- Dependencies: [Other processes or data that must exist first]

---

## Process Steps

### Step 1 — [Action Name]

**Who:** [Role]
**When:** [Trigger / frequency]

1. Navigate to **[Module] → [DocType]**
2. Click **New** (or open existing record)
3. Fill in:
   - **Field Name** — [what to enter, any rules]
   - **Field Name** — [what to enter, any rules]
4. Click **Save** (docstatus = Draft)

> **Note:** [Any important caveat or common mistake]

---

### Step 2 — [Action Name]

**Who:** [Role]
**When:** After Step 1 is complete

1. Open the saved record
2. Click **Submit for Approval** (workflow button)
3. The record moves to **Pending Approval** status
4. The approver receives an email notification automatically

---

### Step 3 — Approval

**Who:** [Approver Role]
**When:** Upon receiving email notification

1. Open the record from the email link or **[Module] → [DocType] List** (filter: Status = Pending Approval)
2. Review all fields
3. Click **Approve** or **Reject**
   - **Approved:** Status becomes Approved, record is submitted (docstatus = 1)
   - **Rejected:** Requester is notified; they can revise and resubmit

---

## Decision Points

| Situation | Action |
|-----------|--------|
| Amount > ₹1,00,000 | Escalate to Senior Manager |
| Missing supporting document | Reject with reason note |
| Duplicate request detected | Cancel the newer request |

---

## Outputs

- **On Approval:** [What gets created / updated automatically]
- **Reports:** [Which report shows this data — link or path]
- **Notifications:** [Who gets emailed and when]

---

## Exception Handling

**If the workflow button is not visible:**
→ Check your role: you need [Role Name]. Contact System Admin.

**If a submitted record needs correction:**
→ Only a [Role] can cancel and amend. Do not delete records.

**If email notifications are not received:**
→ Check Email Queue: Awesome Bar → Email Queue → filter by Status = Error

---

## Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | YYYY-MM-DD | [Name] | Initial version |
```

### 2. Workflow Map (Mermaid Diagram)

Include this in any process doc for visual clarity:

```markdown
## Workflow Diagram

\`\`\`mermaid
flowchart TD
    A([Start: User creates PR]) --> B[Draft]
    B --> C{Submit for Approval}
    C --> D[Pending Approval]
    D --> E{Manager Decision}
    E -->|Approve| F[Approved ✓]
    E -->|Reject| G[Rejected ✗]
    G --> H[Revise & Resubmit]
    H --> C
    F --> I([End: PO Created])
\`\`\`
```

### 3. Admin Handover / Module Summary

For handing over a module to a new admin or documenting for audit:

```markdown
# [Module Name] — Admin Handover Document

**Prepared by:** [Name]
**Date:** YYYY-MM-DD
**Frappe Version:** v15
**Site:** [site URL]

---

## Module Overview

Brief description of what the module does and which business function it serves.

## DocTypes

| DocType | Purpose | Submittable? | Custom? |
|---------|---------|-------------|---------|
| Purchase Request | Captures purchase needs | Yes | Yes |
| ... | ... | ... | ... |

## Workflows

| Workflow | DocType | States | Key Roles |
|----------|---------|--------|-----------|
| Purchase Request Approval | Purchase Request | Draft → Pending → Approved/Rejected | Purchase User, Purchase Manager |

## Custom Fields Added

| DocType | Field | Type | Purpose |
|---------|-------|------|---------|
| Purchase Request | custom_budget_code | Data | Links to finance budget line |

## Server Scripts

| Name | Type | Trigger | Purpose |
|------|------|---------|---------|
| PLA-SS-NSS-AfterSubmit | DocType Event | After Submit | Routes to approvers |
| PLA-API-NSS-Decision | API | pla_nss_record_decision | Records approve/reject decision |

## Scheduled Jobs

| Script | Schedule | Purpose |
|--------|----------|---------|
| PLA-SS-Daily-Reminder | Daily | Emails pending approvers |

## Known Issues / Limitations

- [Issue]: [Workaround]

## Setup Script

Run `pump_location_assessment_setup.js` in browser console on a fresh site to configure all DocTypes, workflows, scripts, and roles.

## Support Contact

[Your name / email]
```

---

## Context Anchor

- **User:** Solo Process Engineer — docs are for stakeholders, end-users, and future admins (not developers)
- **Plain language:** Write as if the reader has never opened Frappe before
- **Mermaid diagrams** render in GitHub, Notion, and Frappe Wiki — always include a workflow diagram
- **Version history table** — always include; auditors and future admins depend on it
- **Exception section** is the most read section — be exhaustive about failure modes
- **Save all docs to `docs/` folder** in the module repository and commit to git
