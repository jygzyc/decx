---
name: harness
track: android-poc
---

# harness

## Match
Building or validating a `poc-<target>` Android PoC: environment, fixed harness structure, or proof that the specified path executed.

## Non-obvious
- A usable Android SDK root must be set as `ANDROID_HOME` or `ANDROID_SDK_ROOT` and contain non-empty `build-tools/` and `platforms/`; `adb` is optional unless device-side validation is requested.
- `compileSdk` and `targetSdk` must exist under the selected SDK's `platforms/`. JDK 11 is the minimum; JDK versions above 17 need a compatible Gradle/AGP pair.
- Unless the spec says otherwise, use `minSdk` 26, Java 8 source/target, `minifyEnabled false`, and `google()` plus `mavenCentral()` repositories.
- The harness root contains `app/` and `server/`; `<target>` matches `^[a-z][a-z0-9]*$`, package/applicationId is `com.poc.<target>`, and the app label is `PoC`.
- `PoCActivity` is exported with `singleTask` and has exactly two filters: MAIN/LAUNCHER and VIEW with DEFAULT+BROWSABLE on `poc-<target>://run/trigger`. Handle a repeated trigger in `onNewIntent` after `setIntent(intent)`; otherwise the new deep-link data is dropped.
- Dispatch checks the `exploit` extra before the `exploit` query parameter, so a stale extra wins over a fresh deep link. Register exactly one exploit id from the spec; add helper components only when `supportComponents` requires them.
- The finding spec supplies the trigger fields and `successSignal`. Replace every placeholder with evidence and implement only the specified exploit shape; do not add helper components or alternative paths for convenience.
- Execution evidence is the spec's `successSignal` on the real path, not a log that merely says the exploit was attempted. Log each run with tag `PoC`; delayed background triggers use `AlarmManager.setAndAllowWhileIdle` and a `BroadcastReceiver` via `PendingIntent`, not a `Handler` that may stop when the process is frozen.
- For a background camera-permission PoC, the harness used `android.hardware.Camera` with a `SurfaceTexture` dummy preview and `takePicture` to a file; deprecation warnings are acceptable. For a resource-exhaustion PoC that needs many unique strings, use a fixed-length `char[]` incremented like an odometer rather than random generation or hashing.
- Build with `cd poc-<target>/app && ./gradlew assembleDebug --no-daemon`; on Windows use `gradlew.bat assembleDebug --no-daemon`. Compile or deploy only when requested; otherwise report build-ready status and remaining manual steps.

## Reject
The SDK/JDK prerequisites are missing, the spec omits the target path or success signal, or a required execution result has not been observed — report the blocker instead of guessing a harness or claiming the PoC succeeded.
