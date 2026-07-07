import { androidAppAnalysisProfile } from "./android-app-analysis/index.js";
import { androidFrameworkAnalysisProfile } from "./android-framework-analysis/index.js";
import { appCloudControlAnalysisProfile } from "./app-cloud-control-analysis/index.js";
import { webAnalysisProfile } from "./web-analysis/index.js";

const PROFILES = Object.freeze([
  androidAppAnalysisProfile,
  androidFrameworkAnalysisProfile,
  appCloudControlAnalysisProfile,
  webAnalysisProfile,
]);

function profileByDomain(domain) {
  return PROFILES.find((profile) => profile.ownsDomain(domain)) || androidAppAnalysisProfile;
}

function profileByKind(kind) {
  return PROFILES.find((profile) => profile.ownsKind(kind)) || androidAppAnalysisProfile;
}

function profileByAgent(agentName) {
  return PROFILES.find((profile) => profile.ownsAgent(agentName));
}

function allKinds() {
  return [...new Set(["analysis", "cli", "poc", "report", ...PROFILES.flatMap((profile) => profile.kinds)])];
}

function allReadTools() {
  return [...new Set(PROFILES.flatMap((profile) => profile.readTools || []))];
}

function allTopicNames() {
  return [...new Set(PROFILES.flatMap((profile) => Object.keys(profile.topicFiles)))];
}

export const decxAnalysisProfiles = Object.freeze({
  id: "decx-analysis-profiles",
  defaultDomain: androidAppAnalysisProfile.defaultDomain,
  defaultKind: "analysis",
  kinds: Object.freeze(allKinds()),
  readTools: Object.freeze(allReadTools()),
  domainFromKind(kind) {
    if (kind === "analysis" || kind === "cli" || kind === "poc" || kind === "report") return androidAppAnalysisProfile.defaultDomain;
    return profileByKind(kind).defaultDomain;
  },
  domainFromAgent(agentName) {
    return profileByAgent(agentName)?.defaultDomain;
  },
  roleForAgent(agentName) {
    const profile = profileByAgent(agentName);
    if (!profile) return null;
    return { role: "planner", raw: agentName || profile.id };
  },
  rolePrompt(role, params = {}) {
    return profileByDomain(params.domain).rolePrompt(role, params);
  },
  childPrompt(params = {}) {
    return profileByDomain(params.domain).childPrompt(params);
  },
  systemSections(params = {}) {
    return profileByDomain(params.domain).systemSections(params);
  },
  compactionContext() {
    return [
      "## DECX analysis profile registry recovery",
      "Preserve the active analysis profile, domain, profile asset paths, loaded knowledge topic, and profile-specific scripts.",
      ...PROFILES.map((profile) => `- ${profile.id}: ${profile.profileDir}`),
    ].join("\n");
  },
  shellEnv(output, context = {}) {
    const active = profileByDomain(context.domain || context.sessionDomain || this.defaultDomain);
    active.shellEnv(output, context);
    output.env.DECX_PROFILE_REGISTRY = this.id;
    output.env.DECX_AVAILABLE_PROFILES = PROFILES.map((profile) => profile.id).join(",");
  },
  tools({ tool, makeGraphTool, sessionDomain }) {
    return {
      decx_knowledge: makeGraphTool({
        name: "decx_knowledge",
        description: "Profile read-only function: load one compact knowledge topic from the active or selected analysis profile. Knowledge is a lead, not accepted graph evidence.",
        args: {
          profile: tool.schema.enum(["auto", ...PROFILES.map((item) => item.id)]).default("auto"),
          topic: tool.schema.string().default("index"),
        },
        run: (_graphDir, input, context) => {
          const active = input.profile === "auto"
            ? profileByDomain(sessionDomain(context.sessionID))
            : PROFILES.find((item) => item.id === input.profile);
          if (!active) throw new Error(`unknown DECX analysis profile: ${input.profile}`);
          return active.loadKnowledgeTopic(input.topic);
        },
      }),
      decx_profile_assets: makeGraphTool({
        name: "decx_profile_assets",
        description: "Profile read-only function: list profile-owned knowledge and script paths.",
        args: { profile: tool.schema.enum(["all", ...PROFILES.map((item) => item.id)]).default("all") },
        run: (_graphDir, input) => {
          const selected = input.profile === "all" ? PROFILES : PROFILES.filter((item) => item.id === input.profile);
          return JSON.stringify(selected.map((profile) => ({
            id: profile.id,
            title: profile.title,
            domains: profile.domains,
            kinds: profile.kinds,
            profileDir: profile.profileDir,
            knowledgeDir: profile.knowledgeDir,
            scriptsDir: profile.scriptsDir,
            topics: Object.keys(profile.topicFiles),
            scripts: profile.scripts,
          })), null, 2);
        },
      }),
    };
  },
});

export { PROFILES as analysisProfileList };
