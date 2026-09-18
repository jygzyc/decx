---
name: evidence
track: android-poc
---

# evidence

## Match
A built PoC must produce device execution evidence: the spec `successSignal` has to fire through the real path, not as a theory statement.

## Non-obvious
- All app-side logging uses tag `PoC`: `Log.i("PoC", "Executing: " + entry.id)` before each run (route variant `"Executing from route: " + entry.id`) and `Log.e("PoC", "Failed: " + entry.id, e)` on exception; the exploit body logs the spec success signal as real proof.
- A delayed trigger after backgrounding must use `AlarmManager.setAndAllowWhileIdle` plus a `BroadcastReceiver` via `PendingIntent.getBroadcast(..., FLAG_IMMUTABLE or FLAG_ONE_SHOT)`, never a `Handler` — on Android 14+ a backgrounded app process is frozen and pending Handler tasks do not run; request the exact-alarm permission when precise timing matters.
- Background use of a while-in-use permission such as the camera uses the deprecated camera1 API — `android.hardware.Camera` + `SurfaceTexture` dummy preview + `takePicture` writing to a file; deprecation warnings are acceptable.
- Unique strings at volume for resource-exhaustion PoCs: fill a fixed-length `char[]` and increment it position by position like an odometer — no randomness or hashing.
- Build with `cd poc-<target>/app && timeout 300 ./gradlew assembleDebug --no-daemon`; on Windows use `gradlew.bat assembleDebug --no-daemon` without `timeout`.
- Compile or deploy only on an explicit request; otherwise stop at build-ready and report `buildStatus`/`runtimeStatus` with `remainingManualSteps`.

## Reject
The only available signal is a theory statement or a log of intent, or execution was not requested beyond build-ready — stop at build-ready and say so.
