from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True, slots=True)
class SkillReference:
    name: str
    path: Path

    def label(self, root: Path) -> str:
        try:
            path = self.path.relative_to(root)
        except ValueError:
            path = self.path
        return f"{self.name}: {path}"


@dataclass(frozen=True, slots=True)
class SkillBundle:
    root: Path
    active: SkillReference
    shared: tuple[SkillReference, ...] = ()

    def references(self) -> tuple[SkillReference, ...]:
        return (self.active, *self.shared)


def load_skill_bundle(project_root: str | Path, mode: str) -> SkillBundle:
    root = Path(project_root)
    active_name = "decxcli-framework-vulnhunt" if mode == "framework-vulnhunt" else "decxcli-app-vulnhunt"
    bundle = SkillBundle(
        root=root,
        active=skill_ref(root, active_name),
        shared=(
            skill_ref(root, "decxcli"),
            skill_ref(root, "decx-subagent-analysis"),
        ),
    )
    missing = [ref.path for ref in bundle.references() if not ref.path.exists()]
    if missing:
        paths = ", ".join(str(path) for path in missing)
        raise FileNotFoundError(f"missing DECX skill reference(s): {paths}")
    return bundle


def skill_ref(root: Path, name: str) -> SkillReference:
    return SkillReference(name=name, path=root / "skills" / name / "SKILL.md")
