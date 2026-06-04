# Casebook: URI Grant Leaks

Use this casebook after [[patterns/uri-grant-leak]] and [[patterns/setresult-leak]]. These cases are abstract exploit shapes, not CVE-specific instructions.

## Case: Exported Activity Returns Grant-Bearing URI Via setResult

### Abstract Shape

```text
external app -> exported Activity -> grantUriPermission + setResult(content URI with FLAG_GRANT_READ) -> caller receives URI grant to private data
```

### Key Mistake

An exported Activity receives a content URI, grants read or write permission on it, and returns the URI to the caller via `setResult()`, transferring access to private provider data.

### Why It Was Exploitable

- the Activity is exported and launchable by any external application
- the Activity calls `grantUriPermission()` or sets `FLAG_GRANT_READ_URI_PERMISSION` on the result Intent
- the returned content URI points to a private provider that the caller could not access directly
- the caller extracts the URI from `onActivityResult()` and opens a stream to the private data

### Generalized Detection Rule

Exported Activities that return content URIs via `setResult()` must not include grant flags unless the caller identity has been verified and the data scope is explicitly authorized.

Related: [[patterns/uri-grant-leak]], [[patterns/setresult-leak]]

## Case: FileProvider Broad Root Attacker Navigates With Path Traversal

### Abstract Shape

```text
external app -> FileProvider URI with ../ segments -> openFile() -> File(root, untrusted path) -> private file descriptor returned
```

### Key Mistake

A FileProvider declares a root path element that covers too broad a directory, and the provider does not canonicalize the resolved path before opening the file.

### Why It Was Exploitable

- the FileProvider `<paths>` configuration maps a root to a wide directory such as the app's external storage or `/sdcard/`
- the attacker crafts a URI with encoded `../` segments that escape the intended subdirectory
- `openFile()` constructs a `File` object from the root plus the untrusted path without canonicalization
- the returned ParcelFileDescriptor gives the attacker read or write access to private files outside the intended scope

### Generalized Detection Rule

FileProvider path declarations must use the narrowest possible root. Always canonicalize the resolved path with `File.getCanonicalPath()` and verify it starts with the intended root directory before returning a descriptor.

Related: [[patterns/uri-grant-leak]]

## Case: ClipData Preserves Grant Flags Through Intent Forwarding

### Abstract Shape

```text
external app -> exported Activity -> ClipData with content:// URI + FLAG_GRANT_READ -> forwarded Intent -> private component accesses victim data
```

### Key Mistake

An exported Activity receives an Intent containing ClipData with content URIs and grant flags, then forwards that Intent to another component without stripping the grant permissions.

### Why It Was Exploitable

- the exported Activity receives ClipData bearing `FLAG_GRANT_READ_URI_PERMISSION` from the caller
- the Activity forwards or relays the Intent to a private component, service, or broadcast
- Android propagates the URI grant along with the forwarded Intent
- the receiving component gains access to content URIs that the original caller should not have been able to reach transitively

### Generalized Detection Rule

When forwarding Intents received from external callers, strip ClipData or replace it with vetted URIs. Never relay grant-bearing ClipData without verifying that each URI grant is appropriate for the final recipient.

Related: [[patterns/uri-grant-leak]], [[patterns/setresult-leak]]

## Case: takePersistableUriPermission Survives Beyond Expected Scope

### Abstract Shape

```text
app -> content URI with FLAG_GRANT_PERSISTABLE -> takePersistableUriPermission -> permanent access to private provider data
```

### Key Mistake

The app receives a content URI with `FLAG_GRANT_PERSISTABLE_URI_PERMISSION` and calls `takePersistableUriPermission()`, converting a temporary grant into permanent access that survives reboots and app restarts.

### Why It Was Exploitable

- the granting component sets `FLAG_GRANT_PERSISTABLE_URI_PERMISSION` on the content URI
- the receiving app calls `getContentResolver().takePersistableUriPermission()` to persist the grant
- the persistent grant survives beyond the lifecycle of the granting Activity or the granting app
- the holder can access the provider data indefinitely, even after the user navigates away or the granting component is destroyed

### Generalized Detection Rule

Never set `FLAG_GRANT_PERSISTABLE_URI_PERMISSION` on content URIs shared with external apps unless persistent access is an explicit requirement. Prefer temporary grants that expire when the granting Activity finishes.

Related: [[patterns/uri-grant-leak]]
