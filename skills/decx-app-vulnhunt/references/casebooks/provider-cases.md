# Casebook: Provider Bugs

Use this casebook after [[patterns/provider-data-leak]], [[patterns/provider-path-traversal]], or [[patterns/provider-sql-injection]]. Cases describe reusable exploit-chain shapes.

## Public Case: Provider Path Traversal Reaches Private Files

### Source Type

Public Android vulnerability database/advisory pattern for provider path traversal and app-private file exposure.

### Abstract Shape

```text
external content URI -> provider openFile/query path -> decoded segment -> private file descriptor
```

### Key Mistake

The provider maps caller-controlled URI path data to a filesystem location without canonical root confinement after decoding and symlink resolution.

### Why It Was Exploitable

- provider is exported, grant-reachable, or reachable through another component
- attacker controls the path segment or encoded separator
- file helper resolves outside the intended root
- returned descriptor or query output exposes private data or overwrites app-owned files

### Generalized Detection Rule

For every provider path-to-file mapping, verify canonical path confinement after decode and before returning descriptors, grants, or result URIs.

### Related

[[patterns/provider-path-traversal]], [[patterns/provider-data-leak]], [[patterns/uri-grant-leak]]

## Case: Path Segment Opens App-Private File

### Abstract Shape

```text
external content URI -> provider path segment -> File(root, segment) -> openFile -> private XML/DB
```

### Key Mistake

The provider treats path segments as safe file names without canonical root confinement.

### Why It Was Exploitable

- provider method is exported or grant-reachable
- attacker controls the segment used in path construction
- `..`, symlink, or encoded separator escapes the intended root
- returned descriptor exposes private app data

### Generalized Detection Rule

Any provider path-to-file mapping needs canonical path checks after decoding and resolution.

Related: [[patterns/provider-path-traversal]]

## Case: Sort Order Changes SQL Semantics

### Abstract Shape

```text
external query sortOrder -> string-built SQL -> rawQuery -> protected table rows
```

### Key Mistake

The provider binds values but concatenates syntax-bearing fields such as table, projection, order, group, or having.

### Why It Was Exploitable

- attacker can invoke provider query/update/delete
- attacker controls a SQL syntax field
- generated query reaches a protected table or bypasses row restrictions
- output or state change is visible to the caller

### Generalized Detection Rule

Treat provider SQL fields as dangerous unless they are mapped through an allowlist or bound as values.

Related: [[patterns/provider-sql-injection]]

## Case: call() Method Bypasses Permission Gate

### Abstract Shape

```text
external app -> provider.call(method, arg, extras) -> internal data lookup -> return protected rows
```

### Key Mistake

The provider enforces `readPermission` or `writePermission` on `query()`, `insert()`, `update()`, `delete()` but the overridden `call()` method performs the same data access without any permission check.

### Why It Was Exploitable

- `call()` is not subject to the manifest-declared `readPermission`/`writePermission` attributes
- method dispatches to the same internal cursor or helper used by guarded CRUD methods
- attacker invokes the provider via `ContentResolver.call()` from any third-party app
- returned Bundle or data reveals rows that `query()` would have rejected
- no runtime permission check exists inside the `call()` override

### Generalized Detection Rule

If a provider overrides `call()` and that method reaches protected data without its own permission guard, flag it as a permission bypass.

Related: [[patterns/provider-data-leak]]

## Case: Batch Operation Skips Per-Row Validation

### Abstract Shape

```text
external app -> provider.applyBatch(operations) -> bulk insert -> restricted rows inserted without per-row check
```

### Key Mistake

The provider validates each `insert()` call individually but `applyBatch()` executes the operations through a code path that bypasses the validation loop.

### Why It Was Exploitable

- `applyBatch()` may use a shared transaction or optimized path that skips per-operation hooks
- validation logic lives in `insert()` but `bulkInsert()` or `ContentProviderOperation` execution does not route through it
- attacker submits a batch containing rows that would be rejected individually
- the batch commits atomically, making rollback dependent on explicit transaction handling
- the resulting data state violates the app's intended invariants

### Generalized Detection Rule

When a provider has per-row validation in `insert()` or `update()`, verify that `applyBatch()` and `bulkInsert()` exercise the same checks before committing.

Related: [[patterns/provider-data-leak]]
