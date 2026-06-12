# Pattern: Framework Service Race Condition

## Match

Authorization, identity, user/package selection, token/callback ownership, provider/file state, or privileged operation depends on mutable state across async, callback, observer, lock, delayed handler, or concurrent Binder boundary. High-signal shapes include check-then-use across handlers, stale callback/token records, Binder object lifetime mismatch, and identity restore paths that can be skipped before the next privileged operation.

## Analyze

- entry: Binder method plus async/callback/handler/observer path reachable by attacker; Binder transaction/release lifetime path; delayed `Handler` message with attacker-controlled `what`/`Bundle`; callback or pending-result handoff
- control: checked state, token, callback, package/user record, pending operation, file/provider path, transition state, lifetime/refcount state, queued work item
- sink: privileged state update, data return, grant/PI dispatch, provider/file access, cross-user launch, transition finish, cross-service call, memory/lifetime corruption primitive
- guard: lock/immutable snapshot, final authorization recheck at the async boundary, token owner binding, identity/user/package rebound at sink, atomic check-and-act, `finally` fence with `restoreCallingIdentity(token)`, `synchronized` on binder release/transaction paths
- impact: stale authorization reaches protected sink, wrong identity/target is used, or concurrent lifetime misuse creates a memory-safety primitive

## Required Trace Evidence

Reachability, Controllability, Sink, Missing guard, Visible impact

## Reject

Reject when timing is not attacker-influenced, no reachable concurrent path exists, check and use are atomic, the final sink rechecks authorization using a Binder-snapshot identity, or impact is transient/no-security.

## Codes

```c
// failure cleanup releases a partially initialized Binder object/lifetime state
if (parse_failed) goto err_release_with_stale_offset;
```

```c
// work item removed under one lock window while another path can still use it
spin_lock(&proc->todo_lock);
list_del(&work->todo);
spin_unlock(&proc->todo_lock);
kfree(work);
```

```java
// cached callback/token record reused without rebinding owner at dispatch
record = records.get(token);
dispatch(record.packageName, record.userId);
```

```java
// clearCallingIdentity without finally; restore skipped on exception path
```
