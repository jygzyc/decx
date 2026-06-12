# Pattern: Broadcast Abuse

## Match

Receiver reachable by untrusted sender via `<intent-filter>` (implied `exported="true"`) or dynamic `registerReceiver` without `RECEIVER_NOT_EXPORTED` (Android 13+). Ordered broadcast result mutation is the highest-impact variant — a priority hijacker rewrites the result and downstream receivers see a forged security decision.

## Analyze

- trace both sides of the broadcast: the sender's target restrictions and the receiver's trust decision. For ordered broadcasts, follow `getResultData` / `getResultExtras` reads in downstream receivers because the attacker may control the result rather than the original `Intent`.
- entry: `<receiver>` (exported), `registerReceiver` without `RECEIVER_NOT_EXPORTED` (Android 13+), ordered broadcast result callback
- control: action/extras, `abortBroadcast`, `setResultData`/`setResultExtras` mutating downstream, `setPackage(packageName)` vs unrestricted
- sink: ordered result mutation alters security decision (e.g. "deny"→"allow"), protected action dispatch, result payload leak
- guard: `RECEIVER_NOT_EXPORTED` (Android 13+) for internal-only dynamic receivers, `Binder.getCallingUid()` before trusted sinks, `setPackage(selfPackage)`
- impact: security decision inverted via ordered broadcast, protected state reachable, data exfiltration

> **Ordered broadcast mutation** is a distinct primitive from Intent hijack — the attacker writes into the broadcast result rather than the Intent, so the guard test is different. See also: implicit-intent-hijack.

## Reject

Reject when broadcast is internal-only (`setPackage(self)`), extras are harmless, or ordered result manipulation has no security outcome (e.g. result only used for a UI hint).

## Codes

```java
// ordered broadcast mutates result for downstream receivers — security decision is in the result
if (intent.getStringExtra("pin") != null) {
    abortBroadcast();
    setResultData("verdict=allow");
}
```

```java
// global broadcast carrying sensitive value (use setPackage(self) or LocalBroadcastManager)
i.putExtra("account_id", currentAccountId);
sendBroadcast(i);
```

```java
// higher-priority dynamic receiver hijacks an implicit broadcast
filter.setPriority(999);
registerReceiver(attackerReceiver, filter);
```

```java
// safe: internal dynamic receiver rejects external senders on Android 13+
registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED);
```

```java
// boundary mistake: package-restricted send but exported receiver still trusts external extras
intent.setPackage(getPackageName());
sendBroadcast(intent);

// elsewhere
if ("wipe".equals(intent.getStringExtra("cmd"))) wipeLocalState();
```

```java
// extreme edge: dynamic registerReceiver without RECEIVER_NOT_EXPORTED — any sender can reach it
registerReceiver(new BroadcastReceiver() {
    @Override public void onReceive(Context c, Intent intent) { runPrivilegedAction(intent); }
}, filter);
```
