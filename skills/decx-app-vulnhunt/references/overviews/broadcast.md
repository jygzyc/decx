# Broadcast - Component Analysis Guide

Use this guide for static manifest receivers, dynamic `registerReceiver` targets, ordered broadcasts, sticky broadcasts, and global broadcast data leaks.

## Analysis Flow

```text
1. decx ard app-receivers -P <port>
   -> list all receivers
2. decx ard exported-components -P <port>
   -> list exported receivers
3. decx code class-context "<ReceiverClass>" -P <port>
   -> overview of onReceive and helpers
4. Check onReceive: action/extras dispatch, ordered broadcast handling, sticky data
5. Check dynamic registration: registerReceiver timing, exported flag, permission guard
6. Confirm sender/receiver permission and whether sensitive values reach external observers
```

## Promotion Signals

- attacker can send or observe the broadcast and reach protected work or sensitive data inside onReceive()
- sender or receiver permission is missing, weak (dangerous/normal), or not enforced at the relevant hop
- ordered broadcast manipulation can change an authorization decision or security outcome
- sticky broadcast persists sensitive values readable by any future caller
- dynamic receiver is exported without permission guard and accepts external actions/extras
- extras flow unvalidated into startActivity, startService, or another component dispatch

## False Positive Guide

- **Signature-level permission on both sides**: verify both sender and receiver permission declarations are actually signature-level; a dangerous/normal permission with a signature-sounding name is not equivalent
- **LocalBroadcastManager confinement**: confirm the registration uses LocalBroadcastManager.registerReceiver and not Context.registerReceiver
- **Harmless extras only**: trace the full dispatch chain -- a seemingly harmless string may reach a startActivity call in a helper method
- **Ordered broadcast modification with no security outcome**: verify what the final receiver does with the result before closing
