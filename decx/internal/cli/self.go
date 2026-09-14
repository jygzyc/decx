package cli

import (
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/jygzyc/decx/decx/internal/install"
	"github.com/jygzyc/decx/decx/internal/registry"
	"github.com/jygzyc/decx/decx/internal/skills"
)

// moduleArgs are the shared flags of `decx install` and `decx self update`:
// without --module a plain install takes every module that declares a release
// source, while a plain update refreshes every installed module that can be
// refreshed. --cli replaces the running decx executable in both commands.
var moduleArgs = []registry.Arg{
	{ID: "module", Kind: "multi", Long: "module", Type: "string", Help: "Module to install (repeatable): a module id, owner/repo[@ref] or a local path"},
	{ID: "all", Kind: "flag", Long: "all", Type: "bool", Help: "Install every module that declares a release source (the default without --module)"},
	{ID: "prerelease", Kind: "flag", Long: "prerelease", Type: "bool", Help: "Use the newest prerelease instead of the latest stable release"},
	{ID: "force", Kind: "flag", Long: "force", Type: "bool", Help: "Download again even when the installed version already matches"},
	{ID: "cli", Kind: "flag", Long: "cli", Type: "bool", Help: "Also replace the decx executable with the newest release"},
}

// modulePlan is one resolved piece of install/update work: a release install, a
// recorded-origin re-import, or an explicit repository/path import.
type modulePlan struct {
	id       string
	spec     *install.Spec
	recorded *registry.Source
	value    string // explicit repository or path source
	path     bool   // value names a local path rather than a repository
}

func (a *App) runSelf(ctx context.Context, config *registry.Config, input []string) error {
	if len(input) == 0 || input[0] == "--help" || input[0] == "-h" || input[0] == "help" {
		fmt.Fprint(a.Out, "Usage: decx self <command>\n\n"+
			"  update    Update installed modules and the decx executable\n"+
			"  skills    Install the DECX agent skills and link them for AI clients\n\n"+
			"Modules describe themselves in a decx.json manifest; there is no\n"+
			"bundled configuration file to initialise.\n\n"+
			"Common arguments:\n"+
			"  --module <id>   Module to update (repeatable)\n"+
			"  --all           Every installed module (the default without --module)\n"+
			"  --prerelease    Newest prerelease instead of the latest stable release\n"+
			"  --force         Download again even when the version already matches\n"+
			"  --cli           Replace the decx executable as well\n")
		return nil
	}
	switch input[0] {
	case "update":
		return a.installComponents(ctx, config, input[1:], true)
	case "skills":
		return a.selfSkills(ctx, input[1:])
	}
	return fmt.Errorf("unknown command self %s", input[0])
}

// runInstall is `decx install`: it installs the optional modules that are not
// present yet. `decx self update` shares the same flags and refreshes what is
// installed from its origin.
func (a *App) runInstall(ctx context.Context, config *registry.Config, input []string) error {
	return a.installComponents(ctx, config, input, false)
}

// installUsage is the shared help text of `decx install` and `decx self update`.
func installUsage(update bool) string {
	if update {
		return "Usage: decx self update [--module <id|repo|path>]... [--all] [--prerelease] [--force] [--cli]\n\n" +
			"Refreshes installed modules from where they came from: a module imported from\n" +
			"a repository or a local path is re-imported from that origin, everything else\n" +
			"comes from the release its decx.json manifest declares. With --cli the decx\n" +
			"executable is replaced as well. Modules whose version already matches are\n" +
			"left alone unless --force is given.\n\n" +
			"  --module <id|repo|path>  Module to update (repeatable)\n" +
			"  --all                    Every installed module that can be refreshed (the default)\n" +
			"  --prerelease             Newest prerelease instead of the latest stable release\n" +
			"  --force                  Download again even when the installed version already matches\n" +
			"  --cli                    Replace the decx executable as well\n"
	}
	return "Usage: decx install [--module <id|repo|path>]... [--all] [--prerelease] [--force] [--cli]\n\n" +
		"Installs modules. An <id> names a known or already installed module and is\n" +
		"fetched from the release its decx.json manifest declares; owner/repo[@ref]\n" +
		"downloads that repository archive; a local directory or .zip/.tar.gz archive\n" +
		"is imported in place. Without --module every module that declares a release\n" +
		"source is installed (every shipped module does), which is also what --all\n" +
		"asks for explicitly. With --cli the decx executable is replaced as well;\n" +
		"--cli alone only refreshes it.\n\n" +
		"  --module <id|repo|path>  Module to install (repeatable)\n" +
		"  --all                    Every module that declares a release source (the default)\n" +
		"  --prerelease             Newest prerelease instead of the latest stable release\n" +
		"  --force                  Download again even when the installed version already matches\n" +
		"  --cli                    Replace the decx executable as well\n"
}

// skillsArgs declares `self skills install` options.
var skillsArgs = []registry.Arg{
	{ID: "client", Kind: "multi", Long: "client", Type: "string", Help: "Client to link the skills for (codex, claude-code, cursor, agents; comma separated or repeatable)"},
}

// selfSkills installs the DECX agent skills and links them into the skill
// directories of the selected clients.
func (a *App) selfSkills(ctx context.Context, input []string) error {
	if len(input) == 0 || input[0] == "--help" || input[0] == "-h" || input[0] == "help" {
		fmt.Fprint(a.Out, "Usage: decx self skills install [--client <client>]...\n\n"+
			"Downloads the DECX skills into $DECX_HOME/skills and links them for the\n"+
			"selected clients; without --client the shared ~/.agents/skills directory is\n"+
			"used. Supported clients: codex, claude-code (alias claude), cursor, agents.\n")
		return nil
	}
	if input[0] != "install" {
		return fmt.Errorf("unknown command self skills %s", input[0])
	}
	args, err := registry.ParseArgs(skillsArgs, input[1:])
	if err != nil {
		return err
	}
	userHome := a.UserHome
	if userHome == "" {
		userHome, err = os.UserHomeDir()
		if err != nil {
			return err
		}
	}
	result, err := skills.Install(ctx, a.Home, userHome, a.SkillsSource, skills.Clients(args["client"]))
	if err != nil {
		return err
	}
	return a.output(result)
}

func (a *App) installComponents(ctx context.Context, config *registry.Config, input []string, update bool) error {
	if len(input) == 1 && (input[0] == "--help" || input[0] == "-h" || input[0] == "help") {
		fmt.Fprint(a.Out, installUsage(update))
		return nil
	}
	args, err := registry.ParseArgs(moduleArgs, input)
	if err != nil {
		return err
	}
	updateCLI := first(args, "cli") == "true"
	plans, err := selectModules(a.Home, config, args, update)
	if err != nil {
		return err
	}
	if updateCLI && !update && len(args["module"]) == 0 && first(args, "all") != "true" {
		// `install --cli` alone refreshes the running executable; it does not
		// also install every module the way a bare `decx install` does.
		plans = nil
	}
	if len(plans) == 0 && !updateCLI {
		if update {
			return errors.New("nothing to update; no module is installed that can be refreshed")
		}
		return errors.New("nothing to install; no module declares an install source")
	}
	downloader := install.Downloader{Client: a.HTTP, GitHub: a.GitHub, GitHubAPI: a.GitHubAPI}
	force := first(args, "force") == "true"
	prerelease := first(args, "prerelease") == "true"
	statuses := make([]install.Status, 0, len(plans))
	for _, plan := range plans {
		status, err := a.installModule(ctx, downloader, plan, force, prerelease)
		if err != nil {
			return err
		}
		statuses = append(statuses, status)
	}
	result := map[string]any{"ok": true, "modules": statuses}
	if updateCLI {
		status, err := downloader.UpdateCLI(ctx, install.CLIUpdate{
			CurrentVersion: a.Version,
			Executable:     a.CLIExecutable,
			Force:          force,
			Prerelease:     prerelease,
		}, a.Err)
		if err != nil {
			return err
		}
		result["cli"] = status
	}
	return a.output(result)
}

// installModule executes one plan: a repository or path import, a re-import
// from a recorded origin, or a release install.
func (a *App) installModule(ctx context.Context, downloader install.Downloader, plan modulePlan, force, prerelease bool) (install.Status, error) {
	switch {
	case plan.recorded != nil:
		return downloader.ReimportSource(ctx, a.Home, *plan.recorded, a.Err)
	case plan.path:
		return install.ImportPath(a.Home, plan.value, a.Err)
	case plan.value != "":
		return downloader.ImportRepository(ctx, a.Home, plan.value, a.Err)
	default:
		artifact, err := downloader.Resolve(ctx, *plan.spec, "", prerelease)
		if err != nil {
			return install.Status{}, err
		}
		return downloader.InstallSpec(ctx, *plan.spec, artifact, force, a.Err)
	}
}

// selectModules resolves the requested modules and how each one is installed.
// A module that was imported from a repository or a path is re-imported from
// that origin on update; everything else comes from the manifest's release
// block. A plain install installs every module that declares a release source
// (the shipped modules all do), --module names one explicitly and a bare update
// refreshes every installed module that can be refreshed.
func selectModules(home string, config *registry.Config, args map[string][]string, update bool) ([]modulePlan, error) {
	names := args["module"]
	plans := []modulePlan{}
	add := func(id string) error {
		module, plugin := findModule(config, id)
		if module == nil && plugin == nil {
			return fmt.Errorf("unknown module %q", id)
		}
		if update {
			if origin := recordedSource(home, id); origin != nil {
				plans = append(plans, modulePlan{id: id, recorded: origin})
				return nil
			}
		}
		if moduleRelease(module, plugin) == nil {
			return fmt.Errorf("module %s does not declare an install source; import it from a repository or a path", id)
		}
		if module != nil {
			spec := install.ModuleSpec(home, *module)
			plans = append(plans, modulePlan{id: id, spec: &spec})
		} else {
			spec := install.PluginSpec(home, *plugin)
			plans = append(plans, modulePlan{id: id, spec: &spec})
		}
		return nil
	}
	if len(names) == 0 {
		for i := range config.Modules {
			module := &config.Modules[i]
			if !selectModule(home, update, module.Release != nil, install.Installed(home, *module), module.ID) {
				continue
			}
			if err := add(module.ID); err != nil {
				return nil, err
			}
		}
		for i := range config.Plugins {
			plugin := &config.Plugins[i]
			if !selectModule(home, update, plugin.Release != nil, plugin.Installed, plugin.ID) {
				continue
			}
			if err := add(plugin.ID); err != nil {
				return nil, err
			}
		}
		return plans, nil
	}
	for _, name := range names {
		if module, plugin := findModule(config, name); module != nil || plugin != nil {
			if err := add(name); err != nil {
				return nil, err
			}
			continue
		}
		if info, err := os.Stat(name); err == nil && (info.IsDir() || info.Mode().IsRegular()) {
			plans = append(plans, modulePlan{value: name, path: true})
			continue
		}
		if _, ok := install.ParseRepository(name); ok {
			plans = append(plans, modulePlan{value: name})
			continue
		}
		return nil, fmt.Errorf("unknown module %q; expected a module id, owner/repo[@ref] or an existing path", name)
	}
	return plans, nil
}

// selectModule reports whether one module is part of a bulk selection.
func selectModule(home string, update, hasRelease, installed bool, id string) bool {
	if update {
		// A bare or --all update only refreshes what is present and refreshed
		// from somewhere: a release source or a recorded import origin.
		return installed && (hasRelease || recordedSource(home, id) != nil)
	}
	// A plain install and --all both take every module that can be fetched from
	// a release; the `default` marker only drives the session module choice and
	// `module list`.
	return hasRelease
}

// findModule resolves an id to its module or plugin definition; module wins on
// the theoretical id collision, matching `decx -m <id>`.
func findModule(config *registry.Config, id string) (*registry.Module, *registry.Plugin) {
	if module, ok := config.Module(id); ok {
		return &module, nil
	}
	if plugin, ok := config.Plugin(id); ok {
		return nil, &plugin
	}
	return nil, nil
}

// moduleRelease returns the release block of whichever kind is set.
func moduleRelease(module *registry.Module, plugin *registry.Plugin) *registry.Install {
	if module != nil {
		return module.Release
	}
	if plugin != nil {
		return plugin.Release
	}
	return nil
}
