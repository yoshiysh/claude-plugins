use std::path::{Path, PathBuf};

pub fn clean_markdown_fences(content: &str) -> String {
    let trimmed = content.trim();
    let lines: Vec<&str> = trimmed.lines().collect();
    if lines.len() >= 2 && lines[0].starts_with("```") && lines[lines.len() - 1].starts_with("```") {
        lines[1..lines.len() - 1].join("\n").trim().to_string()
    } else {
        trimmed.to_string()
    }
}

pub fn format_target(target: Option<&str>) -> Option<String> {
    target.map(|t| {
        let p = Path::new(t);
        if p.is_file() {
            if let Ok(content) = std::fs::read_to_string(p) {
                return format!("File: {}\n```\n{}\n```", t, content);
            }
        }
        t.to_string()
    })
}

pub fn resolve_api_key(explicit_key: Option<&str>) -> String {
    if let Some(k) = explicit_key {
        if !k.trim().is_empty() {
            return k.trim().to_string();
        }
    }

    if let Ok(env_key) = std::env::var("STRATA_API_KEY") {
        if !env_key.trim().is_empty() {
            return env_key.trim().to_string();
        }
    }

    if let Some(home) = dirs_fallback() {
        let config_file = home.join(".config").join("strata").join("api_key");
        if let Ok(key) = std::fs::read_to_string(config_file) {
            let key = key.trim();
            if !key.is_empty() {
                return key.to_string();
            }
        }
    }

    String::new()
}

fn dirs_fallback() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}
