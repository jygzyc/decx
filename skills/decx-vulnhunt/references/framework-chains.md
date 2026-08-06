## Composite Framework Chains

Framework findings are strongest when the trace crosses caller identity, user/profile, async, provider, launch, token, callback, or transition boundaries.

| Chain shape | High-signal code behavior | Load first |
|---|---|---|
| Binder missing guard → `clearCallingIdentity` → system-identity privileged sink | Binder method lacks permission/app-op/UID/package/user gate before identity is cleared or before protected callee executes under service identity | [[patterns/framework_permission-missing]], [[patterns/framework_clear-identity]] |
| caller package/UID/user confusion → cross-user/profile data/action | caller-supplied package, UID, user ID, attribution tag, profile, or account target is trusted across user/profile or package ownership boundary | [[patterns/framework_identity-confusion]] |
| Binder Intent/Bundle → privileged launch/broadcast/grant → private target | service launches, broadcasts, returns, or grants using caller-controlled `Intent`, `Bundle`, `Uri`, flags, selector, `ClipData`, component, or user | [[patterns/framework_intent-launch]], [[patterns/framework_pendingintent]], [[patterns/framework_content-provider-proxy]] |
| Binder URI → ContentResolver under system identity → protected provider rows/file fd | service queries, opens, updates, or grants provider/file access for caller-controlled URI under privileged or cleared identity | [[patterns/framework_content-provider-proxy]], [[patterns/framework_clear-identity]] |
| protected state read → unfiltered return/callback → lower-privileged caller | Binder method reads package, user, account, notification, settings, task, window, or policy state and returns it without binding scope to caller identity | [[patterns/framework_permission-missing]], [[patterns/framework_identity-confusion]] |
| framework-created PendingIntent → mutable/fill-in replay → privileged launch/grant | framework service creates, stores, sends, or cancels a `PendingIntent` using caller-controlled target, extras, flags, request code, package, or user and later dispatches it as a privileged context | [[patterns/framework_pendingintent]], [[patterns/framework_intent-launch]] |
| callback/token registration → async stale identity → privileged finish/use | lower-privileged caller registers callback, token, listener, observer, remote delegate, or binder handle; later async work uses stale authorization or attacker-controlled callback state at a privileged sink | [[patterns/framework_race-condition]], [[patterns/framework_identity-confusion]], [[patterns/framework_permission-missing]] |
| transition controller takeover → transition metadata/control → WCT/Surface/task impact | lower-privileged caller registers or becomes global transition/remote-animation controller, receives transition metadata, withholds finish, or supplies attacker-controlled `WindowContainerTransaction`/surface/task mutations | [[patterns/framework_transition-control]], [[patterns/framework_permission-missing]], [[patterns/framework_race-condition]] |
| async TOCTOU → stale permission/user/package state → protected sink | permission/user/package check occurs before mutable state, callback, token reuse, delayed handler, observer, or cross-service call changes the target used at the final sink | [[patterns/framework_race-condition]], [[patterns/framework_permission-missing]], [[patterns/framework_identity-confusion]] |
| attacker provider `getType()` → MIME change between check and launch → LaunchAnyWhere | framework validates Intent with `resolveActivity()`, but `content://` URI `getType()` returns different MIME during actual `startActivity()`, resolving to different component | [[patterns/framework_validation-gap]], [[patterns/framework_intent-launch]] |
| native socket/HIDL/HAL service with weak input validation → privileged operation | vendor service processes external data without bounds checking or authorization; SELinux may be permissive or bypassable | [[patterns/framework_native-surface]] |

## Single Pattern Routing

Use this as fallback when the trace is clearly standalone and does not pivot through another privileged boundary.

| Observed signal | Primary direction | Load first |
|---|---|---|
| missing permission, app-op, UID/package, or user restriction gate | permission missing | [[patterns/framework_permission-missing]] |
| `clearCallingIdentity()` / `withCleanCallingIdentity()` misuse | clear identity | [[patterns/framework_clear-identity]] |
| caller-supplied package/user/UID attribution confusion | identity confusion | [[patterns/framework_identity-confusion]] |
| cross-user/profile target confusion (content URI `userId@authority`, `userId` param) | cross-user | [[patterns/framework_identity-confusion]] |
| privileged Intent launch, redirect, broadcast, grant, or PendingIntent dispatch | intent launch | [[patterns/framework_intent-launch]] |
| framework-created or framework-sent PendingIntent identity reuse | pendingintent | [[patterns/framework_pendingintent]] |
| ContentProvider proxy, URI grant, or provider-backed file descriptor access | content provider proxy | [[patterns/framework_content-provider-proxy]] |
| `applyBatch`/`call()` bypassing per-operation permission check | batch/call bypass | [[patterns/framework_content-provider-proxy]], [[patterns/framework_permission-missing]] |
| protected framework data returned to lower-privileged callers | data leak | [[patterns/framework_permission-missing]] |
| callback, listener, token, observer, or remote delegate registration controls later privileged work | callback/token abuse | [[patterns/framework_race-condition]], [[patterns/framework_identity-confusion]] |
| WindowOrganizer, TransitionPlayer, RemoteTransition, SurfaceControl, or WCT control | transition control | [[patterns/framework_transition-control]] |
| TOCTOU, async, callback, token, or mutable-state race | race condition | [[patterns/framework_race-condition]] |
| `onShellCommand` override bypasses default UID=root/shell gate | shell surface bypass | [[patterns/framework_permission-missing]] |
| framework validates Intent then launches it, but `content://` URI `getType()` changes between check and launch | validation-execution gap | [[patterns/framework_validation-gap]] |
| attacker-controlled provider `getType()` returns different MIME on successive calls, affecting intent-filter resolution | getType() TOCTOU | [[patterns/framework_validation-gap]] |
| native socket/HIDL/HAL service processes external input with weak validation | native service surface | [[patterns/framework_native-surface]] |
| vendor-specific debug interface or HAL service reachable via shell/app | OEM/HAL attack surface | [[patterns/framework_native-surface]] |
| framework validates Intent/URI then returns to caller for execution, mutable state between | validation-execution gap | [[patterns/framework_validation-gap]] |
