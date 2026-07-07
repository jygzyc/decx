# App Cloud Control Analysis

## Core model

Cloud control is security-relevant when backend-controlled or remotely delivered data changes local trust decisions, code/data loading, component routing, WebView behavior, IPC targets, credentials, policy enforcement, or update/plugin behavior.

## High-signal chains

| Chain | Signal | Evidence target |
|---|---|---|
| Remote config -> feature gate -> protected local action | JSON/protobuf/config value enables hidden or privileged path | config source, parser, cached key, guard, sink |
| Remote command -> Intent/WebView/provider sink | task/action field selects URL, Intent, component, provider URI, file path, or JS bridge action | command schema, controlled field, validation, sink argument |
| Cloud policy -> local auth bypass | server flag relaxes lock, risk, device, account, or permission check | policy fetch, trust boundary, local fallback, final decision |
| Update/plugin control -> dynamic loading | remote package, dex, zip, JS, rule, or plugin URL is loaded without integrity binding | transport, signature/hash, storage path, load call |
| Backend URL -> WebView trusted origin confusion | remote URL or redirect controls trusted WebView origin, cookies, bridge, or file access | URL source, allowlist logic, redirect handling, bridge impact |
| Push/message channel -> privileged local workflow | FCM/vendor push payload drives local action without user confirmation | payload fields, receiver/service path, guard, visible effect |
| Risk signal -> backend decision -> local privilege change | device fingerprint, hook/root/cloud-phone/proxy/replay signal changes account, feature, payout, or rate limit state | signal collector, request field, backend response, local enforcement |
| Capture/replay/mock -> policy bypass | traffic rewrite, mock response, or replay changes remotely controlled security state | signing, nonce, timestamp, pinning, cache trust |

## IMA-derived leads to prioritize

- Device fingerprinting is a control plane, not only telemetry. Route fields such as build properties, kernel identifiers, emulator/cloud-phone traits, hook/root indicators, proxy state, install provenance, and sensor/network entropy to the backend decision they influence.
- Cloud-phone and batch-abuse defenses often combine local environment checks with server-side risk scoring. A useful finding must show the signal, the transport field, the backend policy effect, and the final user-visible action.
- Treat packet capture, breakpoint rewrite, mock, and replay tooling as analysis leads. The security question is whether the protocol binds policy responses to session, account, device, nonce, timestamp, and app integrity.
- Anti-hook and anti-tamper checks are relevant only when they gate a security decision. Keep them as evidence for a bypass chain, not standalone findings.

## Rejection rules

Reject when remote data only changes harmless UI copy, every security-relevant field is pinned to trusted constants, integrity verification binds payload to expected signer/hash, local authorization rechecks after config, or impact is only debug/telemetry.
