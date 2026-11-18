use clap::{Args, Parser, Subcommand};

#[derive(Parser, Debug)]
#[command(name = "strata")]
#[command(about = "Strata: High-speed local subagent worker and MCP server", long_about = None)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<Commands>,

    #[command(flatten)]
    pub direct_run: Option<RunArgs>,
}

#[derive(Subcommand, Debug)]
pub enum Commands {
    /// Execute specialized worker persona
    Run(RunArgs),
    /// Start stdio JSON-RPC Model Context Protocol (MCP) server
    Mcp(McpArgs),
    /// Self-diagnose Strata API health, logs, and WSL2 configuration
    Diagnose(DiagnoseArgs),
    /// Fast preflight health check for Strata API, model status, and optional warmup
    Health(HealthArgs),
}

#[derive(Args, Debug, Clone)]
pub struct RunArgs {
    /// Persona/role name (test-gen, test-review, code-gen, code-review, doc-gen, doc-review)
    #[arg(short, long)]
    pub role: Option<String>,

    /// Specific goal and acceptance criteria
    #[arg(short, long)]
    pub goal: Option<String>,

    /// Target file path or symbol name
    #[arg(short, long)]
    pub target: Option<String>,

    /// Context file path or inline text (can be repeated)
    #[arg(short, long = "context")]
    pub contexts: Vec<String>,

    /// Include current git diff as context
    #[arg(short, long)]
    pub diff: bool,

    /// Output destination file
    #[arg(short, long)]
    pub output: Option<String>,

    /// Skip deterministic syntax check when writing to file
    #[arg(long)]
    pub no_syntax_check: bool,

    /// Skip automatic loading of repository guidelines (CLAUDE.md, AGENTS.md, REVIEW.md, etc.)
    #[arg(long)]
    pub no_guidelines: bool,

    /// Skip automatic JSON minification and Map-Reduce context distillation
    #[arg(long)]
    pub no_optimize: bool,

    /// Skip automatic preflight health check and idle warmup before request
    #[arg(long)]
    pub no_preflight: bool,

    /// Additional guideline file paths to include (can be repeated)
    #[arg(long = "guidelines")]
    pub extra_guidelines: Vec<String>,

    /// Workspace root directory for discovering repository guidelines
    #[arg(long)]
    pub workspace: Option<String>,

    /// Strata API base URL
    #[arg(long, default_value = "http://127.0.0.1:8080/v1")]
    pub api_base: String,

    /// Strata API key
    #[arg(long)]
    pub api_key: Option<String>,

    /// Model name
    #[arg(long, default_value = "qwen3.8-flash-next-iq2_xs")]
    pub model: String,

    /// Maximum output tokens
    #[arg(long, default_value_t = 4096)]
    pub max_tokens: u32,

    /// Sampling temperature (default: role-dependent)
    #[arg(long)]
    pub temperature: Option<f32>,

    /// Reasoning effort level for thinking models (low, medium, high)
    #[arg(long, value_parser = ["low", "medium", "high"])]
    pub reasoning_effort: Option<String>,
}

#[derive(Args, Debug, Clone)]
pub struct McpArgs {
    /// Strata API base URL
    #[arg(long, default_value = "http://127.0.0.1:8080/v1")]
    pub api_base: String,

    /// Strata API key
    #[arg(long)]
    pub api_key: Option<String>,

    /// Model name
    #[arg(long, default_value = "qwen3.8-flash-next-iq2_xs")]
    pub model: String,
}

#[derive(Args, Debug, Clone)]
pub struct DiagnoseArgs {
    /// SSH host name where Strata WSL2 runs (use "local" for current machine)
    #[arg(long, env = "STRATA_HOST", default_value = "winbox")]
    pub host: String,

    /// Strata API base URL
    #[arg(long, env = "STRATA_BASE_URL", default_value = "http://127.0.0.1:8080/v1")]
    pub api_base: String,

    /// Strata API key
    #[arg(long)]
    pub api_key: Option<String>,

    /// Model name (for optional AI log analysis)
    #[arg(long, env = "STRATA_MODEL", default_value = "qwen3.8-flash-next-iq2_xs")]
    pub model: String,

    /// Omit log excerpts from output
    #[arg(long)]
    pub no_logs: bool,

    /// Also run AI analysis on logs if Strata is currently loaded
    #[arg(long)]
    pub ai: bool,

    /// Output diagnostic report as JSON
    #[arg(long)]
    pub json: bool,
}

#[derive(Args, Debug, Clone)]
pub struct HealthArgs {
    /// Strata API base URL
    #[arg(long, env = "STRATA_BASE_URL", default_value = "http://127.0.0.1:8080/v1")]
    pub api_base: String,

    /// Strata API key
    #[arg(long)]
    pub api_key: Option<String>,

    /// Model name (used for optional --warmup inference)
    #[arg(long, env = "STRATA_MODEL", default_value = "qwen3.8-flash-next-iq2_xs")]
    pub model: String,

    /// Run a minimal 1-token inference to measure latency (auto-loads model if unloaded, taking tens of seconds)
    #[arg(long)]
    pub warmup: bool,

    /// Treat degraded state (unloaded model or non-zero timeouts) as exit code 1
    #[arg(long)]
    pub strict: bool,

    /// Output health check report as JSON
    #[arg(long)]
    pub json: bool,
}
