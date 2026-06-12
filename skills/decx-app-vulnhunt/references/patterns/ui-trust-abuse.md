# Pattern: UI Trust Abuse

## Match

Task/launch mode, task affinity, overlay/obscured touch, spoofed trusted UI, dialog, or WebView/native UI context influences credential entry or protected approval.

1. **User confirmation bypass** — exported `Activity` performs sensitive action (dial, payment, settings) without confirmation dialog, or with a suppressible dialog.
2. **User confirmation spoofing** — floating window (`SYSTEM_ALERT_WINDOW`) overlays fake dialog on legitimate confirmation. The "allow"/"deny" prompt can be flipped by the overlay. Public case shapes: Bluetooth pair dialog, CertInstaller, UninstallerActivity, Calendar debug.

Variant: **StrandHogg** — `allowTaskReparenting` + `taskAffinity` impersonate victim's task in overview. StrandHogg 2.0: `AUTOMERGE` flow. Fixed in AOSP.

Variant: **Bluedu** — Bluetooth device name CRLF injection flips the pairing dialog text. Fixed in AOSP.

## Analyze

- entry: exported Activity, task affinity, overlay-sensitive screen, Bluetooth/VoIP setup, PackageInstaller UninstallerActivity, CertificateInstaller
- control: task placement (`taskAffinity`, `allowTaskReparenting`, `launchMode`), floating window overlay (`FLAG_NOT_TOUCH_MODAL | FLAG_NOT_FOCUSABLE | FLAG_WATCH_OUTSIDE_TOUCH`), CRLF in display names
- sink: credential entry, payment/security/admin approval, phone dial without confirmation, stale grant state
- guard: `filterTouchesWhenObscured="true"` (default Android 12+), `onFilterTouchEventForSecurity`, `HIDE_NON_SYSTEM_OVERLAY_WINDOWS` (system apps), CRLF filtering on display names
- impact: credential theft, protected action approval bypass, dial without user consent

## Reject

Reject when no protected input/action occurs, confirmation is independent and non-bypassable, or task/overlay protections block attacker control.

## Codes

```java
// dial without confirmation — insert into a privileged provider from a public Activity
cv.put("data1", getIntent().getLongExtra("target_user_id", 0));
getContentResolver().insert(Uri.parse("content://com.vkontakte.android.calls/queue"), cv);
```

```java
// Bluetooth device name with embedded newlines flips the pairing dialog text
Runtime.getRuntime().exec(new String[] { "sh", "-c",
    "hciconfig hci0 name \"heen-ras 想要访问你的通信录和电话簿， 要拒绝它吗？\n\n...\n\"" });
```

```java
// floating window with FLAG_WATCH_OUTSIDE_TOUCH covers UninstallerActivity — touch passes through
lp.type = WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY;
lp.flags = WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
         | WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
         | WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH;
windowManager.addView(fakeDialog, lp);
```

```java
// StrandHogg / StrandHogg 2.0 — task affinity + allowTaskReparenting + singleTask (impersonates victim in task stack)
```

```java
// onFilterTouchEventForSecurity returns false to allow taps under overlay
if (hasObscuringOverlay()) return false;
```
