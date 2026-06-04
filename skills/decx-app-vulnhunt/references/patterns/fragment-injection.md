# Pattern: Fragment Injection

## When To Use

Use this reference when fragment class names, navigation destinations, preference fragments, routes, or arguments can be supplied through external Activity input.

## Core Concept

Untrusted component input selects or configures an internal fragment that exposes privileged UI, data, or actions without caller authorization.

**Sources**
- `Intent` extras, URI parameters, deep-link route, saved state, `Bundle`
- `EXTRA_SHOW_FRAGMENT`, fragment class/name, navigation destination ID, preference screen key
- reflection-based fragment creation or router helpers

**Sinks**
- `Fragment.instantiate`, `FragmentTransaction.replace/add`
- settings/preference fragment dispatch
- navigation component destination resolution
- fragment methods that read private data, issue privileged actions, or bypass expected UI flow

## Guards & Rejection

Safe when: fragment selection is from immutable allowlisted destinations, arguments are sanitized, sensitive fragments recheck authorization, and exported entrypoints cannot reach private admin/debug screens.

Reject when: attacker can only open harmless UI, fragment class is trusted constant, allowlist is exact and enforced, or no sensitive fragment behavior is reachable.

## Rating

- HIGH: privileged admin/security fragment or sensitive account/data access.
- MEDIUM: bounded unauthorized settings/action or protected workflow bypass.
- LOW: UI-only confusion without protected action.
- IGNORED: no sensitive fragment or no attacker selection.

## Trace Commands

```bash
decx code search-class-key "<ActivityClass>" "Fragment" -P <port>
decx code method-context "<fragmentDispatchMethod>" -P <port>
```

## Example Shapes

Suspicious:

```text
deep link param fragment=PrivateSettings -> Fragment.instantiate -> protected settings action
```

Safe:

```text
route ID -> public destination allowlist -> fragment-level permission check
```

Report guidance -- Use: "An exported Activity lets attacker-controlled input select a sensitive internal fragment without authorization." Avoid: "fragment class comes from extras" without proven controlled class reaching a security-relevant sink.
