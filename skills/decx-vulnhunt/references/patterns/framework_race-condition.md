---
name: race-condition
track: framework
---

# race-condition

## Match
Authorization, identity, user/package selection, token/callback ownership, provider/file state, or privileged operation depends on mutable state across async/callback/observer/lock/delayed handler/concurrent Binder boundary.

## Non-obvious
- **Check-then-use across `Handler.post`/`Runnable`** is the recurring async TOCTOU shape — check at entry, use after `mHandler.post(...)` is the bug
- Cached callback/token record reuse without rebinding owner at dispatch = identity stale across async hop
- `clearCallingIdentity` missing `finally` fence: See [[framework_clear-identity]]
- **Binder object lifetime mismatch (BadSpin pattern)**: death recipient or link-to-death registered on a Binder object that gets freed and reused; the stale reference points to a new object with different identity/permissions. UAF in kernel Binder driver (`binder_thread` / `binder_proc` reuse after `BC_RELEASE`).
- **Spinlock UAF in kernel**: work item removed under one lock window (`spin_lock` → `list_del` → `spin_unlock` → `kfree`) while another path can still use it — kernel-level race reachable from framework Binder paths
- `synchronized` required on binder release/transaction paths; refcount races produce memory corruption, not just stale auth
- Final authorization recheck at async boundary must use Binder-snapshot identity, not pre-async state

## Reject
Timing not attacker-influenced, no reachable concurrent path, check and use are atomic, final sink rechecks authorization with Binder-snapshot identity, or impact is transient/no-security.
