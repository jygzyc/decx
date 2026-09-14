package registry

import (
	"slices"
	"strings"
)

// knownComponents are the components this CLI ships with: their release source
// is compiled in so a fresh machine can run `decx install jadx` before anything
// is on disk. The table carries no command tree — every runtime definition
// (commands, launch and stop) comes from the component's own decx.json, which an
// installed component always wins with. A `default` component is installed by a
// bare `decx install`; the others are opt-in.
var knownComponents = []struct {
	ID          string
	Kind        string
	Description string
	Default     bool
	Release     Install
}{
	{
		ID:          "jadx",
		Kind:        KindServer,
		Description: "JADX/DEX analysis server",
		Default:     true,
		Release: Install{
			Source:    "repo",
			Tag:       "jadx-server-v{version}",
			Asset:     "jadx-server-{version}.zip",
			Checksums: "SHA256SUMS",
			Format:    "zip",
		},
	},
	{
		ID:          "asc",
		Kind:        KindServer,
		Description: "ASC DEX analysis server",
		Release: Install{
			Source:    "repo",
			Tag:       "asc-server-v{version}",
			Asset:     "asc-server-{version}.zip",
			Checksums: "SHA256SUMS",
			Format:    "zip",
		},
	},
	{
		ID:          "kuna",
		Kind:        KindServer,
		Description: "Kuna native code analysis server",
		Release: Install{
			Source:    "repo",
			Tag:       "kuna-server-v{version}",
			Asset:     "kuna-server-{version}-{os}-{arch}.zip",
			Checksums: "SHA256SUMS",
			Format:    "zip",
		},
	},
	{
		ID:          "ard-framework",
		Kind:        KindPlugin,
		Description: "Android device and framework workflows",
		Default:     true,
		Release: Install{
			Source:    "repo",
			Tag:       "ard-framework-v{version}",
			Asset:     "decx-ard-framework-plugin-{version}.zip",
			Checksums: "SHA256SUMS",
			Format:    "zip",
		},
	},
}

// applyKnown fills in the components that were not found locally, so
// `decx install --module <id>` can fetch them and `module list` can show what
// exists. A placeholder has no commands and is not installed: it only knows
// where its release comes from until the artifact's own manifest is unpacked.
func (c *Config) applyKnown() {
	for i := range knownComponents {
		known := &knownComponents[i]
		release := known.Release
		if release.Repository == "" {
			release.Repository = DefaultRepository
		}
		switch known.Kind {
		case KindServer:
			// A locally discovered component keeps its own manifest, but what the
			// CLI ships with (the default marker, a description and the release it
			// can be refreshed from) still applies to it.
			index := -1
			for j := range c.Modules {
				if c.Modules[j].ID == known.ID {
					index = j
					break
				}
			}
			if index < 0 {
				c.Modules = append(c.Modules, Module{
					ID:          known.ID,
					Description: known.Description,
					Release:     &release,
					Default:     known.Default,
				})
				continue
			}
			module := &c.Modules[index]
			if module.Description == "" {
				module.Description = known.Description
			}
			if module.Release == nil {
				module.Release = &release
			}
			module.Default = known.Default
		case KindPlugin:
			index := -1
			for j := range c.Plugins {
				if c.Plugins[j].ID == known.ID {
					index = j
					break
				}
			}
			if index < 0 {
				c.Plugins = append(c.Plugins, Plugin{
					ID:          known.ID,
					Description: known.Description,
					Release:     &release,
					Default:     known.Default,
				})
				continue
			}
			plugin := &c.Plugins[index]
			if plugin.Description == "" {
				plugin.Description = known.Description
			}
			if plugin.Release == nil {
				plugin.Release = &release
			}
			plugin.Default = known.Default
		}
	}
	slices.SortFunc(c.Modules, func(a, b Module) int { return strings.Compare(a.ID, b.ID) })
	slices.SortFunc(c.Plugins, func(a, b Plugin) int { return strings.Compare(a.ID, b.ID) })
}
