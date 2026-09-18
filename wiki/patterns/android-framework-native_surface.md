---
name: native_surface
track: android-framework
---

# native_surface

## Match
Android device runs native services (C/C++) accessible via Unix domain socket, HIDL, or vendor AIDL — outside the Java framework layer. These services run with elevated privileges and may have weaker input validation than Java services.

## Non-obvious
- **Vendor variance**: Qualcomm and MTK devices have MANY native services; Google Pixel devices have very few — the attack surface is OEM-dependent
- **SELinux gate**: most native socket services are HAL-layer with strict SELinux — `adb shell` or unprivileged app often cannot reach them; check if SELinux rules are permissive or bypassable
- **`android_get_control_socket()` / `socket_local_server()`** in `libcutils` are the entry points to trace in native code
- **HIDL services**: `android.hardware.*` — vendor HAL services accessible via `hidl_gen` interfaces; input validation often weaker than Java Binder

## Reject
Service unreachable due to non-bypassable SELinux, service only processes trusted constant input, or no privileged operations downstream.
