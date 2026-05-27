# Casebook: Intent Redirect

Use this casebook after `patterns/intent-redirect.md`. These cases are abstract exploit shapes, not CVE-specific instructions.

## Case: Exported Activity Redirects To Private Component

### Abstract Shape

```text
external app -> exported Activity -> nested Intent extra -> startActivity -> private Activity
```

### Key Mistake

The exported Activity trusts a caller-supplied nested `Intent` as if it came from internal app code.

### Why It Was Exploitable

- external entrypoint is reachable
- attacker controls nested component, data, extras, or flags
- victim app performs the launch under its own package context
- downstream component exposes sensitive behavior or data

### Generalized Detection Rule

If an exported component forwards caller-controlled `Intent` fields without exact target validation, trace the downstream target as an intent redirect candidate.

See: `patterns/intent-redirect.md`

### Not Required

Do not require exact package names, exact class names, or a public CVE. The finding depends on the proven source, forwarded fields, sink, guard, and impact.

## Case: Redirect Preserves URI Grants

### Abstract Shape

```text
external app -> exported forwarder -> ClipData/content URI + grant flags -> private file consumer
```

### Key Mistake

The forwarder validates only the action or scheme and preserves grant-bearing data.

### Why It Was Exploitable

- attacker controls target or grant recipient
- sensitive `content://` URI remains attached
- grant flags survive forwarding
- downstream consumer or recipient gains private data access

### Generalized Detection Rule

When a redirect touches `ClipData`, data URI, selector, or `FLAG_GRANT_*`, trace both the component launch and the caller-visible grant path.

See: `patterns/intent-redirect.md`
