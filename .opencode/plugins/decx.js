import { createDecxGraphPlugin } from "./lib/base-plugin.js";
import { decxAnalysisProfiles } from "./profiles/index.js";

export const DecxPlugin = (input = {}) => createDecxGraphPlugin(decxAnalysisProfiles, input);

export default DecxPlugin;
