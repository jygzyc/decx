# Intent - Component Analysis Guide

Use this guide for handoff paths where Intent, Bundle, Parcelable, URI grant, or PendingIntent behavior is the trust boundary.

## Analysis Flow

```text
1. Find sources:
   -> getIntent().get*Extra()
   -> getIntent().getData()
   -> getClipData()
   -> nested Intent extraction
   -> ActivityResult / scan-result callbacks
2. Find transfer points:
   -> startActivity / startService / sendBroadcast
   -> setResult
   -> PendingIntent.getActivity / getService / getBroadcast
   -> grantUriPermission / takePersistableUriPermission
3. Inspect protections:
   -> explicit component vs implicit routing
   -> caller validation
   -> package/signature allowlists
   -> FLAG_MUTABLE, FLAG_GRANT_*, persistable/prefix grants
4. Check whether the downstream effect is visible and matches risk-rating guidance
```

## Promotion Signals

- attacker controls Intent, Bundle, URI, grant, object, or returned handle
- the object crosses a component, process, or caller trust boundary
- target pinning, caller validation, class allowlisting, or grant scoping is missing or bypassable
- downstream effect is a protected action, private data access, or victim-identity operation
- implicit routing is usually a transfer point; promote standalone only when attacker resolution captures sensitive data, grant, handle, or workflow control

## False Positive Guide

- **Implicit Intent resolves only to the app's own components**: confirm no third-party app can register a higher-priority handler for the same action
- **Intent extras drive only harmless behavior**: trace the full dispatch chain -- extras may reach a startActivity or startService call in a helper method
- **Selector or ClipData is stripped before forwarding**: verify the stripping happens on every code path and no branch preserves the attacker-controlled fields
