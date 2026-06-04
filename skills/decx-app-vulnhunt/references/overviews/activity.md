# Activity - Component Analysis Guide

Use this guide for exported Activity, deep-link handler, result-returning, task-affinity, and UI-trust targets.

## Analysis Flow

```text
1. decx ard exported-components -P <port>
   -> list exported activities and deep-link handlers
2. decx code class-context "<ActivityClass>" -P <port>
   -> quick overview of all methods and fields
3. decx code method-context "<ActivityClass>.onCreate(android.os.Bundle):void" -P <port>
   -> trace callers and callees of lifecycle entry
4. Check external inputs:
   -> getIntent().get*Extra(), getIntent().getData(), getClipData()
   -> onActivityResult() / ActivityResultLauncher callbacks
   -> onNewIntent() re-entry (singleTop / singleTask)
5. Check sensitive actions:
   -> startActivity / startService / sendBroadcast
   -> setResult with sensitive data or grants
   -> file read/write helpers
   -> WebView host initialization
   -> PendingIntent creation with caller data
6. Confirm caller validation: signature checks, package allowlists, target allowlists
```

## Promotion Signals

- external trigger reaches the Activity entrypoint with attacker-controlled data
- attacker-controlled value flows to a sensitive sink: component launch, setResult, file operation, WebView load, or PendingIntent creation
- no non-bypassable signature, UID, caller, session, or exact-target guard blocks the chain
- visible impact exceeds simple screen display
- exported reachability alone is an entrypoint; route to redirect, task/UI, implicit Intent, result, WebView, or PendingIntent patterns when downstream behavior owns the real bug
- UI deception and lifecycle issues are chain conditions unless they directly cause protected approval, secret exposure, or persistent resource misuse

## False Positive Guide

- **Exported Activity with only public UI**: check whether any extras, URI parameters, or result paths trigger hidden sensitive branches before concluding the screen is harmless
- **All sensitive branches require signature checks**: verify the check is enforced at runtime and not behind a debug-only or configurable flag
- **Task affinity mismatch is theoretical**: confirm whether any protected action, credential entry, or approval dialog exists in the back stack before dismissing
- **Deep link validates scheme/host**: trace whether validation is exact (normalized comparison) and whether redirected data still reaches secondary sinks like WebView loads or component launches
