# Base PoC Contract

Single source of truth for building a PoC project from scratch. Load after `poc-spec.md` is complete. Do not copy any template; generate the project directly per this contract.

## Directory Structure

- project root: `poc-<target>/`
- Android app: `poc-<target>/app/`
- HTML server: `poc-<target>/server/`
- `<target>` must match `^[a-z][a-z0-9]*$` (lowercase, starts with a letter).

## Naming Contract

- package / applicationId: `com.poc.<target>`
- project name, helper deep-link scheme: `poc-<target>`
- app label: `PoC`

## Android App Contract (`poc-<target>/app/`)

Plain single-module Android project (`settings.gradle` + `app/` module), `google()` and `mavenCentral()` repositories.

- Version selection: no locked toolchain. `compileSdk`/`targetSdk` must be an API level present in the local Android SDK (`$ANDROID_HOME/platforms`); `minSdk` per PoC Spec requirement (26 if unspecified). AGP and Gradle must be compatible with the local JDK (use `scripts/check-env.mjs` to verify).
- `app/build.gradle`: `namespace`/`applicationId` = `com.poc.<target>`, Java 8 source/target compatibility, `minifyEnabled false`.

### Manifest

`.PoCActivity` declared `android:exported="true"`, `android:launchMode="singleTask"`, with two intent-filters:

1. Launcher: action `MAIN`, category `LAUNCHER`.
2. Deep link: action `VIEW`, categories `DEFAULT` + `BROWSABLE`, data `android:scheme="poc-<target>" android:host="run" android:pathPrefix="/trigger"`.

Add helper Manifest components only if `supportComponents` requires them.

### Exploit Registration Shape

```java
public final class ExploitEntry {
    public final String id;
    public final String title;
    public final Runnable action;
    // constructor assigns all three
}

public final class ExploitRegistry {
    public static final List<ExploitEntry> EXPLOITS = new ArrayList<>();

    static {
        // register exactly one exploit id from the PoC Spec:
        // register("<exploit-id>", "<title>", () -> { ... });
    }

    public static void register(String id, String title, Runnable action) {
        EXPLOITS.add(new ExploitEntry(id, title, action));
    }

    public static ExploitEntry findById(String id) { /* first match by id, else null */ }
}
```

Register exactly one `exploitId` from the PoC Spec.

### PoCActivity Trigger Dispatch

- onCreate: inflate a container layout, add one header `TextView` (package name + trigger URI), then one `Button` per `ExploitRegistry.EXPLOITS` entry whose click runs `entry.action.run()`; then dispatch `getIntent()`.
- `onNewIntent`: `setIntent(intent)` and dispatch again.
- Dispatch contract (`runRequestedExploit`): resolve exploit id first from `intent.getStringExtra("exploit")`, else from `intent.getData().getQueryParameter("exploit")`; empty/unknown id → warn and return; known id → log and run `entry.action.run()`.
- Trigger URI: `poc-<target>://run/trigger?exploit=<id>`; browser variant: `intent://run/trigger?exploit=<id>#Intent;scheme=poc-<target>;package=com.poc.<target>;end`.

### successSignal Log Contract

All app-side logging uses tag `PoC`:

- `Log.i("PoC", "Executing: " + entry.id)` before each run (route variant: `"Executing from route: " + entry.id`);
- `Log.e("PoC", "Failed: " + entry.id, e)` on exception (route variant: `"Failed from route: " + entry.id`);
- the exploit body must log the spec success signal as a real proof, not a theory statement.

## Framework Binder PoC Add-On

Only for framework Binder findings (see the `Boundary` section in `poc-framework-service.md`; do not repeat its rules here):

- prefer a pure-Java, zero-dependency hidden-API exemption: reflectively get `dalvik.system.VMRuntime.getRuntime()` and invoke `setHiddenApiExemptions(String...)` with `"L"` (prefix wildcard) before the first Binder call.
- the maven dependency `org.lsposed.hiddenapibypass:hiddenapibypass:4.0` is only a convenience fallback when external libraries are acceptable.

## Server Contract (`poc-<target>/server/`)

Zero-dependency Node static server plus attacker-controlled pages. Run: `node server.mjs`.

- `server.mjs`: serves files under `public/` on `HOST` (default `0.0.0.0`) / `PORT` (default `8000`); permissive CORS (`Access-Control-Allow-Origin: *`, GET/POST/OPTIONS); path traversal guarded to `public/`; `/` maps to `index.html`.
- `public/index.html`: PoC link builder page. Sections: helper-app trigger links, deep-link-to-WebView-sink variants, ready-to-run adb commands, hosted payload pointer.
- `public/scenario.js`: generates trigger variants from the current inputs:
  - helper custom-scheme link `poc-<target>://run/trigger?exploit=<id>[&extra]`;
  - helper `intent://` URL with `scheme=poc-<target>;package=com.poc.<target>`;
  - deep link `<prefix><encodeURIComponent(attackerUrl)>` where attacker URL defaults to `<serverOrigin>/payload.html`;
  - browser `intent://` URL embedding `package`/`component` for the victim app;
  - equivalent `adb shell am start` commands (implicit VIEW and explicit `-n <activity>`).
  Add one link variant per PoC.
- `public/payload.html`: attacker-controlled HTML loaded by the victim WebView; renders origin/href/UA context plus a payload log; one script block per active PoC (bridge call, cookie probe, `intent://` redirect, fetch exfiltration, ...).

## Proof Signal Helpers

Minimal techniques for logging a real proof signal (per the SKILL.md rule) instead of a theory statement:

- Delayed trigger after backgrounding (e.g. popping an activity, using a while-in-use permission later): schedule with `AlarmManager.setAndAllowWhileIdle` + `BroadcastReceiver` via `PendingIntent.getBroadcast(..., FLAG_IMMUTABLE or FLAG_ONE_SHOT)`, never a `Handler` — on Android 14+ a backgrounded app process is frozen and pending Handler tasks do not run; request the exact-alarm permission if precise timing matters.
- Background use of a while-in-use permission such as the camera: use the deprecated camera1 API — `android.hardware.Camera` + `SurfaceTexture` dummy preview + `takePicture` writing to a file; deprecation warnings can be ignored.
- Unique strings at volume (resource-exhaustion PoCs): fill a fixed-length `char[]` and increment it position by position like an odometer — cheap, unique, no randomness or hashing.

## Required Edits

- replace package/action/URI/extra/Binder placeholders from PoC Spec;
- register exactly one exploit id for one finding;
- log the spec success signal;
- add helper Manifest components only if `supportComponents` requires them.
