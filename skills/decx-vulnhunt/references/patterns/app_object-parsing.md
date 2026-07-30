---
name: object-parsing
track: app
---

# object-parsing

## Match
One process validates serialized data but a later process deserializes into different keys/types — across component, service, provider, WebView bridge, AIDL, or IPC.

## Non-obvious
- Untyped `getParcelable("key")` still calls target's `CREATOR.createFromParcel` — typed constructor runs
- AIDL `Stub.onTransact` reads parent class via `readTypedObject`; subclass extra fields become the method's next argument (read position shift)
- Read/write type mismatch shifts position: `int`(4B) vs `long`(8B) vs `writeByte`(4B) vs `writeString`(length-prefixed) vs `writeParcelableList` vs `writeTypedArrayList`
- Exception swallowed during read returns null; second read sees different content than first validation
- Deferred parcel value reuse — parcel-backed object keeps reference to recycled data
- **LazyValue/Bundle deferred deserialization**: `Bundle` stores values lazily in `mMap`; `getValue()` deserializes on first access. If two readers interpret the same lazy entry as different types, the second reader sees shifted data. This is the Bundle mismatch primitive — one process writes a Bundle, another reads it with different type assumptions, and the Parcel read position diverges.
- **Self-changing Bundle**: same Bundle read twice by different code paths yields different values because the underlying Parcel data is consumed on first read (lazy deserialization is one-shot)

## Reject
Same normalized object used for validation AND consumption, typed reader with class allowlist, or no security sink consumes the object.
