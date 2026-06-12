# Framework Vulnerability References

Use references as framework vulnerability pattern knowledge. `SKILL.md` controls workflow and evidence states; this directory helps identify statically supportable framework-service bugs.

## Layers

| Layer | Files | Purpose |
|---|---|---|
| Overview | [[overviews/service]] | map Binder/service entrypoints to pattern cards and chain pivots |
| Pattern cards | [[patterns/framework-service-permission-missing]], [[patterns/framework-service-clear-identity]], [[patterns/framework-service-identity-confusion]], [[patterns/framework-service-transition-control]] | route observed service code to one vulnerability shape and constrain evidence/rejection rules |
| Casebooks | [[casebooks/framework-service-cases]] | preserve exploit-chain examples as abstract shapes |
| Rating | [[risk-rating]] | final report gate and severity authority |

## Load Order

1. Start with `Composite Framework Chains`.
2. Load [[overviews/service]] to map Binder entrypoints and privileged sinks.
3. Load the one or two matching pattern cards for source/sink/guard/reject rules. Do not load sibling cards by component name alone — only when the trace crosses that boundary.
4. Use [[casebooks/framework-service-cases]] only for comparable exploit-chain shapes.
5. Use `Single Pattern Routing` only for standalone bugs.
6. Apply [[risk-rating]] before moving a candidate to `statically-supported`.

Pattern cards should add one of three things: a routing signal, a project/casebook-specific trace cue, or a closed-form constraint that prevents false positives. Stop reading a card when it only repeats generic Android framework security knowledge.

## Composite Framework Chains

Framework findings are strongest when the trace crosses caller identity, user/profile, async, provider, launch, token, callback, or transition boundaries. Prefer this matrix before single-pattern lookup.

| Chain shape | High-signal code behavior | Load first |
|---|---|---|
| Binder missing guard -> `clearCallingIdentity` -> system-identity privileged sink | Binder method lacks permission/app-op/UID/package/user gate before identity is cleared or before protected callee executes under service identity | [[overviews/service]], [[patterns/framework-service-permission-missing]], [[patterns/framework-service-clear-identity]], [[casebooks/framework-service-cases]] |
| caller package/UID/user confusion -> cross-user/profile data/action | caller-supplied package, UID, user ID, attribution tag, profile, or account target is trusted across user/profile or package ownership boundary | [[patterns/framework-service-identity-confusion]], [[patterns/framework-service-cross-user]], [[casebooks/framework-service-cases]] |
| Binder Intent/Bundle -> privileged launch/broadcast/grant -> private target | service launches, broadcasts, returns, or grants using caller-controlled `Intent`, `Bundle`, `Uri`, flags, selector, `ClipData`, component, or user | [[patterns/framework-service-intent-launch]], [[patterns/framework-service-pendingintent]], [[patterns/framework-service-content-provider-proxy]], [[casebooks/framework-service-cases]] |
| Binder URI -> ContentResolver under system identity -> protected provider rows/file fd | service queries, opens, updates, or grants provider/file access for caller-controlled URI under privileged or cleared identity | [[patterns/framework-service-content-provider-proxy]], [[patterns/framework-service-data-leak]], [[patterns/framework-service-clear-identity]], [[casebooks/framework-service-cases]] |
| protected state read -> unfiltered return/callback -> lower-privileged caller | Binder method reads package, user, account, notification, settings, task, window, or policy state and returns it without binding scope to caller identity | [[patterns/framework-service-data-leak]], [[patterns/framework-service-permission-missing]], [[patterns/framework-service-identity-confusion]], [[casebooks/framework-service-cases]] |
| framework-created PendingIntent -> mutable/fill-in replay -> privileged launch/grant | framework service creates, stores, sends, or cancels a `PendingIntent` using caller-controlled target, extras, flags, request code, package, or user and later dispatches it as a privileged context | [[patterns/framework-service-pendingintent]], [[patterns/framework-service-intent-launch]], [[casebooks/framework-service-cases]] |
| callback/token registration -> async stale identity -> privileged finish/use | lower-privileged caller registers callback, token, listener, observer, remote delegate, or binder handle; later async work uses stale authorization or attacker-controlled callback state at a privileged sink | [[patterns/framework-service-race-condition]], [[patterns/framework-service-identity-confusion]], [[patterns/framework-service-permission-missing]], [[casebooks/framework-service-cases]] |
| transition controller takeover -> transition metadata/control -> WCT/Surface/task impact | lower-privileged caller registers or becomes global transition/remote-animation controller, receives transition metadata, withholds finish, or supplies attacker-controlled `WindowContainerTransaction`/surface/task mutations | [[patterns/framework-service-transition-control]], [[patterns/framework-service-permission-missing]], [[patterns/framework-service-race-condition]], [[casebooks/framework-service-cases]] |
| async TOCTOU -> stale permission/user/package state -> protected sink | permission/user/package check occurs before mutable state, callback, token reuse, delayed handler, observer, or cross-service call changes the target used at the final sink | [[patterns/framework-service-race-condition]], [[patterns/framework-service-permission-missing]], [[patterns/framework-service-identity-confusion]], [[casebooks/framework-service-cases]] |

## Single Pattern Routing

Use this as fallback when the trace is clearly standalone and does not pivot through another privileged boundary.

| Knowledge area | Canonical pattern |
|---|---|
| missing permission, app-op, UID/package, or user restriction gate | [[patterns/framework-service-permission-missing]] |
| `clearCallingIdentity()` / clean identity misuse | [[patterns/framework-service-clear-identity]] |
| caller-supplied package/user/UID attribution confusion | [[patterns/framework-service-identity-confusion]] |
| cross-user/profile target confusion | [[patterns/framework-service-cross-user]] |
| privileged Intent launch, redirect, broadcast, grant, or PendingIntent dispatch | [[patterns/framework-service-intent-launch]] |
| framework-created or framework-sent PendingIntent identity reuse | [[patterns/framework-service-pendingintent]] |
| ContentProvider proxy, URI grant, or provider-backed file descriptor access | [[patterns/framework-service-content-provider-proxy]] |
| protected framework data returned to lower-privileged callers | [[patterns/framework-service-data-leak]] |
| callback, listener, token, observer, or remote delegate registration controls later privileged work | [[patterns/framework-service-race-condition]], [[patterns/framework-service-identity-confusion]] |
| WindowOrganizer, TransitionPlayer, RemoteTransition, SurfaceControl, or WCT control | [[patterns/framework-service-transition-control]] |
| TOCTOU, async, callback, token, or mutable-state race | [[patterns/framework-service-race-condition]] |
