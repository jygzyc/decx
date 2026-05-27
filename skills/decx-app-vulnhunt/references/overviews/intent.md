# Intent - Overview - Security Review

Use this overview for handoff paths where Intent, Bundle, Parcelable, URI grant, or PendingIntent behavior is the trust boundary. For signal-to-pattern routing, start with `vulnerability-router.md`.

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
   -> `FLAG_MUTABLE`, `FLAG_GRANT_*`, persistable/prefix grants
4. Check whether the downstream effect is visible and matches risk-rating guidance
```

## Promotion Signals

- attacker controls Intent, Bundle, URI, grant, object, or returned handle
- the object crosses a component, process, or caller trust boundary
- target pinning, caller validation, class allowlisting, or grant scoping is missing or bypassable
- downstream effect is a protected action, private data access, or victim-identity operation
- implicit routing is usually a transfer point; promote standalone only when attacker resolution captures sensitive data, grant, handle, or workflow control

## Common False Positives

- Implicit Intent resolves only to the app's own components in a controlled environment
- Intent extras are consumed but only drive public or harmless behavior
- Selector or ClipData is present but stripped before forwarding
