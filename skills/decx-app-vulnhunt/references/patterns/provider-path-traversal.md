# Pattern: Provider Path Traversal

## When To Use

Use this reference when a `ContentProvider`, FileProvider wrapper, document provider, or helper maps URI path segments, query parameters, file names, or IDs to filesystem paths.

## Vulnerability Essence

Attacker-controlled provider path data reaches file read/write/delete/open operations without canonical path confinement.

## Sources

- `Uri.getPath`, `getPathSegments`, `getLastPathSegment`, query parameters, selection args
- provider `openFile`, `openAssetFile`, `query`, `insert`, `update`, `delete`, `call`
- grant-backed `content://` URIs routed through helper path builders

## Sinks

- `File`, `FileInputStream`, `FileOutputStream`, `openFile`, `ParcelFileDescriptor.open`
- delete, rename, copy, unzip, database attachment, or media decode using the resolved path

## Required Trace Evidence

- Reachability: exported/grant-reachable provider method is invocable by attacker.
- Controllability: attacker controls path segment, filename, document ID, or URI used in path construction.
- Sink: resolved path reaches read/write/delete/open operation.
- Missing or bypassable guard: no canonicalization plus base-directory prefix/equality check after symlink and `..` resolution.
- Visible impact: read/write/delete of app-private or permission-protected content.

## Guard Checklist

Consider safe when the code resolves canonical path, checks it remains under an immutable allowed root, rejects symlink escape, uses fixed ID-to-file mapping, and enforces per-path permissions.

## Rejection Rules

Reject when the path maps only to public cache with no sensitive impact, the method is not externally reachable, attacker input is converted to a trusted ID before filesystem use, or canonical confinement is proven.

## Rating Mapping

- HIGH: arbitrary app-private file read/write/delete.
- MEDIUM: bounded sensitive directory traversal.
- LOW: low-value metadata or public cache access.
- IGNORED: no escape or no sensitive file impact.

## Trace Commands

```bash
decx code method-context "<providerMethod>" -P <port>
decx code method-source "<pathBuilder>" -P <port>
```

## Example Shapes

Suspicious:

```text
content://provider/../../shared_prefs/token.xml -> File(root, segment) -> openFile
```

Safe:

```text
document ID -> trusted map lookup -> canonical path under root -> open read-only descriptor
```

## Report Snippet

Use: "The exported provider maps attacker-controlled URI path data to file operations without canonical root confinement."

Avoid: "Provider handles file paths" without proving attacker-controlled path segments escape the canonical root.
