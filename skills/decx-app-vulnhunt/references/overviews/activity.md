# Activity - Overview - Security Review

Use this overview for externally reachable Activity, deep-link, result, task, and UI-trust targets. For signal-to-pattern routing, start with `vulnerability-router.md`.

## Analysis Flow

```text
1. decx ard exported-components -P <port>
   -> list exported activities and deep-link handlers
2. decx code class-context "<ActivityClass>" -P <port>
   -> quick overview of all methods and fields
3. decx code method-context "<ActivityClass>.onCreate(android.os.Bundle):void" -P <port>
   -> trace callers and callees of lifecycle entry
4. Check external inputs:
   -> getIntent().get*Extra()
   -> getIntent().getData()
   -> getClipData()
   -> onActivityResult() / ActivityResultLauncher callbacks
5. Check sensitive actions:
   -> startActivity / startService / sendBroadcast
   -> setResult
   -> file read/write helpers
   -> WebView host initialization
6. Confirm whether caller validation, signature checks, package allowlists, or target allowlists exist
```

## Promotion Signals

- external trigger reaches the Activity entrypoint
- attacker-controlled value flows to a sensitive action, file, result, WebView, or component launch
- no non-bypassable signature, UID, caller, session, or exact-target guard blocks the chain
- visible impact is stronger than simple screen opening
- plain exported reachability is usually an entrypoint; route to redirect, task/UI, implicit Intent, result, WebView, file, or PendingIntent references when the downstream behavior owns the real bug
- UI deception and lifecycle issues are usually chain conditions unless they directly cause protected approval, secret exposure, or continued sensitive resource use

## Common False Positives

- Exported Activity exposes only a public screen with no sensitive data or action
- All sensitive branches require a non-bypassable caller or signature check
- Task affinity mismatch is theoretical but no protected action or credential entry is reachable
- Deep link handler validates scheme/host and forwards only to a harmless UI
