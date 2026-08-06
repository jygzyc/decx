---
name: provider-leak
track: app
---

# provider-leak

## Match
Exported or grant-reachable ContentProvider where `query`/`openFile`/`call`/`getType`/`applyBatch`/`bulkInsert` returns data, handles, MIME, or writes attacker-controlled values to protected rows/files.

Three primitive shapes:
- **Read/call leak**: `query`/`call`/`getType` returns protected data; `call` and `applyBatch` skip per-operation permission check that CRUD applies
- **SQL injection**: `sortOrder` appended as-is (ORDER BY injection even with parameterized selection); `limit` from URI query param concatenated into SQL fragment; `applyBatch` `ContentValues` keyed by attacker-controlled columns
- **Path traversal**: `getLastPathSegment()` auto-decodes `%2F`/`%2E%2E%2F` — `..%2Fsecret.db` becomes `../secret.db` before concatenation; custom `FileProvider` must decode→normalize→confine (3 steps)

## Non-obvious
- `getType(uri)` returns different MIME based on file existence — boolean oracle for protected state
- **`call()` requires either `readPermission` OR `writePermission`** — a write-only provider still exposes `call()` for reading actions
- **Dynamic URI proxying**: `Uri.parse(uri.getQueryParameter("uri"))` lets attacker redirect query to ANY provider the app can access (including system providers via app's permissions)
- **Permission downgrade proxy**: exported provider with `normal`-level permission proxies to system provider with `dangerous`-level permission (e.g., contacts) — attacker obtains cheap permission, gets expensive data
- **Mixed database**: two providers with different permissions sharing one SQLite file — SQL injection in insensitive provider crosses to sensitive table via `UNION SELECT * FROM SensitiveTable --`
- **Internal action exposure**: non-exported provider with debug/admin `query()` branch still reachable via internal `ContentResolver.query()` calls that accept external URIs (chains with intent-redirect)
- `<root-path name="root" path="."/>` shares every file the app process can read
- `ACTION_SEND` share target: handler `query(uri)` for `_display_name` from caller's provider, uses returned string as filename — attacker controls both source and name
- Persistent grant via `takePersistableUriPermission`: See [[app_uri-grant]]
- `sqlite_master` enumeration via `groupBy` injection maps schema for second-stage attack

## Reject
Non-bypassable permission/row/path guard covers the exact method, write-only with no readback, no grant chain crosses trust boundary, or providers use separate database files with no shared tables.
