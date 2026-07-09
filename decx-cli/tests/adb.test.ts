import {
  buildAmStartCommand,
  buildPermissionInfoCommand,
  detectFrameworkOemFromBrand,
  filterSystemServices,
  parseAdbDevicesOutput,
  parseAmStartOutput,
  parseForegroundAppOutput,
  parsePermissionInfoOutput,
  parseSystemServicesOutput,
  resolvePreferredSerial,
} from "../src/android/adb.js";

describe("adb device selection", () => {
  it("parses connected devices from adb devices output", () => {
    const output = [
      "List of devices attached",
      "emulator-5554\tdevice",
      "ABC123\tdevice",
      "",
    ].join("\n");

    expect(parseAdbDevicesOutput(output)).toEqual(["emulator-5554", "ABC123"]);
  });

  it("defaults to the only connected device when serial is not provided", () => {
    const output = [
      "List of devices attached",
      "emulator-5554\tdevice",
      "",
    ].join("\n");

    expect(resolvePreferredSerial(output)).toBe("emulator-5554");
  });

  it("requires --serial when multiple devices are connected", () => {
    const output = [
      "List of devices attached",
      "emulator-5554\tdevice",
      "ABC123\tdevice",
      "",
    ].join("\n");

    expect(() => resolvePreferredSerial(output)).toThrow("Multiple adb devices detected");
  });

  it("uses the requested serial when provided", () => {
    const output = [
      "List of devices attached",
      "emulator-5554\tdevice",
      "ABC123\tdevice",
      "",
    ].join("\n");

    expect(resolvePreferredSerial(output, "ABC123")).toBe("ABC123");
  });

  it("falls back to env serial when multiple devices are connected", () => {
    const output = [
      "List of devices attached",
      "emulator-5554\tdevice",
      "ABC123\tdevice",
      "",
    ].join("\n");

    expect(resolvePreferredSerial(output, undefined, "ABC123")).toBe("ABC123");
  });

  it("prefers an explicit serial over env serial", () => {
    const output = [
      "List of devices attached",
      "emulator-5554\tdevice",
      "ABC123\tdevice",
      "",
    ].join("\n");

    expect(resolvePreferredSerial(output, "emulator-5554", "ABC123")).toBe("emulator-5554");
  });

  it("still throws ambiguous when multiple devices and no env serial", () => {
    const output = [
      "List of devices attached",
      "emulator-5554\tdevice",
      "ABC123\tdevice",
      "",
    ].join("\n");

    expect(() => resolvePreferredSerial(output)).toThrow("Multiple adb devices detected");
  });

  it("detects a supported framework OEM directly from brand", () => {
    expect(detectFrameworkOemFromBrand("Xiaomi")).toBe("xiaomi");
    expect(detectFrameworkOemFromBrand("GOOGLE")).toBe("google");
    expect(detectFrameworkOemFromBrand("Samsung")).toBe("samsung");
  });

  it("parses system service list output into non-empty lines", () => {
    const output = [
      "Found 3 services:",
      "0\tfoo: [com.android.IFoo]",
      "",
      "1\tbar: [com.android.IBar]",
      "2\tbaz: [com.android.IBaz]",
      "",
    ].join("\n");

    expect(parseSystemServicesOutput(output)).toEqual({
      total: 3,
      services: [
        { index: 0, name: "foo", interfaces: ["com.android.IFoo"] },
        { index: 1, name: "bar", interfaces: ["com.android.IBar"] },
        { index: 2, name: "baz", interfaces: ["com.android.IBaz"] },
      ],
    });
  });

  it("filters system services by keyword across name and interface", () => {
    const services = {
      total: 3,
      services: [
        { index: 0, name: "foo", interfaces: ["com.android.IFoo"] },
        { index: 1, name: "activity", interfaces: ["android.app.IActivityManager"] },
        { index: 2, name: "window", interfaces: ["android.view.IWindowManager"] },
      ],
    };

    expect(filterSystemServices(services, "activity")).toEqual({
      total: 1,
      services: [
        { index: 1, name: "activity", interfaces: ["android.app.IActivityManager"] },
      ],
    });

    expect(filterSystemServices(services, "windowmanager")).toEqual({
      total: 1,
      services: [
        { index: 2, name: "window", interfaces: ["android.view.IWindowManager"] },
      ],
    });
  });

  it("builds an adb shell command for permission details", () => {
    expect(buildPermissionInfoCommand("android.permission.DUMP")).toBe(
      "pm list permissions -f | grep -A 5 -F -- 'android.permission.DUMP' || true",
    );
  });

  it("narrows permission info output to a single permission block", () => {
    const output = [
      "+ permission:android.permission.DUMP",
      "  package:android",
      "  label:null",
      "  description:null",
      "  protectionLevel:signature|privileged|development",
      "+ permission:androidx.legacy.coreutils.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION",
      "  package:com.mediatek.ims",
      "  label:null",
      "  description:null",
    ].join("\n");

    expect(parsePermissionInfoOutput(output, "android.permission.DUMP")).toEqual({
      permission: "android.permission.DUMP",
      package: "android",
      label: null,
      description: null,
      protectionLevel: "signature|privileged|development",
    });
  });
});

describe("foreground app parsing", () => {
  it("parses topResumedActivity with a relative activity class", () => {
    const output = "  topResumedActivity=ActivityRecord{2b3c1 u0 com.example/.MainActivity t123}";

    expect(parseForegroundAppOutput(output)).toEqual({
      package: "com.example",
      activity: "com.example.MainActivity",
    });
  });

  it("parses mResumedActivity with a fully-qualified activity", () => {
    const output = "  mResumedActivity=ActivityRecord{abc u0 com.foo/com.foo.Main t42}";

    expect(parseForegroundAppOutput(output)).toEqual({
      package: "com.foo",
      activity: "com.foo.Main",
    });
  });

  it("falls back to mFocusedApp when no resumed activity is present", () => {
    const output = "  mFocusedApp=AppWindowToken{12 token=Token{ab com.bar/com.bar.Launcher}}";

    expect(parseForegroundAppOutput(output)).toEqual({
      package: "com.bar",
      activity: "com.bar.Launcher",
    });
  });

  it("returns null when no foreground entry is present", () => {
    expect(parseForegroundAppOutput("  ResolvedActivity=null\n")).toBeNull();
  });
});

describe("am start command building and parsing", () => {
  it("builds a component launch command", () => {
    expect(buildAmStartCommand({ component: "com.example/.MainActivity" })).toBe(
      "am start -W -n 'com.example/.MainActivity'",
    );
  });

  it("builds a package launch command", () => {
    expect(buildAmStartCommand({ package: "com.example" })).toBe("am start -W 'com.example'");
  });

  it("rejects an empty target", () => {
    expect(() => buildAmStartCommand({})).toThrow("am start requires either a component or a package");
  });

  it("treats Status: ok as started", () => {
    const output = [
      "Starting: Intent { cmp=com.example/.MainActivity }",
      "Status: ok",
      "LaunchState: COLD",
      "Activity: com.example/.MainActivity",
      "TotalTime: 421",
      "WaitTime: 425",
      "Complete",
    ].join("\n");

    expect(parseAmStartOutput(output)).toEqual({ started: true });
  });

  it("treats a plain STARTED line as started", () => {
    expect(parseAmStartOutput("Starting: com.example\nSTARTED\n")).toEqual({ started: true });
  });

  it("treats an error as not started", () => {
    expect(parseAmStartOutput("Error: Activity class {com.example/.Nope} does not exist.")).toEqual({
      started: false,
    });
  });
});
