---
name: environment
track: android-poc
---

# environment

## Match
Selecting or diagnosing the `poc-<target>` build environment. The local Android SDK and JDK decide which API levels and tool versions are legal.

## Non-obvious
- `scripts/check-env.mjs` must run with the decx-poc skill directory as cwd; it exits 1 on missing SDK home, empty `build-tools`/`platforms`, or JDK < 11, while `adb` is optional (WARN only).
- The SDK home is `ANDROID_HOME` or `ANDROID_SDK_ROOT`; if neither is set the check fails even when `sdkmanager` is on PATH — it only points out that the SDK root must be set.
- `compileSdk`/`targetSdk` must be an API level present in `$ANDROID_HOME/platforms`; there is no locked toolchain, and AGP plus Gradle must match the local JDK.
- JDK > 17 emits a WARN: pick a Gradle/AGP pair that supports that JDK instead of silently changing the version selection.
- `minSdk` is 26 only when the spec is silent; Java 8 source/target and `minifyEnabled false` are part of the base contract, and repositories must include `google()` and `mavenCentral()`.

## Reject
No usable SDK platform or JDK >= 11 is present and check-env reports FAIL — fix the environment first instead of blind version juggling in Gradle files.
