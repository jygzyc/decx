# Pattern: Intent Redirect

## When To Use

Use this reference when an exported component, WebView `intent://` flow, scan result, or framework/app bridge accepts caller-controlled `Intent`, `Uri`, `ClipData`, selector, component, package, flags, or extras and forwards them to another component or action.

## Core Concept

Untrusted component input crosses a trust boundary and reaches a component launch or grant-bearing dispatch under the victim app identity without a non-bypassable target guard.

**Sources**
- `getIntent().getParcelableExtra(...)` returning `Intent`
- `Intent.parseUri(...)`
- `getData()`, `getExtras()`, `getClipData()`, selector, package, component, flags
- browser, QR, activity-result, notification, or broadcast payloads that construct an `Intent`

**Sinks**
- `startActivity`, `startActivityForResult`, `startService`, `bindService`, `sendBroadcast`
- `setResult` with grant-bearing `Intent`
- `grantUriPermission`
- helper wrappers that eventually launch, return, or grant with the controlled object

## Guards & Rejection

Safe when: validation occurs before forwarding and pins the exact trusted target, strips dangerous flags/grants/selector/ClipData, or verifies caller/package/signature with immutable allowlists. Action-only, scheme-only, package-prefix, or post-launch checks are not enough by themselves.

Reject when: the nested object is overwritten with trusted constants, the target is exact-allowlisted and caller validation is non-bypassable, the sink is not reachable, or the downstream target has no security-relevant behavior beyond UI noise or crash.

## Rating

- HIGH: attacker reaches privileged/private component, obtains sensitive grant/data, or triggers protected action.
- MEDIUM: bounded unauthorized action requiring a local malicious app or user-assisted flow.
- LOW: UI deception only with no protected action.
- IGNORED: forwarding exists but source, sink, guard bypass, or impact is not proven.

## Trace Commands

```bash
decx code method-context "<entryOrHelperSignature>" -P <port>
decx code method-source "<entryOrHelperSignature>" -P <port>
decx code xref-method "<sinkSignature>" -P <port>
```

## Example Shapes

Suspicious:

```text
external Activity -> nested Intent extra -> unchanged object -> startActivity()
```

Safe:

```text
external Activity -> extract action -> map to trusted explicit component -> strip grants -> startActivity()
```

Report guidance -- Use: "An exported Activity forwards attacker-controlled nested Intent data to a privileged component launch without exact target validation." Avoid: "Intent redirect exists" without source, sink, guard, and impact evidence.
