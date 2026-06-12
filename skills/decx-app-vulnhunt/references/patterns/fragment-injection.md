# Pattern: Fragment Injection

## Match

Caller-controlled class name selects Fragment from exported Activity, deep link, saved state, or Bundle. The classic primitive: `PreferenceActivity.EXTRA_SHOW_FRAGMENT` → `Fragment.instantiate(fragmentName, args)` — typed reflection. Even with `isValidFragment`, subclasses returning `true` for everything reintroduce the primitive.

## Analyze

- entry: exported Activity (especially subclassing `PreferenceActivity`), deep link handler, `Fragment.instantiate` from `EXTRA_SHOW_FRAGMENT`
- control: fragment class name, arguments Bundle, route
- sink: privileged fragment (PIN/credential reset, account/settings/payment/admin), WebView/provider/service bridge reached from injected fragment
- guard: destination allowlist, `isValidFragment` returning `false` for caller-controlled names
- impact: protected UI/action, credential/approval flow, or chain into WebView/service/provider

## Reject

Reject when only public fragments are reachable, the class is mapped from trusted constants, privileged actions re-authenticate inside the fragment, or caller-controlled args cannot affect protected behavior.

## Codes

```java
// PreferenceActivity reads caller-controlled fragment name and reflects it
String initialFragment = getIntent().getStringExtra(PreferenceActivity.EXTRA_SHOW_FRAGMENT);
if (initialFragment != null) switchToHeader(initialFragment, getIntent().getBundleExtra(PreferenceActivity.EXTRA_SHOW_FRAGMENT_ARGUMENTS));
```

```java
// Fragment.instantiate reflects the caller-controlled string
Class<?> clazz = context.getClassLoader().loadClass(fname);
Fragment f = (Fragment) clazz.newInstance();
```

```java
// subclass that re-introduces the bug — always allow (the only edge case is the override pattern)
@Override protected boolean isValidFragment(String fragmentName) { return true; }
```
