# Pattern: Provider SQL Injection

## When To Use

Use this reference when provider inputs influence SQL selection, projection, sort order, table name, raw query text, group/having clauses, or SQLite helper arguments.

## Vulnerability Essence

Attacker-controlled provider query data changes SQL semantics and exposes, modifies, or deletes data outside the intended query boundary.

## Sources

- `selection`, `selectionArgs`, `sortOrder`, projection, URI path segments, query parameters
- `ContentProvider.query/update/delete`, `SQLiteQueryBuilder`, `rawQuery`, `execSQL`
- provider `call()` methods that forward SQL fragments

## Sinks

- `rawQuery`, `execSQL`, string-built `query`, `update`, `delete`
- `SQLiteQueryBuilder` with unvalidated projection map, table, sort, group, or having

## Required Trace Evidence

- Reachability: provider operation is exported, grant-reachable, or accessible to attacker.
- Controllability: attacker controls SQL syntax-bearing fields, not only bound values.
- Sink: controlled fragment reaches SQL execution or query builder semantic fields.
- Missing or bypassable guard: no parameter binding, projection map, table allowlist, or sort/order allowlist blocks injection.
- Visible impact: unauthorized row disclosure, modification, deletion, auth bypass, or meaningful oracle.

## Guard Checklist

Consider safe when values are bound with placeholders, projection/table/sort are allowlisted, URI IDs are parsed as constrained types, and provider permissions cover the affected rows.

## Rejection Rules

Reject when attacker controls only `selectionArgs` bound as values, query output is public/non-sensitive, injected syntax cannot affect SQL structure, or a permission gate blocks the operation.

## Rating Mapping

- HIGH: broad sensitive row disclosure or modification.
- MEDIUM: bounded protected table exposure or single-user data tampering.
- LOW: low-value oracle or metadata leak.
- IGNORED: no semantic SQL control or no sensitive impact.

## Trace Commands

```bash
decx code method-source "<providerQueryOrUpdate>" -P <port>
decx code method-context "<sqliteHelperMethod>" -P <port>
```

## Example Shapes

Suspicious:

```text
external sortOrder -> "... ORDER BY " + sortOrder -> db.rawQuery()
```

Safe:

```text
external sort key -> allowlist map -> SQLite query with bound selectionArgs
```

## Report Snippet

Use: "The exported provider passes attacker-controlled SQL fragments into query construction, enabling unauthorized data access."

Avoid: "Provider uses dynamic SQL" without proving attacker-controlled input reaches the query construction.
