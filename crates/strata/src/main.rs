use clap::Parser;
use std::path::Path;
use std::process::Command;

use strata::cli::{Cli, Commands, RunArgs};
use strata::context::execute_optimized;
use strata::diagnose::{run_diagnose, run_health, DiagnoseOptions, HealthOptions};
use strata::guidelines::{collect_guidelines, resolve_workspace_root};
use strata::mcp;
use strata::personas::find_persona;
use strata::syntax::verify_syntax;
use strata::utils::{clean_markdown_fences, format_target, resolve_api_key};

fn run_worker(args: RunArgs) -> Result<(), String> {
    let role = args
        .role
        .as_deref()
        .ok_or_else(|| "--role <role> is required".to_string())?;
    let goal = args
        .goal
        .as_deref()
        .ok_or_else(|| "--goal <goal> is required".to_string())?;

    let persona = find_persona(role).ok_or_else(|| {
        format!(
            "Unknown role '{}'. Available: test-gen, test-review, code-gen, code-review, doc-gen, doc-review",
            role
        )
    })?;

    // Load contexts
    let mut loaded_contexts = Vec::new();
    for ctx_spec in &args.contexts {
        let p = Path::new(ctx_spec);
        if p.is_file() {
            if let Ok(c) = std::fs::read_to_string(p) {
                loaded_contexts.push(format!("File: {}\n```\n{}\n```", ctx_spec, c));
                continue;
            }
        }
        loaded_contexts.push(ctx_spec.clone());
    }

    // Git diff
    let mut git_diff: Option<String> = None;
    if args.diff {
        if let Ok(output) = Command::new("git").args(["diff", "HEAD"]).output() {
            if output.status.success() {
                let diff_text = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !diff_text.is_empty() {
                    git_diff = Some(diff_text);
                }
            }
        }
    }

    // Collect guidelines unless disabled
    let guidelines = if !args.no_guidelines {
        if let Some(root) = resolve_workspace_root(args.workspace.as_deref(), args.target.as_deref()) {
            collect_guidelines(&root, role, &args.extra_guidelines)
        } else {
            Vec::new()
        }
    } else {
        Vec::new()
    };

    // Target formatting
    let target_formatted = format_target(args.target.as_deref());
    let api_key = resolve_api_key(args.api_key.as_deref());
    let temp = args.temperature.unwrap_or(persona.temperature);

    let raw_output = execute_optimized(
        &args.api_base,
        &api_key,
        &args.model,
        persona,
        goal,
        target_formatted.as_deref(),
        &loaded_contexts,
        git_diff.as_deref(),
        &guidelines,
        temp,
        args.max_tokens,
        args.reasoning_effort.as_deref(),
        !args.no_optimize,
    )?;

    let final_output = if !persona.is_review {
        clean_markdown_fences(&raw_output)
    } else {
        raw_output.trim().to_string()
    };

    if let Some(out_path) = args.output.as_deref() {
        let p = Path::new(out_path);
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::write(p, &final_output)
            .map_err(|e| format!("Failed to write output to {}: {}", out_path, e))?;

        if !args.no_syntax_check {
            let (valid, msg) = verify_syntax(p);
            if valid {
                eprintln!("[Strata Worker] Saved to {} ({})", out_path, msg);
            } else {
                eprintln!("[Strata Worker] WARNING: {}", msg);
            }
        } else {
            eprintln!("[Strata Worker] Saved to {}", out_path);
        }
    } else {
        println!("{}", final_output);
    }

    Ok(())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let program_name = args
        .first()
        .and_then(|p| Path::new(p).file_name())
        .and_then(|n| n.to_str())
        .unwrap_or("");

    // Legacy / compat detection: if invoked as `strata-mcp`, directly run MCP
    if program_name == "strata-mcp" {
        if let Err(e) = mcp::run_mcp_server() {
            eprintln!("Strata MCP Server error: {}", e);
            std::process::exit(1);
        }
        return;
    }

    // If invoked as `strata-worker`, strip program name and run as RunArgs
    if program_name == "strata-worker" {
        let mut forward_args = vec!["strata".to_string(), "run".to_string()];
        forward_args.extend(args.into_iter().skip(1));
        match Cli::try_parse_from(forward_args) {
            Ok(cli) => {
                if let Some(Commands::Run(run_args)) = cli.command {
                    if let Err(e) = run_worker(run_args) {
                        eprintln!("Error: {}", e);
                        std::process::exit(1);
                    }
                    return;
                }
            }
            Err(e) => {
                e.exit();
            }
        }
    }

    // Normal CLI parse
    let cli = Cli::parse();

    match cli.command {
        Some(Commands::Run(run_args)) => {
            if let Err(e) = run_worker(run_args) {
                eprintln!("Error: {}", e);
                std::process::exit(1);
            }
        }
        Some(Commands::Mcp(_mcp_args)) => {
            if let Err(e) = mcp::run_mcp_server() {
                eprintln!("Strata MCP Server error: {}", e);
                std::process::exit(1);
            }
        }
        Some(Commands::Diagnose(diag_args)) => {
            let api_key = resolve_api_key(diag_args.api_key.as_deref());
            let opts = DiagnoseOptions {
                api_base: &diag_args.api_base,
                api_key: &api_key,
                model: &diag_args.model,
                host: &diag_args.host,
                include_logs: !diag_args.no_logs,
                ai_analyze: diag_args.ai,
                json_output: diag_args.json,
            };
            match run_diagnose(&opts) {
                Ok(report) => println!("{}", report),
                Err(e) => {
                    eprintln!("Diagnose error: {}", e);
                    std::process::exit(1);
                }
            }
        }
        Some(Commands::Health(health_args)) => {
            let api_key = resolve_api_key(health_args.api_key.as_deref());
            let opts = HealthOptions {
                api_base: &health_args.api_base,
                api_key: &api_key,
                model: &health_args.model,
                warmup: health_args.warmup,
                strict: health_args.strict,
                json_output: health_args.json,
            };
            match run_health(&opts) {
                Ok((_report, text, exit_code)) => {
                    println!("{}", text);
                    if exit_code != 0 {
                        std::process::exit(exit_code);
                    }
                }
                Err(e) => {
                    eprintln!("Health check error: {}", e);
                    std::process::exit(1);
                }
            }
        }
        None => {
            if let Some(run_args) = cli.direct_run {
                if run_args.role.is_some() || run_args.goal.is_some() {
                    if let Err(e) = run_worker(run_args) {
                        eprintln!("Error: {}", e);
                        std::process::exit(1);
                    }
                    return;
                }
            }
            eprintln!("Usage: strata <COMMAND> [OPTIONS]\n\nCommands:\n  run   Execute worker persona\n  mcp   Start stdio MCP server\n\nRun 'strata --help' for details.");
            std::process::exit(1);
        }
    }
}
