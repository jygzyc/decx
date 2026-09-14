package registry

import (
	"runtime"
	"strings"
)

// DefaultTag is the release tag a component uses when it does not declare one:
// a plain version tag, as the CLI itself is published under.
const DefaultTag = "v{version}"

// AssetOS and AssetArch are the platform tokens substituted for {os}/{arch} in
// asset names. They are variables so tests can exercise other platforms.
var (
	AssetOS   = runtime.GOOS
	AssetArch = runtime.GOARCH
)

// RenderTag renders the release tag one version is published under.
func RenderTag(tag, version string) string {
	if tag == "" {
		tag = DefaultTag
	}
	return strings.ReplaceAll(tag, "{version}", version)
}

// TagVersion is the inverse of RenderTag: the version a release tag carries, or
// "" when the tag does not match the component's pattern.
func TagVersion(tag, template string) string {
	if template == "" {
		template = DefaultTag
	}
	before, after, found := strings.Cut(template, "{version}")
	if !found {
		return ""
	}
	if !strings.HasPrefix(tag, before) || !strings.HasSuffix(tag, after) {
		return ""
	}
	version := strings.TrimSuffix(strings.TrimPrefix(tag, before), after)
	if version == "" {
		return ""
	}
	return version
}

// RenderAsset renders an asset name for the running platform.
func RenderAsset(asset, version string) string {
	asset = strings.ReplaceAll(asset, "{version}", version)
	asset = strings.ReplaceAll(asset, "{os}", AssetOS)
	asset = strings.ReplaceAll(asset, "{arch}", AssetArch)
	return asset
}

// AssetCandidates lists the file names one release may publish, most preferred
// first: the declared asset followed by its fallbacks, rendered for the version
// and the running platform.
func AssetCandidates(install *Install, version string) []string {
	names := make([]string, 0, 1+len(install.AssetFallbacks))
	for _, name := range append([]string{install.Asset}, install.AssetFallbacks...) {
		names = append(names, RenderAsset(name, version))
	}
	return names
}
