# Provider - Component Analysis Guide

Use this guide for ContentProvider, FileProvider, and provider-authority targets.

## Analysis Flow

```text
1. decx ard exported-components -P <port>
   -> list exported providers
2. decx ard app-manifest -P <port>
   -> read provider permissions and authorities
3. decx code class-context "<ProviderClass>" -P <port>
   -> overview of CRUD methods and helpers
4. Check CRUD methods: query, insert, update, delete, openFile, call
5. Check URI matching: UriMatcher, path segments, wildcard patterns
6. Confirm permission checks, caller validation, and path canonicalization
```

## Promotion Signals

- exported or grant-reachable provider method accepts attacker-controlled URI, projection, selection, sortOrder, or path segments without a non-bypassable guard
- URI path construction reaches file APIs without canonical root confinement
- SQL concatenation includes untrusted syntax-bearing fields rather than bound parameters
- call() or batch methods bypass per-operation permission checks present in CRUD methods
- getType() reveals sensitive state that directly enables a downstream attack chain

## False Positive Guide

- **Signature-level permission gates all methods**: verify that every overridden method including call(), applyBatch(), and openFile() is covered, not just the manifest attribute
- **URI matcher uses exact paths with no wildcards**: confirm openFile() is not overridden or delegates to a helper that constructs paths differently
- **SQL uses bound parameters**: check that sortOrder and projection are also validated or allowlisted, not only selectionArgs
- **Provider returns only public data**: confirm all URI paths within the authority return public data and no path exposes a different table or file root
