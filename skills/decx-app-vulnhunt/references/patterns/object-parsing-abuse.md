# Pattern: Object Parsing Abuse

## When To Use

Use this reference when `Parcelable`, `Serializable`, `Bundle`, custom class loaders, or validation/execution parser mismatches cross component or IPC boundaries.

## Vulnerability Essence

Untrusted serialized object data is deserialized, interpreted, or validated inconsistently across trust boundaries, enabling type confusion, guard bypass, or dangerous object-driven behavior.

## Sources

- `getParcelableExtra`, `getSerializableExtra`, `Bundle`, `Parcel`, AIDL parcelables
- class loader assignment, custom parcel readers, validation parser and execution parser split
- nested object fields controlling target, URI, path, command, or identity

## Sinks

- deserialization into app classes, reflective loading, parser-dependent authorization, component launch, file/provider access, privileged command dispatch

## Required Trace Evidence

- Reachability: attacker can supply serialized object or bundle data.
- Controllability: attacker controls fields interpreted by the sink or alternate parser.
- Sink: object fields affect protected action/data, class loading, target validation, or parser mismatch.
- Missing or bypassable guard: no class allowlist, type check, parser consistency, or field-level validation protects execution.
- Visible impact: authorization bypass, protected action, data access, or meaningful chain pivot.

## Guard Checklist

Consider safe when class loaders are fixed, allowed classes are explicit, validation and execution consume the same normalized object, and dangerous fields are revalidated before sink use.

## Rejection Rules

Reject when object data is used only as inert display text, class/type is fixed and harmless, parser mismatch does not reach a security decision, or no downstream impact exists.

## Rating Mapping

- HIGH: parser/object abuse reaches protected action or code/class-loading risk.
- MEDIUM: bounded validation bypass or local app chain pivot.
- LOW: weak crash/DoS only if broader security effect exists.
- IGNORED: malformed object crash or no security sink.

## Trace Commands

```bash
decx code method-context "<objectExtractionMethod>" -P <port>
decx code method-source "<validationOrExecutionMethod>" -P <port>
```

## Example Shapes

Suspicious:

```text
external Binder/Intent carries caller-controlled Parcelable -> receiver deserializes without class allowlist -> unexpected class reaches privileged method
```

Safe:

```text
Parcelable crosses trust boundary -> classloader is restricted or Bundle key allowlist is enforced -> only expected types are deserialized
```

## Report Snippet

Use: "Untrusted object data crosses a component boundary and is interpreted inconsistently before a security-relevant sink."

Avoid: "Parcelable is received" without proof that unexpected types reach privileged code paths.
