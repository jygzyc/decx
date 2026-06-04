# Service - Component Analysis Guide

Use this guide for started services, bound services, AIDL interfaces, Messenger handlers, and foreground service targets.

## Analysis Flow

```text
1. decx ard exported-components -P <port>
   -> list exported services
2. decx ard get-aidl -P <port>
   -> list AIDL interface methods
3. decx code class-context "<ServiceClass>" -P <port>
   -> overview of lifecycle methods
4. Check onStartCommand: action dispatch and extra handling
5. Check onBind / AIDL stub method implementations
6. Check Messenger handler: msg.what dispatch, Bundle handling, replyTo
7. Confirm caller validation, permission checks, and Binder identity checks
```

## Promotion Signals

- exported or bindable service accepts external data that reaches a privileged operation without complete validation
- AIDL/Binder method trusts caller arguments without identity or permission check before performing sensitive work
- onStartCommand() dispatches action strings to different operations without an exhaustive allowlist
- Messenger handler trusts msg.what, Bundle keys, or replyTo without strict verification
- foreground notification exposes sensitive values such as tokens, account names, or message content

## False Positive Guide

- **Signature-level permission gates the service**: verify that onStartCommand() and every AIDL method also enforce the permission, not only the manifest attribute
- **onStartCommand() extras drive only public behavior**: trace the full dispatch chain to confirm no branch reaches file access, component launch, or credential handling
- **AIDL methods validate caller UID**: confirm the check is non-bypassable and covers all code paths including error handling branches
- **onBind() returns null or read-only data**: confirm no other method such as onStartCommand() provides a parallel entry path that bypasses the null bind
