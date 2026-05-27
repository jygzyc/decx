# Pattern: Service Command Injection

## When To Use

Use this reference when an externally reachable started or bound service consumes attacker-controlled action, extras, URI, nested intent, path, command, message, or target.

## Vulnerability Essence

Untrusted service input drives protected app work, victim-identity component launch, file/provider access, or command-like dispatch without complete validation.

## Sources

- `onStartCommand`, `onHandleIntent`, JobIntentService/work manager handoff
- AIDL/Binder/Messenger parameters
- action strings, extras, URI, path, nested `Intent`, command name, target ID

## Sinks

- file/provider/network/account operations
- component launch/broadcast/service dispatch
- shell/interpreter execution only when directly proven
- pending intent creation or send

## Required Trace Evidence

- Reachability: attacker can start/bind/message the service.
- Controllability: attacker controls the command or sink arguments.
- Sink: controlled value reaches protected work.
- Missing or bypassable guard: manifest permission, Binder validation, action allowlist, and payload checks do not block the exact sink.
- Visible impact: protected action, data access, victim-identity launch, or provider/file abuse.

## Guard Checklist

Consider safe when manifest/signature permission and in-code caller checks protect the service, command names map to trusted constants, payloads are validated before use, and downstream sinks recheck permissions.

## Rejection Rules

Reject reachability-only, benign refresh/logging/no-op actions, crash-only paths, and shell-injection claims without a shell/interpreter or equivalent command sink.

## Rating Mapping

- HIGH: victim app performs dangerous action or exposes sensitive data.
- MEDIUM: bounded protected workflow requiring local malicious app.
- LOW: weak UI/service noise.
- IGNORED: no protected downstream behavior.

## Trace Commands

```bash
decx code method-context "<serviceEntryMethod>" -P <port>
decx code method-source "<dispatchOrSinkMethod>" -P <port>
```

## Example Shapes

Suspicious:

```text
exported bound service -> AIDL method trusts caller args without validation -> dispatches to privileged internal action
```

Safe:

```text
exported bound service -> AIDL method validates caller UID/package -> only permitted operations reachable
```

## Report Snippet

Use: "An externally reachable service dispatches attacker-controlled command data to protected work without complete validation."

Avoid: "service is exported" without proving caller-controlled args reach a privileged method without guard.
