import { createAnalysisProfile } from "../shared/analysis-profile.js";

export const androidAppAnalysisProfile = createAnalysisProfile(import.meta.url, {
  id: "android-app-analysis",
  title: "Android App Analysis",
  defaultDomain: "app",
  domains: ["app"],
  kinds: ["android_app"],
  agentAliases: ["android-app-analysis", "decx-android-app-analysis", "app-analysis"],
  topicFiles: {
    index: "index.md",
    app: "app.md",
    evidence: "evidence.md",
    poc_report: "poc-report.md",
  },
  roleTopics: {
    planner: ["app", "evidence"],
    explorer: ["app"],
    evaluator: ["evidence", "app"],
    metacog: ["app", "evidence"],
  },
  scripts: ["profile-assets.mjs"],
  profileRules: [
    "Prioritize exported components, deep links, providers, WebView bridges, PendingIntent flows, broadcasts, and cross-app channels.",
    "Use DECX app metadata and code/xref queries before broad source reading.",
    "Do not promote a finding without reachable, controllable, deeply traced, and impactful evidence.",
  ],
});
