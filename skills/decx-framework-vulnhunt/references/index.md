# Framework Vulnerability Knowledge Base

Use references as a vulnerability knowledge base, not as a workflow manual. `SKILL.md` controls execution; this directory helps identify statically supportable framework-service bugs and route to the right reference.

## Layers

| Layer | Files | Purpose |
|---|---|---|
| Pattern cards | [[patterns/permission-missing]], [[patterns/clear-identity]], [[patterns/identity-confusion]], [[patterns/intent-launch]], [[patterns/pendingintent]], [[patterns/content-provider-proxy]], [[patterns/race-condition]], [[patterns/transition-control]], [[patterns/validation-gap]], [[patterns/native-surface]] | route observed service code to one vulnerability shape and constrain evidence/rejection rules |
| Rating | [[risk-rating]] | final report gate and severity authority |

## Load Order

1. Start with `Composite Framework Chains` and pick the smallest chain that matches observed service code behavior.
2. Load one or two matching pattern cards for source/sink/guard/reject rules. Do not load sibling cards by component name alone — only when the trace crosses that boundary.
3. Apply [[risk-rating]] before promoting any candidate to a finding.

Pattern cards should add one of three things: a routing signal, a non-obvious Binder/identity/permission quirk, or a closed-form constraint that prevents false positives. Stop reading a card when it only repeats generic Android framework security knowledge.

## Composite Framework Chains

Framework findings are strongest when the trace crosses caller identity, user/profile, async, provider, launch, token, callback, or transition boundaries. Prefer this matrix before single-pattern lookup.

| Chain shape | High-signal code behavior | Load first |
|---|---|---|
| Binder missing guard → `clearCallingIdentity` → system-identity privileged sink | Binder method lacks permission/app-op/UID/package/user gate before identity is cleared or before protected callee executes under service identity | [[patterns/permission-missing]], [[patterns/clear-identity]] |
| caller package/UID/user confusion → cross-user/profile data/action | caller-supplied package, UID, user ID, attribution tag, profile, or account target is trusted across user/profile or package ownership boundary | [[patterns/identity-confusion]] |
| Binder Intent/Bundle → privileged launch/broadcast/grant → private target | service launches, broadcasts, returns, or grants using caller-controlled `Intent`, `Bundle`, `Uri`, flags, selector, `ClipData`, component, or user | [[patterns/intent-launch]], [[patterns/pendingintent]], [[patterns/content-provider-proxy]] |
| Binder URI → ContentResolver under system identity → protected provider rows/file fd | service queries, opens, updates, or grants provider/file access for caller-controlled URI under privileged or cleared identity | [[patterns/content-provider-proxy]], [[patterns/clear-identity]] |
| protected state read → unfiltered return/callback → lower-privileged caller | Binder method reads package, user, account, notification, settings, task, window, or policy state and returns it without binding scope to caller identity | [[patterns/permission-missing]], [[patterns/identity-confusion]] |
| framework-created PendingIntent → mutable/fill-in replay → privileged launch/grant | framework service creates, stores, sends, or cancels a `PendingIntent` using caller-controlled target, extras, flags, request code, package, or user and later dispatches it as a privileged context | [[patterns/pendingintent]], [[patterns/intent-launch]] |
| callback/token registration → async stale identity → privileged finish/use | lower-privileged caller registers callback, token, listener, observer, remote delegate, or binder handle; later async work uses stale authorization or attacker-controlled callback state at a privileged sink | [[patterns/race-condition]], [[patterns/identity-confusion]], [[patterns/permission-missing]] |
| transition controller takeover → transition metadata/control → WCT/Surface/task impact | lower-privileged caller registers or becomes global transition/remote-animation controller, receives transition metadata, withholds finish, or supplies attacker-controlled `WindowContainerTransaction`/surface/task mutations | [[patterns/transition-control]], [[patterns/permission-missing]], [[patterns/race-condition]] |
| async TOCTOU → stale permission/user/package state → protected sink | permission/user/package check occurs before mutable state, callback, token reuse, delayed handler, observer, or cross-service call changes the target used at the final sink | [[patterns/race-condition]], [[patterns/permission-missing]], [[patterns/identity-confusion]] |
| attacker provider `getType()` → MIME change between check and launch → LaunchAnyWhere | framework validates Intent with `resolveActivity()`, but `content://` URI `getType()` returns different MIME during actual `startActivity()`, resolving to different component | [[patterns/validation-gap]], [[patterns/intent-launch]] |
| native socket/HIDL/HAL service with weak input validation → privileged operation | vendor service processes external data without bounds checking or authorization; SELinux may be permissive or bypassable | [[patterns/native-surface]] |

## Single Pattern Routing

Use this as fallback when the trace is clearly standalone and does not pivot through another privileged boundary.

| Observed signal | Primary direction | Load first |
|---|---|---|
| missing permission, app-op, UID/package, or user restriction gate | permission missing | [[patterns/permission-missing]] |
| `clearCallingIdentity()` / `withCleanCallingIdentity()` misuse | clear identity | [[patterns/clear-identity]] |
| caller-supplied package/user/UID attribution confusion | identity confusion | [[patterns/identity-confusion]] |
| cross-user/profile target confusion (content URI `userId@authority`, `userId` param) | cross-user | [[patterns/identity-confusion]] |
| privileged Intent launch, redirect, broadcast, grant, or PendingIntent dispatch | intent launch | [[patterns/intent-launch]] |
| framework-created or framework-sent PendingIntent identity reuse | pendingintent | [[patterns/pendingintent]] |
| ContentProvider proxy, URI grant, or provider-backed file descriptor access | content provider proxy | [[patterns/content-provider-proxy]] |
| `applyBatch`/`call()` bypassing per-operation permission check | batch/call bypass | [[patterns/content-provider-proxy]], [[patterns/permission-missing]] |
| protected framework data returned to lower-privileged callers | data leak | [[patterns/permission-missing]] |
| callback, listener, token, observer, or remote delegate registration controls later privileged work | callback/token abuse | [[patterns/race-condition]], [[patterns/identity-confusion]] |
| WindowOrganizer, TransitionPlayer, RemoteTransition, SurfaceControl, or WCT control | transition control | [[patterns/transition-control]] |
| TOCTOU, async, callback, token, or mutable-state race | race condition | [[patterns/race-condition]] |
| `onShellCommand` override bypasses default UID=root/shell gate | shell surface bypass | [[patterns/permission-missing]] |
| framework validates Intent then launches it, but `content://` URI `getType()` changes between check and launch | validation-execution gap | [[patterns/validation-gap]] |
| attacker-controlled provider `getType()` returns different MIME on successive calls, affecting intent-filter resolution | getType() TOCTOU | [[patterns/validation-gap]] |
| native socket/HIDL/HAL service processes external input with weak validation | native service surface | [[patterns/native-surface]] |
| vendor-specific debug interface or HAL service reachable via shell/app | OEM/HAL attack surface | [[patterns/native-surface]] |
| framework validates Intent/URI then returns to caller for execution, mutable state between | validation-execution gap | [[patterns/validation-gap]] |
