# Pattern: UI Trust Abuse

## When To Use

Use this reference when task hijack, clickjacking, overlay, task-affinity, launch-mode, or spoofed trusted UI can cause credential entry or protected in-app approval.

## Core Concept

The app lets attacker-controlled UI context influence a user trust decision, causing unintended credential disclosure or protected action approval.

**Sources**
- task affinity, launch mode, exported Activity, overlay/obscured touch, spoofed WebView or internal fragment UI
- user-driven approval, login, payment, permission, admin, or security-setting flows

**Sinks**
- credential entry, payment/security approval, permission/admin activation, protected settings change, sensitive native action

## Guards & Rejection

Safe when: sensitive controls reject obscured touches, task/launch settings prevent hijack, UI clearly verifies trusted origin, and protected actions require independent non-bypassable confirmation.

Reject when: pure UI confusion, public-screen opening, or multi-step social engineering with no protected action or data exposure.

## Rating

- MEDIUM: real credential theft or protected action with plausible local attacker/user interaction.
- LOW: limited UI deception with weak but real security value.
- IGNORED: visual spoofing only.

## Trace Commands

```bash
decx ard exported-components -P <port>
decx code class-source "<ActivityOrUiClass>" -P <port>
```

## Example Shapes

Suspicious:

```text
attacker controls task affinity -> overlays or hijacks login Activity -> user enters credentials into attacker-controlled UI
```

Safe:

```text
login Activity uses singleTask launch mode, rejects obscured touches, and verifies trusted origin
```

Report guidance -- Use: "The app permits attacker-controlled UI context to influence a protected user approval or credential-entry flow." Avoid: "task affinity can be manipulated" without proving the manipulation causes credential entry or protected action approval.
