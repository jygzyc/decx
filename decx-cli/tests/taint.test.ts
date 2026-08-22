/**
 * Taint command and client tests (mock-based).
 *
 * Covers the three taint surfaces (config / analyze / progress):
 *  - client methods build correct request paths and payloads
 *  - command tree structure and options
 *  - analyze input validation (session vs apk)
 */

import { Command } from "commander";
import { DecxClient } from "../src/core/client.js";
import { makeTaintCommand } from "../src/commands/taint.js";
import { makeSelfCommand } from "../src/commands/self.js";

// ── Mock fetch helpers ───────────────────────────────────────────────────

type RecordedCall = { url: string; body: unknown };
const calls: RecordedCall[] = [];
let respondWith: (call: RecordedCall) => Record<string, unknown> = () => ({ ok: true });

function setupMockFetch() {
    respondWith = () => ({ ok: true });
    calls.length = 0;
    return async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const urlStr = typeof url === "string" ? url : url.toString();
        let body: unknown = {};
        try {
            body = init?.body ? JSON.parse(init.body as string) : {};
        } catch {
            body = {};
        }
        calls.push({ url: urlStr, body });
        return {
            ok: true,
            status: 200,
            json: async () => respondWith({ url: urlStr, body }),
        } as Response;
    };
}

function createProgram(): Command {
    const program = new Command();
    program.name("decx");
    program.addCommand(makeTaintCommand());
    program.addCommand(makeSelfCommand());
    return program;
}

function findCommand(root: Command, path: string[]): Command | undefined {
    let cmd: Command = root;
    for (const part of path) {
        const sub = cmd.commands.find((c) => c.name() === part);
        if (!sub) return undefined;
        cmd = sub;
    }
    return cmd;
}

// ── Client methods ────────────────────────────────────────────────────────

describe("DecxClient taint methods", () => {
    let client: DecxClient;

    beforeAll(() => {
        client = new DecxClient("127.0.0.1", 25419, 10, setupMockFetch());
    });

    afterEach(() => {
        calls.length = 0;
    });

    test("taintConfig posts to /api/decx/taint/config with empty payload by default", async () => {
        await client.taintConfig();
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toContain("/api/decx/taint/config");
        expect(calls[0].body).toMatchObject({ page: 1 });
    });

    test("taintConfig forwards rules, rulePath and ruleNames", async () => {
        await client.taintConfig({
            rules: '{"r":{}}',
            rulePath: "/tmp/rules",
            ruleNames: ["a", "b"],
        });
        expect(calls[0].body).toMatchObject({
            rules: '{"r":{}}',
            rulePath: "/tmp/rules",
            ruleNames: ["a", "b"],
        });
    });

    test("taintAnalyze posts target, rules and analysis tuning", async () => {
        await client.taintAnalyze({
            target: { session: "sieve" },
            ruleNames: ["deviceIdLeak"],
            analysis: { contextSensitivity: "2obj", scope: "APP" },
            limits: { timeoutSec: 120 },
        });
        expect(calls[0].url).toContain("/api/decx/taint/analyze");
        expect(calls[0].body).toMatchObject({
            target: { session: "sieve" },
            ruleNames: ["deviceIdLeak"],
            analysis: { contextSensitivity: "2obj", scope: "APP" },
            limits: { timeoutSec: 120 },
        });
    });

    test("taintProgress posts jobId and cancel flag", async () => {
        await client.taintProgress({ jobId: "taint-1", cancel: true });
        expect(calls[0].url).toContain("/api/decx/taint/progress");
        expect(calls[0].body).toMatchObject({ jobId: "taint-1", cancel: true });
    });
});

// ── Command tree ──────────────────────────────────────────────────────────

describe("decx taint command tree", () => {
    test("taint group exposes config, analyze and progress subcommands", () => {
        const cmd = findCommand(createProgram(), ["taint"])!;
        expect(cmd.commands.map((c) => c.name()).sort()).toEqual(["analyze", "config", "progress"]);
    });

    test("analyze carries target, rule, and tuning options", () => {
        const analyze = findCommand(createProgram(), ["taint", "analyze"])!;
        const flags = analyze.options.map((o) => o.flags).join(" ");
        expect(flags).toContain("--target-session <name>");
        expect(flags).toContain("--apk <path>");
        expect(flags).toContain("--rules <file|json>");
        expect(flags).toContain("--rule-path <dir>");
        expect(flags).toContain("--rule-names <names>");
        expect(flags).toContain("--cs <mode>");
        expect(flags).toContain("--timeout <sec>");
    });

    test("progress supports watch and cancel", () => {
        const progress = findCommand(createProgram(), ["taint", "progress"])!;
        const flags = progress.options.map((o) => o.flags).join(" ");
        expect(flags).toContain("--watch");
        expect(flags).toContain("--cancel");
    });

    test("self install exposes the tai-e subcommand", () => {
        const install = findCommand(createProgram(), ["self", "install"])!;
        expect(install.commands.map((c) => c.name())).toContain("tai-e");
    });
});
