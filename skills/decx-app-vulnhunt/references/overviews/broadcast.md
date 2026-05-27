# Broadcast - Overview - Security Review

Use this overview for static receivers, dynamic receivers, ordered broadcasts, and global broadcast leaks. For signal-to-pattern routing, start with `vulnerability-router.md`.

## Analysis Flow

```text
1. decx ard app-receivers --exclude-package "androidx\\..*" --exclude-package "android\\.support\\..*" -P <port>
2. decx code search-method "registerReceiver" -P <port>
3. decx code class-source "<ReceiverClass>" -P <port>
4. Inspect:
   -> onReceive() inputs
   -> permission arguments on sendBroadcast / sendOrderedBroadcast / registerReceiver
   -> exported behavior for runtime-registered receivers
5. Check whether the receiver triggers:
   -> startActivity / startService / sendBroadcast
   -> file or database actions
   -> credential or token handling
```

## Promotion Signals

- attacker can send or receive the broadcast path
- action/extras/URI/grant fields influence security-relevant work or data exposure
- receiver/sender permission is missing, weak, or not enforced at the relevant hop
- impact is a concrete action, data leak, or grant reuse
- broad registration, ordered delivery, or weak permission is usually a route into the real broadcast sink, not a standalone finding

## Common False Positives

- Receiver uses a signature-level sender and receiver permission
- Broadcast is LocalBroadcastManager only
- Extras are consumed but only drive public or harmless behavior
- Ordered broadcast modification has no security outcome
