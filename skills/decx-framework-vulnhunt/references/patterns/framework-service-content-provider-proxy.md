# Pattern: Framework Service ContentProvider Proxy

## When To Use

Use this reference when Binder input reaches `ContentResolver`, provider proxy, URI permission, file descriptor, or provider-backed data operations performed by framework code.

## Core Concept

Untrusted callers can make a privileged framework service access or grant provider data using attacker-selected URI, authority, path, projection, operation, or target user.

**Sources**
- Binder parameters carrying `Uri`, authority, path, projection, selection, `Bundle`, `ClipData`, user ID, package name, or file descriptor target
- caller-controlled provider operation forwarded through service helpers
- stored URI or grant state later consumed under cleared/system identity

**Sinks**
- `ContentResolver.query`, `insert`, `update`, `delete`, `call`, `openFileDescriptor`, `openInputStream`
- `grantUriPermission`, `takePersistableUriPermission`
- framework helper methods that proxy provider reads/writes for callers

## Required Trace Evidence

- Reachability: attacker can invoke the Binder method or supply provider-related parameters.
- Controllability: attacker controls URI/authority/path/user/operation or returned data scope.
- Sink: framework performs provider access, grant, or file descriptor operation under privileged context.
- Missing or bypassable guard: no authority allowlist, package/UID binding, user check, permission check, canonicalization, or per-operation validation blocks the path.
- Visible impact: protected provider read/write/delete/call, URI grant leak, cross-user provider access, or privileged file descriptor exposure.

## Guards & Rejection

Safe when: authorities are immutable allowlisted, URI paths are canonicalized, provider permissions are enforced for the original caller, user/profile boundaries are checked, and grants are limited to trusted recipients. Provider URI authority and path must be validated or allowlisted before ContentResolver operations under privileged identity.
Reject when: provider data is public/caller-owned, URI is overwritten with a trusted constant, provider enforces the same permission for the original caller, or returned data is fully filtered.

## Rating

- CRITICAL: proxy access enables system data compromise, credential theft, or protected state mutation.
- HIGH: protected provider data/action is exposed through system service identity.
- MEDIUM: bounded protected metadata or write with narrow scope.
- IGNORED: public provider data or no attacker-controlled provider field.

## Trace Commands

```bash
decx code method-context "<binderMethod>" -P <port>
decx code search-global "ContentResolver" --limit 50 -P <port>
decx code xref-method "android.content.ContentResolver.query(android.net.Uri,java.lang.String[],java.lang.String,java.lang.String[],java.lang.String):android.database.Cursor" -P <port>
```

## Example Shapes

Suspicious:
```text
Binder method accepts caller-supplied Uri → framework service calls ContentResolver.query under system UID → attacker reads protected provider data
```

Safe:
```text
Binder method validates URI authority against allowlist → canonicalizes path → enforces caller-bound permissions before forwarding to ContentResolver under cleared identity
```

Report guidance -- Use: "A Binder-exposed framework method proxies attacker-selected provider access under privileged service identity without enforcing caller-scoped authorization." Avoid: "ContentProvider not secured."
