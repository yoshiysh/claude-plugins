import re
import os
from pathlib import Path

NAME_PATTERN = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")


def validate_name(value: str, label: str) -> str:
    if not isinstance(value, str) or not NAME_PATTERN.fullmatch(value):
        raise ValueError(f"invalid {label} name: {value!r}")
    return value


def find_project_root(script_dir: Path) -> Path:
    for candidate in (script_dir.resolve(), *script_dir.resolve().parents):
        if ((candidate / ".claude-plugin" / "marketplace.json").is_file()
                and (candidate / "plugins").is_dir()):
            return candidate.resolve()
    raise ValueError(f"repository root not found from script directory: {script_dir}")


def guard_skill_root(root: Path, skills_dir: Path, plugins_dir: Path,
                     project_root: Path) -> None:
    ensure_within(skills_dir, skills_dir, project_root)
    ensure_within(plugins_dir, plugins_dir, project_root)
    if root.is_symlink():
        resolved = root.resolve()
        if (resolved.name != root.name or resolved.parent.name != "skills"
                or resolved.parent.parent.parent.resolve() != plugins_dir.resolve()):
            raise ValueError(f"skill root symlink does not target its published plugin skill: {root}")
    else:
        ensure_within(root, skills_dir, project_root)
        if root.parent.resolve() != skills_dir.resolve():
            raise ValueError(f"skill root is not a direct child of skills directory: {root}")
    guard_tree(root, [root], project_root)


def guard_plugin_root(root: Path, plugins_dir: Path, project_root: Path) -> None:
    if root.is_symlink():
        raise ValueError(f"plugin root must not be a symlink: {root}")
    ensure_within(root, plugins_dir, project_root)


def ensure_within(path: Path, root: Path, project_root: Path) -> Path:
    project = project_root.resolve()
    resolved_root = root.resolve()
    resolved_path = path.resolve()
    if not (resolved_root == project or project in resolved_root.parents):
        raise ValueError(f"allowed root escapes checkout: {root}")
    if not (resolved_path == resolved_root or resolved_root in resolved_path.parents):
        raise ValueError(f"path escapes allowed root: {path}")
    return path


def ensure_within_roots(path: Path, roots: list[Path], project_root: Path) -> Path:
    for root in roots:
        try:
            return ensure_within(path, root, project_root)
        except ValueError:
            pass
    raise ValueError(f"path escapes allowed roots: {path}")


def guard_tree(root: Path, roots: list[Path], project_root: Path,
               reject_symlinks: bool = False) -> None:
    ensure_within_roots(root, roots, project_root)
    if not root.is_dir():
        return
    for current, dirs, files in os.walk(root, followlinks=False):
        current_path = Path(current)
        for name in [*dirs, *files]:
            path = current_path / name
            if path.is_symlink():
                if reject_symlinks:
                    raise ValueError(f"symlink is not allowed in read tree: {path}")
                ensure_within_roots(path, roots, project_root)
                if path.is_dir():
                    dirs.remove(name)
