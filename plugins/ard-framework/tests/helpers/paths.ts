/**
 * Test path helpers.
 *
 * Compiled tests live under `dist/tests/`, so fixtures that stay in the source
 * tree cannot be addressed with `__dirname` alone: walk up to the plugin root
 * (the directory holding `package.json`) and resolve from there.
 */
const { existsSync } = require("fs");
const path = require("path");

/** Walks up from `start` until the directory containing `package.json`. */
function findPluginRoot(start: string): string {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`framework plugin root not found above ${start}`);
    dir = parent;
  }
}

/** Absolute path of the source-tree fixture directory (`tests/fixtures`). */
function fixturesDir(): string {
  return path.join(findPluginRoot(__dirname), "tests", "fixtures");
}

module.exports = { findPluginRoot, fixturesDir };
