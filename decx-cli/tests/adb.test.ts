import {
  buildPermissionInfoCommand,
  detectFrameworkOemFromBrand,
  filterSystemServices,
  parseAdbDevicesOutput,
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

  it("detects a supported framework OEM directly from brand", () => {
    expect(detectFrameworkOemFromBrand("Xiaomi")).toBe("xiaomi");
    expect(detectFrameworkOemFromBrand("GOOGLE")).toBe("google");
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
