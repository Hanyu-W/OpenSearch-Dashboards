---
rule: invalid-capture-group-name
---

# Invalid regex capture group name

**What it detects.** A named capture group in a `rex` pattern whose name is not
a valid identifier for the engine's regex dialect (for example, a name
containing hyphens or other punctuation).

**Why it matters.** The query fails at execution time with a regex compilation
error from the engine. The linter catches it while you type instead.

**Example.**

```
source=logs | rex field=message "(?<user-name>\\w+)"     # invalid: hyphen in group name
source=logs | rex field=message "(?<username>\\w+)"      # valid
```

**How to fix it.** Rename the capture group using only letters and digits. A
quick fix is offered that strips the invalid characters from the group name.

**Availability.** Error severity, enabled by default, all engine versions, no
data-source connection required.
