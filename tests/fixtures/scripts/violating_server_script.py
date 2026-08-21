# Deliberate safe_exec violations for grader calibration — one of every class the
# restriction list names. If a grader cannot find all six planted here, it will not find a
# real one, which is the whole point of a known-answer fixture.
import json
roles = frappe.get_roles(frappe.session.user)
label = "widget_{}".format(widget_code)
message = f"widget {widget_code} checked"
doc = frappe.get_doc("Widget", widget_code)
doc.reload()
return label
