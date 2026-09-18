---
name: harness_base
track: android-poc
---

# harness_base

## Match
Building the `poc-<target>/` skeleton itself: naming, manifest shape, exploit registry and trigger dispatch are fixed by the base contract.

## Non-obvious
- Project root `poc-<target>/` holds `app/` and `server/`; `<target>` must match `^[a-z][a-z0-9]*$`; package/applicationId is `com.poc.<target>` and the app label is `PoC`.
- `PoCActivity` must be `android:exported="true"` with `android:launchMode="singleTask"` and exactly two intent-filters: MAIN/LAUNCHER, and VIEW with DEFAULT+BROWSABLE on scheme `poc-<target>`, host `run`, pathPrefix `/trigger`.
- `singleTask` means a second trigger reuses the activity: dispatch must happen in `onNewIntent` after `setIntent(intent)`, or the deep-link data is dropped.
- Dispatch resolves `intent.getStringExtra("exploit")` before `intent.getData().getQueryParameter("exploit")`, so a stale extra wins over a fresh deep link; empty or unknown ids only warn and return.
- Register exactly one exploit id from the spec through `ExploitRegistry.register(id, title, action)`; `findById` returns the first id match, else null.
- Helper manifest components are added only when `supportComponents` requires them — not for capture, interception or convenience.
- Replace every package/action/URI/extra/Binder placeholder with finding evidence; generate the project from the contract, never from a copied template.

## Reject
The target regex, `com.poc.<target>` naming or the exported plus singleTask manifest shape cannot be reconciled with the spec — stop instead of adding a second activity or export.
