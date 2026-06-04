# Pattern: Provider Path Traversal

## When To Use

Use this reference when a `ContentProvider`, FileProvider wrapper, document provider, or helper maps URI path segments, query parameters, file names, or IDs to filesystem paths.

## Core Concept

Attacker-controlled provider path data reaches file read/write/delete/open operations without canonical path confinement.

**Sources**
- `Uri.getPath`, `getPathSegments`, `getLastPathSegment`, query parameters, selection args
- provider `openFile`, `openAssetFile`, `query`, `insert`, `update`, `delete`, `call`
- grant-backed `content://` URIs routed through helper path builders

**Sinks**
- `File`, `FileInputStream`, `FileOutputStream`, `openFile`, `ParcelFileDescriptor.open`
- delete, rename, copy, unzip, database attachment, or media decode using the resolved path

## Guards & Rejection

Safe when: the code resolves canonical path, checks it remains under an immutable allowed root, rejects symlink escape, uses fixed ID-to-file mapping, and enforces per-path permissions.

Reject when: the path maps only to public cache with no sensitive impact, the method is not externally reachable, attacker input is converted to a trusted ID before filesystem use, or canonical confinement is proven.

## Rating

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

Report guidance -- Use: "The exported provider maps attacker-controlled URI path data to file operations without canonical root confinement." Avoid: "Provider handles file paths" without proving attacker-controlled path segments escape the canonical root.
