---
name: client_controlled_auth_input
track: android-app
---

# client_controlled_auth_input

## Match
An authorization, filter or scope decision takes its input from the caller's own request payload instead of a platform-owned object. Request payloads include a `Bundle` extra, `ContentValues`, URI query parameter or clip data.

## Non-obvious
- `MediaProvider.INCLUDED_DEFAULT_DIRECTORIES` (`"android:included-default-directories"`) was read out of the caller's extras by `AccessChecker.getWhereForDefaultDirectoryMatch(extras)` and expanded the query filter to the default directories, so an app that set the extra in `ContentResolver.update(uri, values, extras)` obtained rename access to DCIM/Pictures/Movies (CVE-2025-48544; the fix threads an `Optional<List<String>>` from the platform caller into `getQueryBuilder` and deletes the constant).
- The `android:` prefix on an extra key is naming, not enforcement: the extra arrives through the public `update()`/`call()`/`query()` overloads.
- The decision is consumed as a SQL fragment (`options.add(defaultDirectorySql)`), so the injection point to read is the query-builder call, not the permission check that runs before it.
- Same-shaped code exists on both sides of the boundary — ask where the *value* comes from (`Bundle` of the request vs. a service-side object with the same type).
- MediaProvider's `AccessChecker` is a recurring chokepoint: the 2026-03 bulletin alone carries five more MediaProvider EoP entries (CVE-2025-48567, CVE-2025-48578, CVE-2025-48579, CVE-2025-48582, CVE-2026-0035). Read each fix on its own; only CVE-2025-48544 is the extra-trust mechanism above.

## Reject
The value only widens the caller's own view of data it already owns, or it is validated against a platform-owned allowlist before it reaches the decision.
