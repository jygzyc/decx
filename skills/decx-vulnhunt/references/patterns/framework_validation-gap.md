---
name: validation-gap
track: framework
---

# validation-gap

## Match
Framework service validates an Intent/URI/component at time T1 (e.g., `resolveActivity`, `checkKeyIntent`, `checkUri`), then hands it to a caller or async path for execution at T2. Between T1 and T2, attacker-controlled state changes what the execution resolves to.

## Direction hints
- **`ContentProvider.getType()` is attacker-controlled code** — it executes victim app's provider code and can return different MIME on successive calls (counter, time, state-based). Any framework path that resolves MIME via `getType()` during validation AND again during execution has this gap.
- **`resolveActivity()` vs `startActivity()` gap**: implicit Intent with `content://` data — `resolveActivity` calls `provider.getType(uri)` for MIME matching; `startActivity` calls it AGAIN. If MIME differs, different component matches.
- **`AccountManagerService.checkKeyIntent()`** is the canonical instance: validates authenticator-returned Intent is safe, returns Bundle to caller, caller does `startActivity` — but `getType()` changed between check and launch.
- **`checkKeyIntentParcelledCorrectly()`** validates Bundle consistency before/after deserialization — but this does NOT cover state that changes between validation and use (only covers Bundle internal consistency).
- **Generalized**: any framework API with pattern `validate(input) → return input to lower-privileged caller → caller executes input` where `input` contains references to mutable external state (provider, file, settings, time-dependent resolution).

## Reject
Intent has explicit component (no resolution needed), no mutable external state referenced between validation and execution, or validation pins the component before returning.
