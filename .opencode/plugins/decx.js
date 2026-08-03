// Minimal DECX entrypoint for OpenCode.
//
// OpenCode auto-loads every module in .opencode/plugins/. This plugin does
// one thing: tell the agent which DECX skills are installed so it routes
// work to the right SKILL.md. No workflow logic lives here.
export const DecxPlugin = async () => {
  return {
    "experimental.chat.system.transform": async (_input, output) => {
      output.system.push(
        "DECX skills are installed in the repo skills/ directory: load decx-cli/SKILL.md for DECX command usage, decx-vulnhunt/SKILL.md for Android vulnerability hunting (App + Framework tracks), decx-report/SKILL.md for reports, decx-poc/SKILL.md for PoC construction.",
      );
    },
  };
};
