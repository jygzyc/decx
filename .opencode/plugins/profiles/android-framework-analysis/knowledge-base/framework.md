# Android Framework Vulnerability Routing

## Exploitability gate

A finding needs reachable Binder/system surface, controllable payload, deep trace through identity/user/async/provider/launch boundaries, and visible impact. Missing one stays candidate or dead end.

## Composite chains first

| Chain | Signal | Primary checks |
|---|---|---|
| Missing Binder guard -> clear identity -> privileged sink | Permission/app-op/UID/package/user gate absent before `clearCallingIdentity` or protected callee | service-side guard, identity-clear scope, callee guard |
| Caller package/UID/user confusion -> cross-user/profile action | Caller-supplied package, UID, user, attribution tag, profile, or account is trusted | ownership check, user binding, package-user consistency |
| Binder Intent/Bundle/URI -> privileged launch/broadcast/grant | Service launches, broadcasts, returns, or grants caller-controlled Intent/Uri/flags/selector/ClipData/component/user | strip dangerous fields, target validation, user scope |
| Binder URI -> ContentResolver under system identity | Service queries/opens/updates/grants caller URI after identity clear or as system | provider authority trust, grant target, MIME/path validation |
| Protected state -> unfiltered return/callback | Package/user/account/notification/settings/task/window/policy state returned to lower-privileged caller | scope bound to caller identity |
| Framework PendingIntent -> mutable/fill-in replay | Service creates/stores/sends/cancels PendingIntent with caller-controlled target/extras/flags/request/user | mutability, request-code collision, sender identity |
| Callback/token registration -> async stale authorization | Caller registers callback/listener/observer/token; later async work uses stale or attacker-controlled state | recheck at use, token ownership, cancellation race |
| Transition/remote animation control -> WCT/surface/task impact | Lower-privileged caller controls transition metadata, finish, WCT, SurfaceControl, task mutation | global controller privilege, timeout/fail-safe |
| Validation-execution gap -> LaunchAnyWhere | Intent/URI/Bundle is validated once but mutable resolution, parceling, or provider state changes before actual launch | validate at execution, stable resolved target |
| Parcel mismatch -> different checked and executed object | Parcelable/Bundle serializes to a different semantic object across process, storage, or callback boundaries | key parity, object parity, check-after-unparcel |
| Native socket/HIDL/HAL surface -> privileged operation | Vendor/native service processes external data with weak auth or validation | reachability, SELinux boundary, memory/command impact |

## High-signal single-pattern routing

- Permission missing: no service-side permission/app-op/UID-package/user gate before privileged work, protected return, shell command, dump, or policy change.
- Clear identity misuse: attacker-controlled branch, URI, file, protocol writer, launch, or provider operation occurs inside clean identity before validation completes.
- Identity confusion: trusted package/user/UID/attribution/account value is caller supplied or not checked with ownership APIs.
- Intent launch/grant: caller-controlled Intent, selector, component, flags, ClipData, PendingIntent, or user reaches privileged execution.
- Provider proxy: caller URI is queried/opened/updated/granted by a more privileged service or provider.
- Race/TOCTOU: permission/user/package check occurs before mutable callback/token/state/handler work changes the final target.
- Transition control: WindowOrganizer, TransitionPlayer, RemoteTransition, SurfaceControl, WCT, or remote animation affects other tasks/surfaces.
- Validation gap: `resolveActivity`, MIME, provider result, or URI target changes between check and use.
- Parcel mismatch: a checked Bundle/Parcelable differs after unparcel, serialize, or another framework handoff; compare the checked object and the sink object, not just field names.
- Input method surfaces: IME subtype, binding, callback, current-editor, and user/profile state are high-value because mistakes can expose typed input or cross-user text context.
- Native surface: reachable socket/HIDL/HAL/debug command parses attacker input and reaches memory, file, command, or privileged operation.

## IMA-derived leads to prioritize

- BadResolve-style LaunchAnyWhere issues are resolver-consistency failures. A valid proof must compare the pre-check resolved target with the launch-time target after Bundle/Parcel, component resolver snapshot, provider, and async transitions.
- Bundle mismatch is a first-class framework pattern. If a guard validates `KEY_INTENT`, an extra, or a nested object, require evidence that no parceling round-trip can make system_server and the final consumer see different objects.
- InputMethodManagerService and input subtype parsing deserve early triage in framework reviews. Bind every IME action to caller UID, package, user/profile, editor token, and current session before treating returned text or subtype state as trusted.
- Resolver races need stable-target evidence. If package/component state, provider output, or handler-delayed work can change between check and use, keep the intent open until execution-time validation is shown.

## Rejection rules

Reject when caller cannot reach the method, the exact path is guarded before sink, lower-level callee enforces the same guard, cleared identity wraps constants only, ownership/user checks bind every target, async use revalidates, or the operation is public and harmless.
