# Casebook: Object Parsing Abuse

Use this casebook after [[patterns/object-parsing-abuse]], [[patterns/exported-access]]. These cases are abstract exploit shapes, not reproduction instructions.

## Case: Parsed Object Controls Authorization Target

### Abstract Shape

```text
external Bundle/Parcelable/JSON -> parser/model object -> role/target/command field -> protected sink
```

### Key Mistake

The app validates that an object exists or has the expected type, but trusts security-relevant fields inside the parsed object.

### Why It Was Exploitable

- external entrypoint accepts structured data from another app, URI, WebView bridge, or service call
- attacker controls fields such as package, role, user ID, file path, command, or component target
- parsed values drive authorization or sink selection
- no server/session/caller-backed mapping replaces the attacker-provided fields

### Generalized Detection Rule

After parsing a caller-controlled object, trace each field that affects identity, authorization, target, command, file/provider access, or component launch.

### Related

[[patterns/object-parsing-abuse]], [[patterns/exported-access]], [[patterns/service-command-injection]]

## Case: Parcelable Type Confusion Bypasses Class Check

### Abstract Shape

```text
external app -> exported Activity -> getParcelableExtra() -> instanceof check passes -> attacker subclass method called -> unexpected behavior in privileged context
```

### Key Mistake

The exported component receives a Parcelable extra and validates it with `instanceof`, but an attacker supplies a subclass that satisfies the check while overriding critical methods with malicious behavior.

### Why It Was Exploitable

- exported component reads a Parcelable from Intent extras without restricting the concrete class
- `instanceof` check accepts any subclass of the expected type
- attacker implements a subclass whose overridden method executes privileged or unexpected logic
- the Android framework deserializes the attacker's concrete class inside the victim process
- no `enforceInterface` validation or class allowlist restricts the deserialized type

### Generalized Detection Rule

When an exported component deserializes a Parcelable from caller input and validates it only with `instanceof`, trace whether an attacker subclass can pass the check and reach a sensitive method dispatch.

Related: [[patterns/object-parsing-abuse]], [[patterns/exported-access]]

## Case: Bundle Key Mismatch Between Validation And Execution

### Abstract Shape

```text
external app -> exported component -> Bundle with key "action_safe" (validated) and key "action_real" (not validated) -> sensitive operation uses "action_real"
```

### Key Mistake

The exported component validates one Bundle key but uses a different key for the actual sensitive operation, leaving the unvalidated key as an open path to the sink.

### Why It Was Exploitable

- developer validates the value under one key but reads the operation from another
- the validated key is a decoy that satisfies the security check
- the unvalidated key reaches the sensitive operation without any guard
- key names are similar enough that the mismatch is not caught in code review
- the Bundle is caller-controlled and both keys are present in the same extras

### Generalized Detection Rule

When an exported component reads from a caller-controlled Bundle, verify that the validated key is the same key used at every downstream consumption point, not a separate parallel key.

Related: [[patterns/object-parsing-abuse]], [[patterns/exported-access]]

## Case: Bundle Mismatch Drives Intent Redirect

### Abstract Shape

```text
external app -> exported component -> validated Bundle key -> unvalidated nested Intent/key -> startActivity/setResult -> private component or grant
```

### Key Mistake

The component validates one Bundle field or nested object but launches, returns, or grants using a different caller-controlled field.

### Why It Was Exploitable

- exported component receives the Bundle from another app, deep link, service call, or broadcast
- attacker controls both the validated decoy field and the execution field
- execution field reaches `startActivity`, `startService`, `sendBroadcast`, `setResult`, or URI grant sink
- target, flags, selector, `ClipData`, or grant data is not normalized after validation
- downstream component/action is private, privileged, or data-bearing

### Generalized Detection Rule

When Bundle validation and execution use different keys or nested objects, trace the execution key to any component launch, result, grant, or protected command sink.

Related: [[patterns/object-parsing-abuse]], [[patterns/intent-redirect]], [[patterns/uri-grant-leak]]

## Case: Custom ClassLoader Loads Attacker Class Into Privileged Context

### Abstract Shape

```text
external data -> ObjectInputStream with custom ClassLoader -> attacker class resolved -> class static initializer runs -> code execution in victim process
```

### Key Mistake

The app deserializes objects using a custom ClassLoader that resolves class definitions from attacker-controlled data, allowing arbitrary code to execute in the victim process.

### Why It Was Exploitable

- deserialization accepts external input without restricting the serialized class
- custom ClassLoader resolves classes from attacker-supplied sources such as DEX files or remote URLs
- the loaded class's static initializer runs automatically during deserialization
- the attacker code executes with the victim app's full process permissions
- no class allowlist or `resolveClass` restriction limits which classes can be materialized

### Generalized Detection Rule

When an app uses `ObjectInputStream` with a custom ClassLoader on caller-controlled data, the deserialization path is a direct code execution vector unless `resolveClass` enforces a strict allowlist.

Related: [[patterns/object-parsing-abuse]], [[patterns/exported-access]]

## Case: Serializable Direct Field Access Bypasses Constructor Validation

### Abstract Shape

```text
external app -> exported component -> ObjectInputStream.readObject() -> attacker-crafted Serializable with bypassed constructor -> sensitive field set directly
```

### Key Mistake

The exported component receives a Serializable object and trusts that its fields were set through the constructor, but Java deserialization sets fields directly from the byte stream without invoking constructor logic.

### Why It Was Exploitable

- Java deserialization allocates the object and populates fields from the stream, bypassing constructors
- the class enforces invariants only in its constructor, not in `readObject` or field accessors
- attacker crafts raw serialized bytes that set internal fields to invalid or privileged values
- the deserialized object passes type checks because its class is legitimate
- downstream code trusts the object's state because the constructor was assumed to have validated it

### Generalized Detection Rule

When an exported component deserializes a Serializable from caller input, check whether the class relies on constructor validation without overriding `readObject` to re-enforce invariants.

Related: [[patterns/object-parsing-abuse]], [[patterns/exported-access]]
