use serde::Serialize;
use serde_json::Value;
use std::io::Write;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::client::call_strata_api;
use crate::context::execute_optimized;
use crate::personas::find_persona;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum ApiHealth {
    Loaded(String),
    Unloaded,
    AuthError,
    Unreachable(String),
}

#[derive(Debug, Clone, Serialize)]
pub struct DiagnosticFinding {
    pub severity: String,
    pub code: String,
    pub summary: String,
    pub evidence: String,
    pub remediation: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiagnosticReport {
    pub api_health: ApiHealth,
    pub engine_silence_s: Option<i64>,
    pub idle_unload_s: Option<i64>,
    pub findings: Vec<DiagnosticFinding>,
    pub server_log_tail: String,
    pub engine_log_tail: String,
    pub system_snapshot: String,
    pub ai_analysis: Option<String>,
}

pub struct DiagnoseOptions<'a> {
    pub api_base: &'a str,
    pub api_key: &'a str,
    pub model: &'a str,
    pub host: &'a str,
    pub include_logs: bool,
    pub ai_analyze: bool,
    pub json_output: bool,
}

const COLLECT_SCRIPT: &str = r#"
echo "===PROCESSES==="
ps aux | grep -E 'strata|llama' | grep -v grep || true
echo "===SYSCTL_LSBLK_LINGER==="
sysctl -n vm.swappiness 2>/dev/null | sed 's/^/swappiness=/' || true
lsblk -d -o NAME,ROTA,SIZE 2>/dev/null || true
loginctl show-user "$(whoami)" -p Linger 2>/dev/null || true
free -h 2>/dev/null | head -n 3 || true
echo "===DMESG==="
dmesg -T 2>/dev/null | tail -n 20 || true
echo "===SERVER_LOG==="
tail -n 60 "$HOME/.local/state/strata/runtime"/launch-*.server.log 2>/dev/null || true
echo "===ENGINE_LOG==="
tail -n 60 "$HOME/.local/state/strata/launch"/*.engine.log 2>/dev/null || true
echo "===HOST_LOG==="
tail -n 20 "$HOME/.local/state/strata/runtime"/*.host.log 2>/dev/null || true
"#;

pub fn check_api_health(api_base: &str, api_key: &str) -> (ApiHealth, Option<i64>, Option<i64>) {
    let clean_base = api_base.trim_end_matches('/');
    let models_url = format!("{}/models", clean_base);

    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(3))
        .timeout_read(Duration::from_secs(5))
        .build();

    let mut req = agent.get(&models_url);
    if !api_key.is_empty() {
        req = req.set("Authorization", &format!("Bearer {}", api_key));
    }

    let api_health = match req.call() {
        Ok(resp) => match resp.into_json::<Value>() {
            Ok(val) => {
                let data = val.get("data").and_then(|d| d.as_array());
                if let Some(arr) = data {
                    if let Some(loaded_model) = arr.iter().find(|m| {
                        m.get("status")
                            .and_then(|s| s.get("value"))
                            .and_then(|v| v.as_str())
                            == Some("loaded")
                    }) {
                        let id = loaded_model
                            .get("id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown")
                            .to_string();
                        ApiHealth::Loaded(id)
                    } else if let Some(first) = arr.first() {
                        let id = first
                            .get("id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown")
                            .to_string();
                        ApiHealth::Loaded(id)
                    } else {
                        ApiHealth::Unloaded
                    }
                } else {
                    ApiHealth::Unloaded
                }
            }
            Err(e) => ApiHealth::Unreachable(format!("Invalid JSON from /models: {}", e)),
        },
        Err(ureq::Error::Status(401, _)) | Err(ureq::Error::Status(403, _)) => {
            ApiHealth::AuthError
        }
        Err(e) => ApiHealth::Unreachable(e.to_string()),
    };

    let base_host = clean_base.split("/v1").next().unwrap_or(clean_base);
    let config_url = format!("{}/config", base_host);
    let mut cfg_req = agent.get(&config_url);
    if !api_key.is_empty() {
        cfg_req = cfg_req.set("Authorization", &format!("Bearer {}", api_key));
    }

    let mut engine_silence_s = None;
    let mut idle_unload_s = None;
    if let Ok(resp) = cfg_req.call() {
        if let Ok(val) = resp.into_json::<Value>() {
            if let Some(keys) = val.get("keys").and_then(|k| k.as_array()) {
                for item in keys {
                    match item.get("key").and_then(|k| k.as_str()) {
                        Some("engine_silence_s") => {
                            engine_silence_s = item.get("value").and_then(|v| v.as_i64());
                        }
                        Some("idle_unload_s") => {
                            idle_unload_s = item.get("value").and_then(|v| v.as_i64());
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    (api_health, engine_silence_s, idle_unload_s)
}

fn collect_host_snapshot(host: &str) -> Result<String, String> {
    if host.eq_ignore_ascii_case("local") {
        let mut child = Command::new("bash")
            .arg("-s")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to spawn local bash: {}", e))?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(COLLECT_SCRIPT.as_bytes())
                .map_err(|e| format!("Failed to write diagnostic script to local bash: {}", e))?;
        }
        let out = child
            .wait_with_output()
            .map_err(|e| format!("Failed to wait for local bash: {}", e))?;
        return Ok(String::from_utf8_lossy(&out.stdout).to_string());
    }

    if host.is_empty() || host.starts_with('-') || host.chars().any(|c| c.is_whitespace()) {
        return Err(format!("Invalid SSH host name: {:?}", host));
    }

    let mut child = Command::new("ssh")
        .args([
            "-o",
            "ConnectTimeout=5",
            "-o",
            "BatchMode=yes",
            "-o",
            "IgnoreUnknown=WarnWeakCrypto",
            "-o",
            "WarnWeakCrypto=no",
            "--",
            host,
            "wsl bash -s",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn ssh to {}: {}", host, e))?;

    let write_err = if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(COLLECT_SCRIPT.as_bytes()).err()
    } else {
        None
    };
    let out = child
        .wait_with_output()
        .map_err(|e| format!("Failed to read ssh diagnostics from {}: {}", host, e))?;

    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    if stdout.trim().is_empty() && (!out.status.success() || write_err.is_some()) {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let detail = if !stderr.is_empty() {
            stderr
        } else {
            write_err.map(|e| e.to_string()).unwrap_or_default()
        };
        return Err(format!("SSH diagnostic collection failed: {}", detail));
    }
    Ok(stdout)
}

fn extract_section(raw: &str, marker: &str) -> String {
    let tag = format!("==={}===", marker);
    let mut collecting = false;
    let mut lines = Vec::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed == tag {
            collecting = true;
            continue;
        }
        if collecting && trimmed.starts_with("===") && trimmed.ends_with("===") {
            break;
        }
        if collecting {
            lines.push(line);
        }
    }
    lines.join("\n").trim().to_string()
}

pub fn analyze_diagnostics(
    api_health: &ApiHealth,
    engine_silence_s: Option<i64>,
    idle_unload_s: Option<i64>,
    raw_snapshot: &str,
) -> (Vec<DiagnosticFinding>, String, String, String) {
    let server_log = extract_section(raw_snapshot, "SERVER_LOG");
    let engine_log = extract_section(raw_snapshot, "ENGINE_LOG");
    let dmesg = extract_section(raw_snapshot, "DMESG");
    let sys_info = extract_section(raw_snapshot, "SYSCTL_LSBLK_LINGER");
    let procs = extract_section(raw_snapshot, "PROCESSES");
    let host_log = extract_section(raw_snapshot, "HOST_LOG");

    let mut findings = Vec::new();

    match api_health {
        ApiHealth::Unreachable(err) => findings.push(DiagnosticFinding {
            severity: "CRITICAL".to_string(),
            code: "API_UNREACHABLE".to_string(),
            summary: "Strata API エンドポイントに接続できません（SSH トンネル切断・ゾンビ化、またはサーバー停止）。".to_string(),
            evidence: err.clone(),
            remediation: "tools/claude-strata --stop-tunnel && tools/claude-strata --start-server".to_string(),
        }),
        ApiHealth::AuthError => findings.push(DiagnosticFinding {
            severity: "CRITICAL".to_string(),
            code: "API_AUTH_ERROR".to_string(),
            summary: "API キーが一致しないか未設定です（HTTP 401/403）。".to_string(),
            evidence: "GET /v1/models returned authentication error".to_string(),
            remediation: "tools/claude-strata --sync-key".to_string(),
        }),
        ApiHealth::Unloaded => findings.push(DiagnosticFinding {
            severity: "WARNING".to_string(),
            code: "MODEL_UNLOADED".to_string(),
            summary: "モデルは現在アンロード状態です（次のリクエスト時に自動ロードされますが 15〜135 秒待ちます）。".to_string(),
            evidence: "GET /v1/models returned empty data: []".to_string(),
            remediation: "常駐させる場合は idle_unload_s=0 で起動: tools/claude-strata --restart-server".to_string(),
        }),
        ApiHealth::Loaded(_) => {}
    }

    // 1. Engine silence kill / exit code -9
    let silence_lines: Vec<&str> = server_log
        .lines()
        .filter(|l| {
            l.contains("the engine said nothing for")
                || l.contains("exit code -9")
                || l.contains("the engine had stopped")
        })
        .collect();
    if !silence_lines.is_empty() {
        findings.push(DiagnosticFinding {
            severity: "CRITICAL".to_string(),
            code: "ENGINE_SILENCE_OR_SIGKILL".to_string(),
            summary: "プリフィル中の無応答監視（engine_silence_s）または SIGKILL (exit code -9) によりエンジンが強制終了されました。".to_string(),
            evidence: silence_lines.into_iter().rev().take(3).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n"),
            remediation: "engine_silence_s=0 を親プロセスへ反映するためサーバーを再起動してください: tools/claude-strata --restart-server".to_string(),
        });
    }

    // 2. OOM killer in dmesg
    let oom_lines: Vec<&str> = dmesg
        .lines()
        .filter(|l| l.contains("Out of memory") || l.contains("Killed process"))
        .collect();
    if !oom_lines.is_empty() {
        findings.push(DiagnosticFinding {
            severity: "CRITICAL".to_string(),
            code: "OOM_KILLER".to_string(),
            summary: "Linux カーネルの OOM Killer がプロセスを強制終了しました。".to_string(),
            evidence: oom_lines.join("\n"),
            remediation: "コンテキスト閾値を下げるか（STRATA_MAX_CONTEXT_TOKENS=1000）、WSL メモリ割り当てを確認してください。".to_string(),
        });
    }

    // 3. WSL2 drop_caches
    let drop_lines: Vec<&str> = dmesg.lines().filter(|l| l.contains("drop_caches")).collect();
    if !drop_lines.is_empty() {
        findings.push(DiagnosticFinding {
            severity: "INFO".to_string(),
            code: "WSL_DROP_CACHES".to_string(),
            summary: "WSL2 (mini_init) によるページキャッシュ破棄（drop_caches）が記録されています。直後の初回プリフィルはコールド読込で遅くなります。".to_string(),
            evidence: drop_lines.last().unwrap_or(&"").to_string(),
            remediation: ".wslconfig の pageReporting=false および Strata の Map-Reduce 蒸留（<=1200 tokens）で影響を最小化できます。".to_string(),
        });
    }

    // 4. ROTA=1 HDD misdetection
    let has_rota_1 = sys_info.lines().any(|l| {
        let parts: Vec<&str> = l.split_whitespace().collect();
        parts.len() >= 2 && parts[0].starts_with("sd") && parts[1] == "1"
    }) || engine_log.contains("is a rotational disk");
    if has_rota_1 {
        findings.push(DiagnosticFinding {
            severity: "WARNING".to_string(),
            code: "HDD_MISDETECTION_ROTA".to_string(),
            summary: "WSL2 仮想ディスクの回転フラグ (ROTA=1) により、SSD が低速な HDD (0.15 GB/s) と誤認されています。".to_string(),
            evidence: sys_info.lines().filter(|l| l.contains("sd")).collect::<Vec<_>>().join(" | "),
            remediation: "WSL2 内で /etc/udev/rules.d/60-wsl-ssd.rules により ROTA=0 を適用し、サーバーを再起動してください。".to_string(),
        });
    }

    // 5. Linger=no
    if sys_info.contains("Linger=no") {
        findings.push(DiagnosticFinding {
            severity: "WARNING".to_string(),
            code: "WSL_LINGER_DISABLED".to_string(),
            summary: "WSL2 ユーザーの Linger=no のため、SSH/WSL セッション終了時にバックグラウンドの Strata が道連れ終了する恐れがあります。".to_string(),
            evidence: "Linger=no".to_string(),
            remediation: "WSL2 内で sudo loginctl enable-linger $(whoami) を実行してください。".to_string(),
        });
    }

    // 6. Config warnings
    if let Some(s) = engine_silence_s {
        if s != 0 {
            findings.push(DiagnosticFinding {
                severity: "WARNING".to_string(),
                code: "CONFIG_SILENCE_TIMEOUT_ACTIVE".to_string(),
                summary: format!("engine_silence_s が {} 秒に設定されています（長めのプリフィルで切れる原因になります）。", s),
                evidence: format!("engine_silence_s={}", s),
                remediation: "tools/claude-strata --restart-server で engine_silence_s=0 を適用してください。".to_string(),
            });
        }
    }
    if let Some(u) = idle_unload_s {
        if u != 0 {
            findings.push(DiagnosticFinding {
                severity: "INFO".to_string(),
                code: "CONFIG_IDLE_UNLOAD_ACTIVE".to_string(),
                summary: format!("idle_unload_s が {} 秒に設定されています（アイドル後にモデル再ロードが発生します）。", u),
                evidence: format!("idle_unload_s={}", u),
                remediation: "常駐維持する場合は tools/claude-strata --idle-unload 0 --restart-server を使用してください。".to_string(),
            });
        }
    }

    // 7. Host exit
    if host_log.contains("the server ended on its own") {
        findings.push(DiagnosticFinding {
            severity: "WARNING".to_string(),
            code: "HOST_SERVER_EXITED".to_string(),
            summary: "ホストプロセスログにサーバーの自己終了が記録されています。".to_string(),
            evidence: host_log.lines().last().unwrap_or("").to_string(),
            remediation: "tools/claude-strata --start-server で再起動してください。".to_string(),
        });
    }

    let snapshot_summary = format!("### Processes\n{}\n\n### System\n{}", procs, sys_info);
    (findings, server_log, engine_log, snapshot_summary)
}

pub fn run_diagnose(opts: &DiagnoseOptions<'_>) -> Result<String, String> {
    let (api_health, engine_silence_s, idle_unload_s) =
        check_api_health(opts.api_base, opts.api_key);

    let raw_snapshot = match collect_host_snapshot(opts.host) {
        Ok(s) => s,
        Err(e) => format!("===COLLECTION_ERROR===\n{}", e),
    };

    let (findings, server_log_tail, engine_log_tail, system_snapshot) =
        analyze_diagnostics(&api_health, engine_silence_s, idle_unload_s, &raw_snapshot);

    let ai_analysis = if opts.ai_analyze {
        if let ApiHealth::Loaded(_) = api_health {
            if let Some(persona) = find_persona("code-review") {
                let diag_ctx = format!(
                    "Findings:\n{:?}\n\nServer Log Tail:\n{}\n\nEngine Log Tail:\n{}",
                    findings, server_log_tail, engine_log_tail
                );
                execute_optimized(
                    opts.api_base,
                    opts.api_key,
                    opts.model,
                    persona,
                    "Diagnose the root cause of any errors, timeouts, or performance degradation in these Strata logs in Japanese.",
                    None,
                    &[diag_ctx],
                    None,
                    &[],
                    0.1,
                    512,
                    Some("low"),
                    true,
                )
                .ok()
            } else {
                None
            }
        } else {
            Some("AI 分析スキップ: モデルがロードされていないか到達不能なため、決定論的診断のみを実行しました。".to_string())
        }
    } else {
        None
    };

    let report = DiagnosticReport {
        api_health: api_health.clone(),
        engine_silence_s,
        idle_unload_s,
        findings,
        server_log_tail: if opts.include_logs {
            server_log_tail
        } else {
            String::new()
        },
        engine_log_tail: if opts.include_logs {
            engine_log_tail
        } else {
            String::new()
        },
        system_snapshot,
        ai_analysis,
    };

    if opts.json_output {
        return serde_json::to_string_pretty(&report)
            .map_err(|e| format!("Failed to serialize diagnostic report: {}", e));
    }

    let mut out = String::new();
    out.push_str("# Strata Self-Diagnostics Report\n\n");
    out.push_str(&format!("- **Host**: `{}`\n", opts.host));
    out.push_str(&format!("- **API Health**: `{:?}`\n", report.api_health));
    out.push_str(&format!(
        "- **Config**: `engine_silence_s={}`, `idle_unload_s={}`\n\n",
        report
            .engine_silence_s
            .map(|v| v.to_string())
            .unwrap_or_else(|| "unknown".to_string()),
        report
            .idle_unload_s
            .map(|v| v.to_string())
            .unwrap_or_else(|| "unknown".to_string())
    ));

    if report.findings.is_empty() {
        out.push_str("## 診断結果\n問題は検出されませんでした。サーバーとキャッシュは健全に稼働しています。\n");
    } else {
        out.push_str("## 検出された問題・診断結果\n");
        for f in &report.findings {
            out.push_str(&format!(
                "- **[{}] `{}`**: {}\n  - **根拠**: `{}`\n  - **対処**: `{}`\n",
                f.severity,
                f.code,
                f.summary,
                f.evidence.replace('\n', " | "),
                f.remediation
            ));
        }
    }

    if let Some(ai) = &report.ai_analysis {
        out.push_str(&format!("\n## AI 詳細分析\n{}\n", ai));
    }

    if opts.include_logs {
        if !report.server_log_tail.is_empty() {
            let tail: Vec<&str> = report.server_log_tail.lines().rev().take(15).collect();
            let ordered: Vec<&str> = tail.into_iter().rev().collect();
            out.push_str(&format!(
                "\n## Server Log (最新15行)\n```\n{}\n```\n",
                ordered.join("\n")
            ));
        }
        if !report.engine_log_tail.is_empty() {
            let tail: Vec<&str> = report.engine_log_tail.lines().rev().take(15).collect();
            let ordered: Vec<&str> = tail.into_iter().rev().collect();
            out.push_str(&format!(
                "\n## Engine Log (最新15行)\n```\n{}\n```\n",
                ordered.join("\n")
            ));
        }
    }

    Ok(out)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HealthStatus {
    Healthy,
    Degraded,
    Unhealthy,
}

#[derive(Debug, Clone, Serialize)]
pub struct HealthReport {
    pub status: HealthStatus,
    pub api_health: ApiHealth,
    pub engine_silence_s: Option<i64>,
    pub idle_unload_s: Option<i64>,
    pub warnings: Vec<String>,
    pub warmup_ms: Option<u64>,
    pub elapsed_ms: u64,
    pub next_action: Option<String>,
}

pub struct HealthOptions<'a> {
    pub api_base: &'a str,
    pub api_key: &'a str,
    pub model: &'a str,
    pub warmup: bool,
    pub strict: bool,
    pub json_output: bool,
}

pub fn evaluate_health(
    api_health: &ApiHealth,
    engine_silence_s: Option<i64>,
    idle_unload_s: Option<i64>,
) -> (HealthStatus, Vec<String>, Option<String>) {
    let mut warnings = Vec::new();
    match api_health {
        ApiHealth::Unreachable(err) => {
            warnings.push(format!("Strata API unreachable: {}", err));
            return (
                HealthStatus::Unhealthy,
                warnings,
                Some("tools/claude-strata --diagnose または tools/claude-strata --stop-tunnel && tools/claude-strata --start-server".to_string()),
            );
        }
        ApiHealth::AuthError => {
            warnings.push("Strata API authentication failed (HTTP 401/403)".to_string());
            return (
                HealthStatus::Unhealthy,
                warnings,
                Some("tools/claude-strata --sync-key".to_string()),
            );
        }
        ApiHealth::Unloaded => {
            warnings.push("Model is unloaded (初回リクエストまたは --warmup で自動ロードされます)".to_string());
        }
        ApiHealth::Loaded(_) => {}
    }

    if let Some(v) = engine_silence_s {
        if v != 0 {
            warnings.push(format!("engine_silence_s={} (0 が推奨)", v));
        }
    }
    if let Some(v) = idle_unload_s {
        if v != 0 {
            warnings.push(format!("idle_unload_s={} (0 が推奨)", v));
        }
    }

    if !warnings.is_empty() {
        let next = if matches!(api_health, ApiHealth::Unloaded) {
            Some("tools/claude-strata --health --warmup または初回リクエストで自動ロード".to_string())
        } else {
            Some("tools/claude-strata --restart-server".to_string())
        };
        return (HealthStatus::Degraded, warnings, next);
    }

    (HealthStatus::Healthy, warnings, None)
}

pub fn run_health(opts: &HealthOptions) -> Result<(HealthReport, String, i32), String> {
    let start = Instant::now();
    let (api_health, engine_silence_s, idle_unload_s) = check_api_health(opts.api_base, opts.api_key);
    let (mut status, mut warnings, mut next_action) =
        evaluate_health(&api_health, engine_silence_s, idle_unload_s);

    let mut warmup_ms = None;
    if opts.warmup && status != HealthStatus::Unhealthy {
        let warm_start = Instant::now();
        match call_strata_api(
            opts.api_base,
            opts.api_key,
            opts.model,
            "Reply with OK.",
            "ping",
            0.0,
            1,
            Some("low"),
        ) {
            Ok(_) => {
                warmup_ms = Some(warm_start.elapsed().as_millis() as u64);
                // Re-check health after warmup if it was Unloaded
                if matches!(api_health, ApiHealth::Unloaded) {
                    let (re_api, _, _) = check_api_health(opts.api_base, opts.api_key);
                    let (re_status, re_warnings, re_next) =
                        evaluate_health(&re_api, engine_silence_s, idle_unload_s);
                    status = re_status;
                    warnings = re_warnings;
                    next_action = re_next;
                }
            }
            Err(e) => {
                status = HealthStatus::Unhealthy;
                warnings.push(format!("Warmup inference failed: {}", e));
                next_action = Some("tools/claude-strata --diagnose".to_string());
            }
        }
    }

    let elapsed_ms = start.elapsed().as_millis() as u64;
    let report = HealthReport {
        status: status.clone(),
        api_health,
        engine_silence_s,
        idle_unload_s,
        warnings,
        warmup_ms,
        elapsed_ms,
        next_action,
    };

    let exit_code = match report.status {
        HealthStatus::Healthy => 0,
        HealthStatus::Degraded => {
            if opts.strict {
                1
            } else {
                0
            }
        }
        HealthStatus::Unhealthy => 1,
    };

    let text = if opts.json_output {
        serde_json::to_string_pretty(&report)
            .map_err(|e| format!("Failed to serialize health report: {}", e))?
    } else {
        let label = match report.status {
            HealthStatus::Healthy => "HEALTHY",
            HealthStatus::Degraded => "DEGRADED",
            HealthStatus::Unhealthy => "UNHEALTHY",
        };
        let mut out = format!(
            "# Strata Health Check: {}\n\n- **API**: `{:?}`\n- **Config**: `engine_silence_s={}`, `idle_unload_s={}`\n- **Elapsed**: `{} ms`\n",
            label,
            report.api_health,
            report.engine_silence_s.map(|v| v.to_string()).unwrap_or_else(|| "unknown".to_string()),
            report.idle_unload_s.map(|v| v.to_string()).unwrap_or_else(|| "unknown".to_string()),
            report.elapsed_ms,
        );
        if let Some(w_ms) = report.warmup_ms {
            out.push_str(&format!("- **Warmup Inference**: `{} ms`\n", w_ms));
        }
        if !report.warnings.is_empty() {
            out.push_str("\n## Warnings\n");
            for w in &report.warnings {
                out.push_str(&format!("- {}\n", w));
            }
        }
        if let Some(next) = &report.next_action {
            out.push_str(&format!("\n- **Next Action**: `{}`\n", next));
        }
        out
    };

    Ok((report, text, exit_code))
}

pub fn preflight_intercept_with<FHealth, FWarmup>(
    force_warmup: bool,
    mut check_health_fn: FHealth,
    mut warmup_fn: FWarmup,
) -> Result<bool, String>
where
    FHealth: FnMut() -> (ApiHealth, Option<i64>, Option<i64>),
    FWarmup: FnMut() -> Result<(), String>,
{
    let (api_health, engine_silence_s, idle_unload_s) = check_health_fn();
    let (status, warnings, next_action) =
        evaluate_health(&api_health, engine_silence_s, idle_unload_s);

    if status == HealthStatus::Unhealthy {
        let hint = next_action.unwrap_or_else(|| "tools/claude-strata --diagnose".to_string());
        return Err(format!(
            "Preflight health check failed: {}. Run: {}",
            warnings.join("; "),
            hint
        ));
    }

    for w in &warnings {
        eprintln!("[Strata Preflight] Warning: {}", w);
    }

    let is_unloaded = matches!(api_health, ApiHealth::Unloaded);
    if is_unloaded || force_warmup {
        eprintln!("[Strata Preflight] Running 1-token warmup before request...");
        let start = Instant::now();
        warmup_fn()?;
        eprintln!(
            "[Strata Preflight] Warmup completed in {} ms.",
            start.elapsed().as_millis()
        );
        return Ok(true);
    }

    Ok(false)
}

/// Automatically intercepts every request with a fast (<0.1s) API health check.
/// Runs a 1-token warmup only when the model is unloaded or STRATA_PREFLIGHT_WARMUP=1 is set.
pub fn preflight_intercept(api_base: &str, api_key: &str, model: &str) -> Result<(), String> {
    if std::env::var("STRATA_PREFLIGHT").ok().as_deref() == Some("0") {
        return Ok(());
    }

    let force_warmup = std::env::var("STRATA_PREFLIGHT_WARMUP").ok().as_deref() == Some("1");

    preflight_intercept_with(
        force_warmup,
        || check_api_health(api_base, api_key),
        || {
            call_strata_api(
                api_base,
                api_key,
                model,
                "Reply with OK.",
                "ping",
                0.0,
                1,
                Some("low"),
            )
            .map(|_| ())
        },
    )?;

    Ok(())
}
