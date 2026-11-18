use std::collections::HashSet;
use std::path::{Path, PathBuf};

const MAX_GUIDELINES_BYTES: usize = 65536; // 64KB safety limit

/// Find repository root by walking upwards looking for `.git`, `CLAUDE.md`, or `AGENTS.md`.
pub fn find_workspace_root(start_dir: &Path) -> Option<PathBuf> {
    let mut current = Some(start_dir);
    while let Some(dir) = current {
        if dir.join(".git").exists()
            || dir.join("CLAUDE.md").exists()
            || dir.join("AGENTS.md").exists()
        {
            return Some(dir.to_path_buf());
        }
        current = dir.parent();
    }
    None
}

/// Resolve workspace root from explicit dir, target file path, or current working directory.
pub fn resolve_workspace_root(explicit: Option<&str>, target: Option<&str>) -> Option<PathBuf> {
    if let Some(ws) = explicit {
        let p = Path::new(ws);
        if p.is_dir() {
            return find_workspace_root(p).or_else(|| Some(p.to_path_buf()));
        }
    }

    if let Some(t) = target {
        let p = Path::new(t);
        if let Some(start) = if p.is_dir() { Some(p) } else { p.parent() } {
            if start.exists() {
                if let Some(found) = find_workspace_root(start) {
                    return Some(found);
                }
            }
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        return find_workspace_root(&cwd);
    }

    None
}

/// Collect relevant guideline documents for the given role, deduplicating symlinks
/// and respecting a 64KB total size budget.
pub fn collect_guidelines(
    workspace_root: &Path,
    role: &str,
    extra_paths: &[String],
) -> Vec<(String, String)> {
    let mut candidates: Vec<&str> = vec!["CLAUDE.md", "AGENTS.md", "REVIEW.md"];

    match role {
        "code-gen" | "code-review" => {
            candidates.push("docs/guidelines/README.md");
            candidates.push("docs/guidelines/javascript.md");
        }
        "test-gen" | "test-review" => {
            candidates.push("docs/guidelines/testing.md");
            candidates.push("docs/guidelines/README.md");
        }
        "doc-gen" | "doc-review" => {
            candidates.push("docs/guidelines/documentation.md");
            candidates.push("docs/guidelines/README.md");
        }
        _ => {}
    }

    let mut seen_canonical = HashSet::new();
    let mut results = Vec::new();
    let mut total_bytes: usize = 0;

    let mut try_add = |label: String, path: &Path| {
        if !path.is_file() {
            return;
        }
        if let Ok(canon) = std::fs::canonicalize(path) {
            if !seen_canonical.insert(canon) {
                return;
            }
            if let Ok(content) = std::fs::read_to_string(path) {
                let len = content.len();
                if total_bytes + len > MAX_GUIDELINES_BYTES {
                    eprintln!(
                        "[Strata Worker] Skipping guideline '{}' ({} bytes): exceeds 64KB total guideline budget",
                        label, len
                    );
                    return;
                }
                total_bytes += len;
                results.push((label, content));
            }
        }
    };

    for rel in candidates {
        let p = workspace_root.join(rel);
        try_add(rel.to_string(), &p);
    }

    for extra in extra_paths {
        let p = Path::new(extra);
        let resolved = if p.is_absolute() {
            p.to_path_buf()
        } else {
            workspace_root.join(p)
        };
        try_add(extra.clone(), &resolved);
    }

    results
}
