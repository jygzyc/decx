"""Offline subprocess tests for portable skill discovery and validation."""

import pathlib
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
CHECKER = REPO_ROOT / "scripts" / "check-skills.py"


class CheckSkillsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="decx-skills-")
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)

    def run_checker(self, *roots):
        return subprocess.run(
            [sys.executable, str(CHECKER), *map(str, roots)],
            cwd=self.root,
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )

    def write_skill(self, root, directory="example", name=None, description=None, body=""):
        skill = root / directory
        skill.mkdir(parents=True)
        text = (
            f"---\nname: {name or directory}\n"
            f"description: {description or 'Use when validating a portable execution skill.'}\n"
            f"---\n\n# Example\n{body}\n"
        )
        (skill / "SKILL.md").write_text(text, encoding="utf-8")
        return skill

    def test_default_root_is_agents_skills_outside_checkout(self):
        result = self.run_checker()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        source = REPO_ROOT / ".agents" / "skills"
        count = sum(skill.is_dir() for skill in source.iterdir())
        self.assertGreater(count, 0)
        self.assertIn(f"checked {count} skills, 0 problem(s)", result.stdout)
        self.assertTrue((source / "decx-tool" / "SKILL.md").is_file())
        self.assertFalse((REPO_ROOT / "skills").exists())

    def test_valid_relative_reference(self):
        skill = self.write_skill(self.root / "skills", body="[guide](references/guide.md)")
        (skill / "references").mkdir()
        (skill / "references" / "guide.md").write_text("# Guide\n", encoding="utf-8")
        result = self.run_checker(skill.parent)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("checked 1 skills, 0 problem(s)", result.stdout)

    def test_missing_root_fails(self):
        result = self.run_checker(self.root / "absent")
        self.assertEqual(result.returncode, 1)
        self.assertIn("no skills directory at", result.stderr)

    def test_empty_root_fails(self):
        result = self.run_checker(self.root)
        self.assertEqual(result.returncode, 1)
        self.assertIn("no skills found under", result.stderr)

    def test_missing_skill_file_fails(self):
        (self.root / "example").mkdir()
        result = self.run_checker(self.root)
        self.assertEqual(result.returncode, 1)
        self.assertIn("missing SKILL.md", result.stdout)

    def test_mismatched_name_fails(self):
        self.write_skill(self.root, name="other")
        result = self.run_checker(self.root)
        self.assertEqual(result.returncode, 1)
        self.assertIn("!= directory name", result.stdout)

    def test_broken_reference_fails(self):
        self.write_skill(self.root, body="[guide](references/absent.md)")
        result = self.run_checker(self.root)
        self.assertEqual(result.returncode, 1)
        self.assertIn("link does not resolve", result.stdout)

    def test_duplicate_name_across_roots_fails(self):
        roots = [self.root / "first", self.root / "second"]
        for root in roots:
            self.write_skill(root)
        result = self.run_checker(*roots)
        self.assertEqual(result.returncode, 1)
        self.assertIn("duplicate skill name example", result.stdout)

    def test_unquoted_yaml_colon_fails(self):
        self.write_skill(self.root, description="Useful: validate portable execution skills.")
        result = self.run_checker(self.root)
        self.assertEqual(result.returncode, 1)
        self.assertIn("quote the scalar", result.stdout)

    def test_quoted_yaml_colon_is_valid(self):
        self.write_skill(self.root, description='"Useful: validate portable execution skills."')
        result = self.run_checker(self.root)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
