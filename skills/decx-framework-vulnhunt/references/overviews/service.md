# Framework Service - Overview - Security Review

Framework services run in `system_server` or other privileged processes. The same data-flow bugs seen in apps become far more severe here because the caller crosses into privileged identity.

## Risk Catalog

| Risk | Rating | Reference |
|------|--------|-----------|
| `clearCallingIdentity()` misuse | HIGH | [[patterns/framework-service-clear-identity]] |
| Missing permission enforcement | CRITICAL | [[patterns/framework-service-permission-missing]] |
| Identity confusion | HIGH to CRITICAL | [[patterns/framework-service-identity-confusion]] |
| Cross-user boundary confusion | HIGH to CRITICAL | [[patterns/framework-service-cross-user]] |
| Intent launch / redirect | HIGH | [[patterns/framework-service-intent-launch]] |
| PendingIntent identity reuse | HIGH | [[patterns/framework-service-pendingintent]] |
| ContentProvider proxy | HIGH | [[patterns/framework-service-content-provider-proxy]] |
| Sensitive data leak | HIGH | [[patterns/framework-service-data-leak]] |
| Race condition | MEDIUM to HIGH | [[patterns/framework-service-race-condition]] |

## Analysis Flow

```text
1. decx ard system-service-impl "<Interface>" -P <port> [--page <n>]
2. decx code class-context "<ServiceImpl>" -P <port>
   -> quick overview of all Binder-exposed methods
3. decx code class-source "<ServiceImpl>" -P <port>
4. Inspect Binder-exposed methods for:
   -> enforceCallingPermission / checkCallingPermission
   -> Binder.getCallingUid / UserHandle.getCallingUserId
   -> clearCallingIdentity / restoreCallingIdentity
   -> nested Intent or PendingIntent handling
   -> ContentResolver / URI grant / provider proxy handling
4. Confirm the visible consequence:
   -> privileged action
   -> privileged data read
   -> persistent state change
```

## Key Trace Patterns

- Privileged operations before permission enforcement
- Caller identity inferred from user-supplied parameters
- Identity cleared too early or for too broad a scope
- Binder-exposed methods returning privileged data directly
- Intent forwarding from untrusted IPC into privileged launches
- Framework service proxying provider access for caller-controlled URI

## Key Trace Patterns

- Privileged operations before permission enforcement
- Caller identity inferred from user-supplied parameters
- Identity cleared too early or for too broad a scope
- Binder-exposed methods returning privileged data directly
- Intent forwarding from untrusted IPC into privileged launches
- Framework service proxying provider access for caller-controlled URI
