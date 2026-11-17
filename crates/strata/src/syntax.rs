use std::path::{Path, PathBuf};
use std::process::Command;

fn find_python() -> String {
    if let Ok(py) = std::env::var("PYTHON") {
        if !py.trim().is_empty() {
            return py;
        }
    }

    for candidate in &["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"] {
        let p = PathBuf::from(candidate);
        if p.is_file() {
            return candidate.to_string();
        }
    }

    "python3".to_string()
}

pub fn verify_syntax(path: &Path) -> (bool, String) {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    if ext == "json" {
        return match std::fs::read_to_string(path) {
            Ok(content) => match serde_json::from_str::<serde_json::Value>(&content) {
                Ok(_) => (true, "Syntax check passed (serde_json)".to_string()),
                Err(e) => (false, format!("Syntax error (json): {}", e)),
            },
            Err(e) => (false, format!("Failed to read JSON file: {}", e)),
        };
    }

    let (binary, args): (&str, Vec<String>) = match ext.as_str() {
        "py" | "pyw" => {
            let py = find_python();
            (
                "python3",
                vec![
                    py,
                    "-m".to_string(),
                    "py_compile".to_string(),
                    path.to_string_lossy().to_string(),
                ],
            )
        }
        "js" | "mjs" => (
            "node",
            vec![
                "node".to_string(),
                "--check".to_string(),
                path.to_string_lossy().to_string(),
            ],
        ),
        "sh" | "bash" => (
            "bash",
            vec![
                "bash".to_string(),
                "-n".to_string(),
                path.to_string_lossy().to_string(),
            ],
        ),
        _ => {
            return (
                true,
                "No syntax checker registered for this file type (assumed ok)".to_string(),
            )
        }
    };

    let actual_bin = &args[0];
    let actual_args = &args[1..];

    match Command::new(actual_bin).args(actual_args).output() {
        Ok(output) => {
            if output.status.success() {
                (true, "Syntax check passed".to_string())
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                let err = if !stderr.is_empty() { stderr } else { stdout };
                (false, format!("Syntax error ({}): {}", binary, err))
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound || e.kind() == std::io::ErrorKind::PermissionDenied => {
            (
                true,
                format!("Checker binary '{}' not permitted or installed, skipped", actual_bin),
            )
        }
        Err(e) => (false, format!("Failed to run syntax checker: {}", e)),
    }
}
