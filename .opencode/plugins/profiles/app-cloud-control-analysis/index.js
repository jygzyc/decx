import { createAnalysisProfile } from "../shared/analysis-profile.js";

export const appCloudControlAnalysisProfile = createAnalysisProfile(import.meta.url, {
  id: "app-cloud-control-analysis",
  title: "App Cloud Control Analysis",
  defaultDomain: "app_cloud_control",
  domains: ["app_cloud_control"],
  kinds: ["app_cloud_control"],
  agentAliases: ["app-cloud-control-analysis", "cloud-control-analysis", "decx-app-cloud-control-analysis"],
  topicFiles: {
    index: "index.md",
    cloud_control: "cloud-control.md",
    evidence: "evidence.md",
  },
  roleTopics: {
    planner: ["cloud_control", "evidence"],
    explorer: ["cloud_control"],
    evaluator: ["evidence", "cloud_control"],
    metacog: ["cloud_control", "evidence"],
  },
  scripts: ["profile-assets.mjs"],
  profileRules: [
    "Model backend-delivered data as a trust boundary when it changes local security decisions or sinks.",
    "Trace remote config, push payloads, task dispatch, update/plugin rules, and backend-driven URL/Intent/WebView behavior to local impact.",
    "Record server-controlled assumptions as candidate facts unless backed by concrete captured payloads or code paths.",
  ],
});
