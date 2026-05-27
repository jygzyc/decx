# Pattern: Provider Data Leak

## When To Use

Use this reference when an exported, grant-reachable, or internally proxied provider returns protected rows, files, credentials, tokens, messages, private config, or app-sandbox data.

## Vulnerability Essence

Attacker-reachable provider methods expose sensitive data because manifest or per-method authorization does not protect the exact read path.

## Sources

- provider `query`, `openFile`, `openAssetFile`, `call`, `getType`
- URI matcher path, projection, selection, method args, file ID
- caller-visible cursor, file descriptor, bundle, or MIME/oracle result

## Sinks

- returned cursor rows, bundle values, file descriptors, stream content, provider oracles with practical chain value

## Required Trace Evidence

- Reachability: attacker can query/open/call the authority or receive a grant.
- Controllability: attacker can select path, row, projection, file, or method.
- Sink: returned value contains protected data or a practical sensitive oracle.
- Missing or bypassable guard: provider permission, per-method check, row filter, or caller validation does not block the read.
- Visible impact: credentials, tokens, messages, private files/config, user data, or chain-enabling protected state.

## Guard Checklist

Consider safe when signature permission, strict caller validation, per-URI/row checks, and projection/path allowlists protect the returned data.

## Rejection Rules

Reject when returned data is public, empty, synthetic, non-sensitive, or write-only with no readback. Keep external custom permission bypassability explicit until proven.

## Rating Mapping

- HIGH: broad app-sandbox or credential/token disclosure.
- MEDIUM: bounded sensitive rows/files.
- LOW: low-value metadata or weak oracle.
- IGNORED: reachable provider but no sensitive output.

## Trace Commands

```bash
decx code method-source "<providerReadMethod>" -P <port>
decx code method-context "<uriMatcherOrPermissionCheck>" -P <port>
```

## Example Shapes

Suspicious:

```text
exported Provider with no readPermission -> query() returns protected rows or files
```

Safe:

```text
exported Provider enforces signature readPermission -> or per-URI caller check blocks protected rows
```

## Report Snippet

Use: "The provider exposes attacker-reachable protected data without a non-bypassable read guard."

Avoid: "provider is exported" without proving untrusted callers can retrieve protected rows or files.
