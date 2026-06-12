# Pattern: Object Parsing Abuse

## Match

Parser split: one process validates serialized data, but a later process reserializes/deserializes into different keys or object types across a component, service, provider, WebView bridge, AIDL, or IPC boundary. High-priority.

High-signal variant taxonomy:
- **Read/write length or type mismatch** — read uses `int` (4 bytes) but write uses `long` (8 bytes) / `byte` (4 bytes when using `writeByte`) / `writeString` (length-prefixed) / `writeParcelableList` vs `writeTypedArrayList` (different header semantics).
- **Exception swallowed during read** — read wraps `createFromParcel` in try/catch returning null or default, so a second read sees different content than the first validation.
- **Deferred parcel value reuse** — a parcel-backed object keeps a reference to data that is later recycled, pooled, or re-read in another IPC context.
- **AIDL creator mismatch** — AIDL generated `Stub.onTransact` calls `_Parcel.readTypedObject(data, Intent.CREATOR)` (parent class reader), but a subclass (e.g. `LabeledIntent`, `ReferrerIntent`) is written via its own `writeToParcel` (extra fields). On second deserialization the extra fields are read as the method's next argument.
- **Untyped `getParcelable` reflection** — `getParcelable("key")` (no class param) still calls the target's `CREATOR.createFromParcel`; constructors that read from the same `Parcel` can chain into another parse cycle.
- **Creator Mismatch** — read uses class A's `CREATOR` to parse an object written by class B that inherits A; B's extra fields are then consumed as the next Parcel fields.

## Analyze

- entry: `getParcelableExtra`, `getBundleExtra`, `Bundle.readFromParcel`, `Parcel.readValue`, `Parcel.readTypedObject`, `Parcelable.Creator.createFromParcel`, `readObject`, AIDL parcelable, JSON parser, bridge method, remote-view factory, queued callback item, `setExtrasClassLoader` / custom class loader
- control: key mismatch, key-size/type mismatch, `mParcelledData`, subclass/type confusion, role/account/package/user, command, path, URI, component, request code, policy flag, first-read vs second-read position offset, deferred parcel pointer
- sink: authorization decision (`if (intent.getXxxExtra("role") == "admin")`), component launch/result, provider/file access (`openFile`), service command, native bridge action, reflective/class loading, `Activity` start with `launchTaskId` from a malformed `Bundle` (task hijack)
- guard: same normalized object for validation AND consumption (not a re-read); class allowlist with fixed class loader; type-specific reader `getParcelable(key, Intent.class)`; avoid callback/remote-view gadgets surviving parcel round-trips; check `mParcelledData` not modified between validation and consumption
- impact: auth bypass, private component reachability, file/provider access, code/class-loading risk, or privileged launch when parser split crosses an IPC boundary

## Reject

Reject when parsed data is display-only, type/class is fixed and harmless, same normalized object used for validation and consumption (same reference, not a re-read), dangerous fields revalidated before use, typed readers (`getParcelable(key, Type.class)`) with an allowlist, or no security sink consumes the object.

## Codes

```java
// write used long (8B), read used int (4B) — subsequent fields shift on the same Parcel
out.writeLong(a); out.writeInt(b);
a = in.readInt();  // reads lower 4 bytes of a
b = in.readInt();
```

```java
// AIDL reads with parent Creator, but attacker wrote a subclass with extra fields
Intent _arg2 = _Parcel.readTypedObject(data, Intent.CREATOR);
```

```java
// gadget: constructor reads from Parcel, called by getParcelable reflection
public Activity(Parcel source) { source.readInt(); }
```

```java
// gadget: constructor writes into Parcel and shifts the later deferred read
public PooledStringWriter(Parcel dest) { dest.writeInt(0); }
```

```java
// untyped getParcelable still constructs the typed object
Intent inner = intent.getParcelableExtra("target");
```
