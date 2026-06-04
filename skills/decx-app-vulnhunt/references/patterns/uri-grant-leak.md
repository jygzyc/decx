# Pattern: URI Grant Leak

## When To Use

Use this reference when `content://` URIs, `ClipData`, `FLAG_GRANT_*`, `grantUriPermission`, `setResult`, sharing flows, redirects, or FileProvider roots can expose app-private content.

## Core Concept

Untrusted control over URI, target, or grant flags causes the app to grant read/write access to sensitive content without a non-bypassable policy check.

**Sources**
- external `Intent` data, extras, `ClipData`, chooser/share payloads, activity result paths
- app-generated `Uri` built from caller-controlled path, filename, row ID, or provider authority
- nested `Intent` that preserves grant flags or `ClipData`

**Sinks**
- `Intent.FLAG_GRANT_READ_URI_PERMISSION`, `FLAG_GRANT_WRITE_URI_PERMISSION`
- `grantUriPermission`, `setResult`, `startActivity`, `sendBroadcast`
- FileProvider or custom Provider access through a granted URI

## Guards & Rejection

Safe when: recipients are exact-allowlisted, URI roots are narrow, paths are canonicalized, write grants are avoided, flags are stripped before redirects, and provider permissions still enforce access.

Reject when: granted content is public/non-sensitive, recipient cannot be attacker-controlled, provider denies access despite the grant, or the URI is a trusted constant with no sensitive backing data.

## Rating

- HIGH: arbitrary app-private file or high-value data read/write.
- MEDIUM: bounded sensitive file/row exposure requiring local app or interaction.
- LOW: low-value file name or metadata exposure only.
- IGNORED: no sensitive content or no usable grant.

## Trace Commands

```bash
decx code method-context "<grantOrResultMethod>" -P <port>
decx code method-source "<providerOrFileMappingMethod>" -P <port>
```

## Example Shapes

Suspicious:

```text
external recipient/path -> FileProvider URI -> FLAG_GRANT_READ -> setResult/startActivity
```

Safe:

```text
trusted file ID -> narrow root -> trusted recipient allowlist -> read-only bounded grant
```

Report guidance -- Use: "The app grants attacker-controlled recipients access to private content URIs without recipient and path validation." Avoid: "URI grant is used" without proving the grant target is attacker-reachable and the URI covers protected content.
