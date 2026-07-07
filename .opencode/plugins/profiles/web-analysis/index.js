import { createAnalysisProfile } from "../shared/analysis-profile.js";

export const webAnalysisProfile = createAnalysisProfile(import.meta.url, {
  id: "web-analysis",
  title: "Web Analysis",
  defaultDomain: "web",
  domains: ["web"],
  kinds: ["web"],
  agentAliases: ["web-analysis", "decx-web-analysis"],
  topicFiles: {
    index: "index.md",
    web: "web.md",
    evidence: "evidence.md",
  },
  roleTopics: {
    planner: ["web", "evidence"],
    explorer: ["web"],
    evaluator: ["evidence", "web"],
    metacog: ["web", "evidence"],
  },
  scripts: ["profile-assets.mjs"],
  profileRules: [
    "Use probe-first web observations before deep source reading.",
    "Prioritize auth/session binding, SSRF/file read, XSS/context encoding, upload/import, API object control, redirects, and OAuth/SSO boundaries.",
    "Separate browser-observed behavior from server-side proof and cite concrete request/response or source evidence.",
  ],
});
