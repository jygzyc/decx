# Service - Overview - Security Review

Use this overview for started services, bound services, AIDL, Messenger, and foreground notification targets. For signal-to-pattern routing, start with `vulnerability-router.md`.

## Analysis Flow

```text
1. decx ard exported-components -P <port>
2. decx ard get-aidl --exclude-package "androidx\\..*" --exclude-package "android\\.support\\..*" -P <port>
3. decx code class-context "<ServiceClass>" -P <port>
   -> quick overview of onBind, onStartCommand, handlers, AIDL stubs
4. decx code class-source "<ServiceClass>" -P <port>
   -> inspect Binder / Messenger / Intent handling logic
5. Confirm whether the service enforces:
   -> manifest permission
   -> Binder caller validation
   -> package/signature allowlists
   -> action and parameter allowlists
```

## Promotion Signals

- external caller can start or bind the service
- attacker-controlled action, extras, Binder params, or message fields reach sensitive work
- manifest permission and in-code caller validation are absent or bypassable
- impact is protected data, unauthorized action, victim identity reuse, or visible leak
- foreground notification exposure is usually low or supporting evidence unless the displayed value is itself sensitive and readable

## Common False Positives

- AIDL/Binder method is gated by a signature permission or caller UID check
- `onStartCommand` extras are consumed but only drive public or harmless behavior
- `Messenger` validates `msg.what` against a strict allowlist before dispatching
- Bound service is not exported and no binding Intent can reach it from outside
