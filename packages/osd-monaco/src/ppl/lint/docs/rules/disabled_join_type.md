---
rule: disabled-join-type
---

# Performance-sensitive join type is disabled by default

**What it detects.** A `join` using a join type that clusters disable by
default because of its cost (for example cross joins).

**Why it matters.** The query fails at execution time with an engine error
unless an administrator has explicitly enabled that join type on the cluster.

**Example.**

```
source=a | cross join on 1=1 b       # rejected unless enabled on the cluster
source=a | inner join on a.id=b.id b # allowed by default
```

**How to fix it.** Rewrite with a default-enabled join type, or ask a cluster
administrator to enable the join type if the cost is acceptable.

**Availability.** Warning severity, enabled by default, all engine versions,
no data-source connection required.
