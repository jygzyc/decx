# Pattern: Provider SQL Injection

## When To Use

Use this reference when provider inputs influence SQL selection, projection, sort order, table name, raw query text, group/having clauses, or SQLite helper arguments.

## Core Concept

Attacker-controlled provider query data changes SQL semantics and exposes, modifies, or deletes data outside the intended query boundary.

**Sources**
- `selection`, `selectionArgs`, `sortOrder`, projection, URI path segments, query parameters
- `ContentProvider.query/update/delete`, `SQLiteQueryBuilder`, `rawQuery`, `execSQL`
- provider `call()` methods that forward SQL fragments

**Sinks**
- `rawQuery`, `execSQL`, string-built `query`, `update`, `delete`
- `SQLiteQueryBuilder` with unvalidated projection map, table, sort, group, or having

## Guards & Rejection

Safe when: values are bound with placeholders, projection/table/sort are allowlisted, URI IDs are parsed as constrained types, and provider permissions cover the affected rows.

Reject when: attacker controls only `selectionArgs` bound as values, query output is public/non-sensitive, injected syntax cannot affect SQL structure, or a permission gate blocks the operation.

## Rating

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

Report guidance -- Use: "The exported provider passes attacker-controlled SQL fragments into query construction, enabling unauthorized data access." Avoid: "Provider uses dynamic SQL" without proving attacker-controlled input reaches the query construction.
