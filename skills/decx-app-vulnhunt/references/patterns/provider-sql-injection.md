# Pattern: Provider SQL Injection

## Match

`ContentProvider.query` / `insert` / `update` / `delete` constructs `selection` / `selectionArgs` / `groupBy` / `having` / `orderBy` / `limit` / `path` from caller-controlled values. High-signal variants:
- URI path segment is concatenated into `selection` directly.
- URI query parameter is concatenated into `selection` directly.
- Caller controls the `sortOrder` extra; `ORDER BY` is appended as-is.
- `applyBatch` operates on raw `ContentValues` keyed by attacker-controlled columns.
- `BulkInsert` loops over caller-supplied `ContentValues[]` and writes to a table that includes a sensitive column (e.g. password hash).

## Analyze

- entry: `ContentProvider` public method, `applyBatch`, `BulkInsert`, `call`, URI path/query, deep link with query params, intent extras
- control: URI `path` / `query`, projection, selection, `selectionArgs`, `groupBy`, `having`, `orderBy`, `limit`, `applyBatch` operation array
- sink: `SQLiteDatabase.query` / `rawQuery` / `execSQL` / `insert` / `update` / `delete`, `applyBatch` operation, `BulkInsert` row
- guard: column/table allowlist for `selection`/`groupBy`/`orderBy`/`having`, integer cast for `limit`, never concatenate URI segments into a SQL fragment
- impact: data exfiltration, data tampering (escalate role, change `is_admin`), `sqlite_master` enumeration to map the schema

## Reject

Reject when `selection`/`groupBy`/`orderBy` is hard-coded, every caller-controlled value is bound through `selectionArgs` or routed through an allowlist, and no path builds a SQL fragment from URI/extra.

## Codes

```java
// URI path concatenated into selection — SQL injection
String realSelection = "(path = '" + uri.getPath() + "')";
return db.query("notes", projection, realSelection, selectionArgs, null, null, sortOrder);
```

```java
// sortOrder appended as-is — order-by injection
return db.query("notes", projection, selection, selectionArgs, null, null, sortOrder);
```

```java
// limit from extra is concatenated into the SQL fragment
String limit = uri.getQueryParameter("limit");
return db.query("notes", projection, selection, selectionArgs, null, null, sortOrder, limit);
```

```java
// applyBatch uses raw ContentValues without per-column validation — op.withValue("password_hash", attackerHash) is accepted
```
