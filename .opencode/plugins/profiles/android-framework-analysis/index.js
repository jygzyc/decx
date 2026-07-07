import { createAnalysisProfile } from "../shared/analysis-profile.js";

export const androidFrameworkAnalysisProfile = createAnalysisProfile(import.meta.url, {
  id: "android-framework-analysis",
  title: "Android Framework Analysis",
  defaultDomain: "framework",
  domains: ["framework"],
  kinds: ["android_framework"],
  agentAliases: ["android-framework-analysis", "decx-android-framework-analysis", "framework-analysis"],
  topicFiles: {
    index: "index.md",
    framework: "framework.md",
    evidence: "evidence.md",
  },
  roleTopics: {
    planner: ["framework", "evidence"],
    explorer: ["framework"],
    evaluator: ["evidence", "framework"],
    metacog: ["framework", "evidence"],
  },
  scripts: ["profile-assets.mjs"],
  profileRules: [
    "Prioritize Binder entrypoints, permission gates, identity transitions, cross-user binding, provider proxying, PendingIntent dispatch, async races, and transition control.",
    "Use system service discovery and method/xref/context queries before broad source reading.",
    "Treat caller identity and user/profile binding as first-class evidence.",
  ],
});
