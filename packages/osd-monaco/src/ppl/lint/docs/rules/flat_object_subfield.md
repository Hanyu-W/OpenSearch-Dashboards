---
rule: flat-object-subfield
---

# flat_object fields cannot be referenced in PPL

**What it detects.** Any reference to a field mapped as `flat_object` (or one
of its subfields).

**Why it matters.** The PPL engine cannot reference `flat_object` fields at
all — neither the parent nor dotted subpaths — so any such reference fails at
execution time.

**Example.**

```
source=logs | where attributes.region = "us-east-1"   # attributes is flat_object
```

**How to fix it.** There is no PPL rewrite that reaches this data; no quick
fix is offered because no valid rewrite target exists. Query the field through
DQL/the search API instead, or remap the data to an `object` field if you need
it in PPL.

**Availability.** Error severity, enabled by default, all engine versions.
Needs the selected index's field mappings, so it fires only when a dataset is
selected.
