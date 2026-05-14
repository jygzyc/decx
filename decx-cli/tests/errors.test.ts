/**
 * Error handling unit tests.
 */

import {
  DecxError,
  ProcessError,
  ServerError,
  FileError,
  ConfigError,
  withErrorHandler,
} from "../src/utils/errors.js";
import { Formatter } from "../src/utils/formatter.js";
import { jest } from "@jest/globals";

describe("Error classes", () => {
  it("DecxError has message, code, details", () => {
    const err = new DecxError("test", "E001", { key: "val" });
    expect(err.message).toBe("test");
    expect(err.code).toBe("E001");
    expect(err.details).toEqual({ key: "val" });
    expect(err).toBeInstanceOf(Error);
  });

  it("ProcessError stores pid in details", () => {
    const err = new ProcessError("crashed", 12345);
    expect(err.code).toBe("PROCESS_ERROR");
    expect(err.details).toEqual({ pid: 12345 });
  });

  it("ServerError stores port in details", () => {
    const err = new ServerError("timeout", 25419);
    expect(err.code).toBe("SERVER_ERROR");
    expect(err.details).toEqual({ port: 25419 });
  });

  it("FileError stores filePath in details", () => {
    const err = new FileError("not found", "/tmp/foo.apk");
    expect(err.code).toBe("FILE_ERROR");
    expect(err.details).toEqual({ filePath: "/tmp/foo.apk" });
  });

  it("ConfigError stores key in details", () => {
    const err = new ConfigError("bad config", "server.port");
    expect(err.code).toBe("CONFIG_ERROR");
    expect(err.details).toEqual({ key: "server.port" });
  });
});

describe("withErrorHandler", () => {
  const mockExit = jest.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit");
  }) as () => never);
  const mockConsole = jest.spyOn(console, "error").mockImplementation(() => {});
  const mockLog = jest.spyOn(console, "log").mockImplementation(() => {});

  afterAll(() => {
    mockExit.mockRestore();
    mockConsole.mockRestore();
    mockLog.mockRestore();
  });

  it("calls handler normally on success", async () => {
    const handler = jest.fn<() => Promise<string>>().mockResolvedValue("ok");
    const wrapped = withErrorHandler(handler);
    await wrapped();
    expect(handler).toHaveBeenCalled();
  });

  it("catches DecxError and formats it", async () => {
    const handler = jest.fn<() => Promise<string>>().mockRejectedValue(new ProcessError("test", 123));
    const wrapped = withErrorHandler(handler);
    await expect(wrapped()).rejects.toThrow("process.exit");
  });
});
