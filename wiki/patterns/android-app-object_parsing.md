---
name: object_parsing
track: android-app
---

# object_parsing

## Match
One process validates serialized data but a later process deserializes it into different keys/types. The boundary can be a component, service, provider, WebView bridge, AIDL, or IPC.

## Non-obvious
- Untyped `getParcelable("key")` still calls target's `CREATOR.createFromParcel` — typed constructor runs
- AIDL `Stub.onTransact` reads parent class via `readTypedObject`; subclass extra fields become the method's next argument (read position shift)
- Read/write type mismatch shifts position: `int`(4B) vs `long`(8B) vs `writeByte`(4B) vs `writeString`(length-prefixed) vs `writeParcelableList` vs `writeTypedArrayList`
- Exception swallowed during read returns null; second read sees different content than first validation
- Deferred parcel value reuse — parcel-backed object keeps reference to recycled data
- **LazyValue/Bundle deferred deserialization**: an input `Bundle` can retain parcelled values until first access. A Parcelable read/write mismatch or inconsistent type assumptions can make validation and a later consumer observe different content after the Bundle crosses a process boundary or is re-parcelled; ordinary repeated reads do not by themselves imply changing values.

## Reject
Same normalized object used for validation AND consumption, typed reader with class allowlist, or no security sink consumes the object.
