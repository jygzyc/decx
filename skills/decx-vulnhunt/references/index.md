# Vulnerability Hunting Knowledge Base

Use references as a vulnerability knowledge base, not as a workflow manual. `SKILL.md` controls execution; this directory helps identify vulnerability shapes and route to the right reference.

## Tracks

| Track | Target | Chain reference | Patterns |
|---|---|---|---|
| App | APK / DEX | [[app-chains]] | `patterns/app_*.md` |
| Framework | framework JAR / Binder / system service | [[framework-chains]] | `patterns/framework_*.md` |

## Load Order

1. Pick the track matching the target.
2. Start from the track's Composite Chains matrix and pick the smallest chain that matches observed code behavior.
3. Load one or two matching pattern cards for source/sink/guard/reject rules. Do not load sibling cards by name alone — only when the trace crosses that boundary.
4. Apply [[risk-rating]] before calling any candidate a finding.

Every pattern card carries YAML frontmatter `track: app|framework`; only load cards matching the active track. Pattern cards should add one of three things: a routing signal, a non-obvious API/Binder/identity/permission quirk or version default, or a closed-form constraint that prevents false positives. Stop reading a card when it only repeats generic Android security knowledge.

## Rating

[[risk-rating]] is the single rating authority for both tracks.
