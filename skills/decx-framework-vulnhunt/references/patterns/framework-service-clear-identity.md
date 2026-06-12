# Pattern: Framework Service clearCallingIdentity Misuse

## Match

`Binder.clearCallingIdentity()`, `withCleanCallingIdentity()`, or equivalent wraps attacker-influenced work before authorization, target validation, user binding, or provider/launch/file sink is complete. Also match callback/observer paths where framework-owned code reads attacker-influenced state and forwards it into a privileged protocol or parser without normalization.

## Analyze

- entry: `Binder.clearCallingIdentity()` / `withCleanCallingIdentity()` block, observer/callback that runs as the service, privileged protocol writer, parser, launcher, provider/file helper
- control: `Intent`, `Uri`, `Bundle`, `Parcelable`, package/user/UID/attribution tag, operation name, path, callback, token, async work captured before/inside cleared block, unescaped control characters, argument counts, target identity fields
- sink: provider/file/package/settings/user/device operation, privileged launch/broadcast, callback/scheduled work outliving caller identity, line/argument protocol parser, process/action spawn under service identity
- guard: all authorization and target validation before clear; cleared block uses trusted constants only; `finally` fence with `restoreCallingIdentity(token)` covering every return path; `UserHandle`/UID rebinding before sink; reject or escape protocol delimiters before privileged protocol writes
- impact: attacker-controlled work runs under system/service identity, privileged protocol arguments are injected, or privileged action is attributed to the wrong package/user

## Required Trace Evidence

Reachability, Controllability, Sink, Missing guard, Visible impact

## Reject

Reject when cleared block does only harmless bookkeeping, every attacker-controlled branch is validated before clearing, the privileged callee rechecks caller authorization, identity is restored before sink, privileged protocol payloads are escaped/rejected at the source, or the only work in the cleared block is a constant forwarder with no attacker-controlled value.

## Codes

```java
// service-owned callback forwards attacker-influenced text into a privileged line protocol
protocolWriter.write(argumentCount);
protocolWriter.newLine();
protocolWriter.write(attackerText);
```

```java
// delimiter mismatch: list split removes one separator class, but protocol delimiter remains
for (String arg : attackerText.split(",")) protocolWriter.writeLine(arg);
```

```java
// clearCallingIdentity without finally; restore skipped on exception path
```
