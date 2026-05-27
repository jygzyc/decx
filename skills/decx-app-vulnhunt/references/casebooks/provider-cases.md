# Casebook: Provider Bugs

Use this casebook after `patterns/provider-data-leak.md`, `patterns/provider-path-traversal.md`, or `patterns/provider-sql-injection.md`. Cases describe reusable exploit-chain shapes.

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

See: `patterns/provider-path-traversal.md`

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

See: `patterns/provider-sql-injection.md`
