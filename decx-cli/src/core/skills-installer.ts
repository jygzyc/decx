import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync } from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { decxPath, userHome } from "./paths.js";
import { DecxError } from "../utils/errors.js";

export const SKILL_CLIENTS = ["codex", "claude-code", "cursor", "agents"] as const;
export type SkillClient = typeof SKILL_CLIENTS[number];

const CLIENT_ALIASES: Record<string, SkillClient> = {
  codex: "codex",
  "codex-cli": "codex",
  claude: "claude-code",
  "claude-code": "claude-code",
  cursor: "cursor",
};

export function parseSkillClients(values: string[]): SkillClient[] {
  const requested = values.flatMap((value) => value.split(","))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (requested.length === 0) return ["agents"];
  // Only clients with dedicated skill directories need special handling.
  // Every other client follows the cross-client ~/.agents/skills convention.
  const clients = requested.map((value) => CLIENT_ALIASES[value] ?? "agents");
  return [...new Set(clients)] as SkillClient[];
}

const CLIENT_DIRECTORIES: Record<SkillClient, string> = {
  codex: ".codex/skills",
  "claude-code": ".claude/skills",
  cursor: ".cursor/skills",
  agents: ".agents/skills",
};

export function skillClientDirectory(client: SkillClient, home: string = userHome()): string {
  return path.join(home, ...CLIENT_DIRECTORIES[client].split("/"));
}

function linkSkill(source: string, destination: string): void {
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(path.dirname(destination), { recursive: true });
  symlinkSync(source, destination, process.platform === "win32" ? "junction" : "dir");
}

export const DECX_SKILLS_REPOSITORY = "https://github.com/jygzyc/decx.git";

function cloneSkillsRepository(): { sourceDir: string; cleanup: () => void } {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "decx-skills-"));
  const repositoryDir = path.join(tempDir, "repo");
  const result = spawnSync("git", ["clone", "--depth", "1", DECX_SKILLS_REPOSITORY, repositoryDir], {
    encoding: "utf-8",
    timeout: 120_000,
  });
  if (result.error || result.status !== 0) {
    rmSync(tempDir, { recursive: true, force: true });
    const detail = result.error?.message ?? result.stderr.trim() ?? `git exited with status ${result.status}`;
    throw new DecxError(`Failed to download DECX skills from GitHub: ${detail}`, "INSTALL_ERROR");
  }
  return {
    sourceDir: path.join(repositoryDir, "skills"),
    cleanup: () => rmSync(tempDir, { recursive: true, force: true }),
  };
}

export interface SkillsInstallResult {
  ok: true;
  clients: Array<{ client: SkillClient; path: string }>;
  sourcePath: string;
  skills: string[];
  message: string;
}

export function installSkills(
  clients: SkillClient[],
  options: { sourceDir?: string; home?: string; storageDir?: string } = {},
): SkillsInstallResult {
  const checkout = options.sourceDir
    ? { sourceDir: options.sourceDir, cleanup: () => undefined }
    : cloneSkillsRepository();
  try {
    const skills = readdirSync(checkout.sourceDir)
      .filter((name) => name.startsWith("decx-") && statSync(path.join(checkout.sourceDir, name)).isDirectory())
      .filter((name) => existsSync(path.join(checkout.sourceDir, name, "SKILL.md")))
      .sort();
    if (skills.length === 0) throw new DecxError(`No DECX skills found in ${checkout.sourceDir}`, "INSTALL_ERROR");

    const home = options.home ?? userHome();
    const storageDir = options.storageDir ?? (options.home ? path.join(home, ".decx", "skills") : decxPath("skills"));
    mkdirSync(storageDir, { recursive: true });
    for (const skill of skills) {
      const storedSkill = path.join(storageDir, skill);
      rmSync(storedSkill, { recursive: true, force: true });
      cpSync(path.join(checkout.sourceDir, skill), storedSkill, { recursive: true });
    }

    const installed = clients.map((client) => {
      const target = skillClientDirectory(client, home);
      for (const skill of skills) linkSkill(path.join(storageDir, skill), path.join(target, skill));
      return { client, path: target };
    });
    return {
      ok: true,
      clients: installed,
      sourcePath: storageDir,
      skills,
      message: `Downloaded ${skills.length} DECX skills to ${storageDir} and linked them for ${installed.map(({ client }) => client).join(", ")}`,
    };
  } finally {
    checkout.cleanup();
  }
}
