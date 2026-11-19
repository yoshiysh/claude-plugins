use serde_json::Value;

use crate::client::call_strata_api;
use crate::diagnose::preflight_intercept;
use crate::personas::{build_user_prompt, Persona};

pub const DEFAULT_MAX_CONTEXT_TOKENS: usize = 1200;
pub const DEFAULT_CHUNK_TOKENS: usize = 1050;

const DISTILL_SYSTEM_PROMPT: &str = r#"You are a high-precision context distiller.
Extract ONLY the facts, types, function signatures, constraints, configuration values, and potential failure modes from the provided chunk that are strictly relevant to the Goal.
Rules:
1. Output a dense, concise Markdown bullet list (max 15 bullets).
2. Preserve exact symbol names, file paths, numbers, and error conditions.
3. Omit boilerplate, formatting commentary, and conversational filler."#;

const REDUCE_SYSTEM_PROMPT: &str = r#"You are a specification synthesizer.
Merge and deduplicate the provided distilled notes into a single, ultra-compact specification memo relevant to the Goal.
Rules:
1. Keep exact symbol names, file paths, constraints, and error conditions.
2. Eliminate redundancy while preserving every distinct technical fact.
3. Output ONLY a concise Markdown bullet list."#;

pub const REVIEW_MAP_SYSTEM_PROMPT: &str = r#"You are Stage 1 (Local Audit) of a 2-stage code/document reviewer.
Inspect ONLY this chunk and extract two concise lists relevant to the Goal:
1. Local Suspects: concrete bugs, edge-case failures, error-swallowing, or injection/resource risks with exact symbol/line and failing input.
2. Public Contracts: function signatures, CLI/API flags, error types, and external calls needed for cross-chunk verification.
Rules:
- Omit style/linting nitpicks and generic textbook advice unrelated to actual defects.
- Output at most 12 compact bullets."#;

pub const REVIEW_REDUCE_SYSTEM_PROMPT: &str = r#"You are merging Stage 1 code/document review notes across chunks.
Preserve every symbol name, file/line reference, failing input, and public contract from Local Suspects and Public Contracts.
Rules:
1. Merge duplicate findings and keep exact identifiers, error types, and call contracts intact.
2. Do NOT convert review suspects into generic specification prose or drop evidence.
3. Output ONLY a concise Markdown bullet list."#;

pub const REVIEW_GLOBAL_STAGE_INSTRUCTIONS: &str = r#"
[Stage 2: Global Audit & False-Positive Filter]
The context above was produced by Stage 1 local chunk audits. Now synthesize the final review across all chunks:
1. Reject false positives or generic advice that conflict with the actual runtime context (e.g., local CLI tools calling localhost endpoints, or unreachable theoretical overflows).
2. Deduplicate overlapping findings and highlight cross-chunk contract mismatches if any.
3. Rank remaining confirmed issues by severity; if no real defects remain, state that no major defects were found."#;

#[inline]
pub fn tokens_from_counts(ascii_bytes: usize, non_ascii_chars: usize) -> usize {
    ascii_bytes.div_ceil(4) + non_ascii_chars
}

/// Estimate token count (~4 ASCII bytes per token, 1 char per token for non-ASCII).
pub fn estimate_tokens(text: &str) -> usize {
    let mut ascii_bytes = 0usize;
    let mut non_ascii_chars = 0usize;
    for ch in text.chars() {
        if ch.is_ascii() {
            ascii_bytes += 1;
        } else {
            non_ascii_chars += 1;
        }
    }
    tokens_from_counts(ascii_bytes, non_ascii_chars)
}

/// Automatically minify JSON content (either full-text JSON or fenced JSON blocks inside Markdown)
/// without altering semantics. Invalid JSON is left untouched.
pub fn minify_json_in_text(input: &str) -> String {
    let trimmed = input.trim();
    if (trimmed.starts_with('{') && trimmed.ends_with('}'))
        || (trimmed.starts_with('[') && trimmed.ends_with(']'))
    {
        if let Ok(val) = serde_json::from_str::<Value>(trimmed) {
            if let Ok(min) = serde_json::to_string(&val) {
                return min;
            }
        }
    }

    let lines: Vec<&str> = input.lines().collect();
    let mut out = Vec::with_capacity(lines.len());
    let mut i = 0;

    while i < lines.len() {
        let line = lines[i];
        let trimmed_line = line.trim();
        let prev_is_json_file = i > 0 && lines[i - 1].trim().ends_with(".json");

        if trimmed_line.starts_with("```json")
            || (trimmed_line == "```" && prev_is_json_file)
        {
            let fence_header = line;
            let mut j = i + 1;
            let mut block_lines = Vec::new();
            let mut closed = false;

            while j < lines.len() {
                if lines[j].trim().starts_with("```") {
                    closed = true;
                    break;
                }
                block_lines.push(lines[j]);
                j += 1;
            }

            if closed {
                let inner = block_lines.join("\n");
                let inner_trimmed = inner.trim();
                if let Ok(val) = serde_json::from_str::<Value>(inner_trimmed) {
                    if let Ok(min) = serde_json::to_string(&val) {
                        out.push(fence_header.to_string());
                        out.push(min);
                        out.push(lines[j].to_string());
                        i = j + 1;
                        continue;
                    }
                }
            }
        }

        out.push(line.to_string());
        i += 1;
    }

    out.join("\n")
}

fn is_top_level_definition(line: &str) -> bool {
    if line.starts_with(' ') || line.starts_with('\t') {
        return false;
    }
    const PREFIXES: &[&str] = &[
        "fn ",
        "pub fn ",
        "pub(crate) fn ",
        "async fn ",
        "pub async fn ",
        "struct ",
        "pub struct ",
        "enum ",
        "pub enum ",
        "impl ",
        "impl<",
        "trait ",
        "pub trait ",
        "mod ",
        "pub mod ",
        "def ",
        "async def ",
        "class ",
        "function ",
        "async function ",
        "export function ",
        "export async function ",
        "export class ",
        "export const ",
    ];
    PREFIXES.iter().any(|p| line.starts_with(p))
}

fn is_leading_doc_or_attr(line: &str) -> bool {
    let t = line.trim();
    t.starts_with("///")
        || t.starts_with("//!")
        || t.starts_with("#[")
        || t.starts_with('@')
        || t.starts_with("/**")
        || t.starts_with("* ")
        || t == "*/"
}

/// Group text into semantic blocks (files, diffs, markdown sections, top-level definitions)
/// so chunking avoids cutting functions or sections in half.
pub fn split_into_semantic_blocks(text: &str) -> Vec<String> {
    let mut blocks = Vec::new();
    let mut current_lines: Vec<String> = Vec::new();
    let mut in_fence = false;

    for raw_line in text.lines() {
        let trimmed = raw_line.trim();
        let is_fence_toggle = trimmed.starts_with("```");

        let is_section_boundary = trimmed.starts_with("File: ")
            || trimmed.starts_with("diff --git ")
            || (!in_fence
                && (trimmed.starts_with("## ") || trimmed.starts_with("### ")));

        let is_def_boundary = is_top_level_definition(raw_line);

        if !current_lines.is_empty() && (is_section_boundary || is_def_boundary) {
            // Keep leading doc comments / attributes attached to the definition that follows
            let mut trailing_docs = Vec::new();
            if is_def_boundary {
                while let Some(last) = current_lines.last() {
                    if is_leading_doc_or_attr(last) {
                        trailing_docs.push(current_lines.pop().unwrap());
                    } else {
                        break;
                    }
                }
                trailing_docs.reverse();
            }

            let block_text = current_lines.join("\n");
            if !block_text.trim().is_empty() {
                blocks.push(block_text);
            }
            current_lines = trailing_docs;
        }

        current_lines.push(raw_line.to_string());
        if is_fence_toggle {
            in_fence = !in_fence;
        }
    }

    let tail = current_lines.join("\n");
    if !tail.trim().is_empty() {
        blocks.push(tail);
    }

    blocks
}

fn split_oversized_block(block: &str, budget: usize) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    let mut current_tokens = 0usize;

    for line in block.lines() {
        let line_tokens = estimate_tokens(line) + 1;

        if line_tokens > budget {
            if !current.trim().is_empty() {
                chunks.push(current.trim_end().to_string());
                current.clear();
                current_tokens = 0;
            }
            let mut sub = String::new();
            let mut sub_ascii = 0usize;
            let mut sub_non_ascii = 0usize;
            for ch in line.chars() {
                let next_ascii = sub_ascii + usize::from(ch.is_ascii());
                let next_non_ascii = sub_non_ascii + usize::from(!ch.is_ascii());
                let next_tokens = tokens_from_counts(next_ascii, next_non_ascii);
                if !sub.is_empty() && next_tokens > budget {
                    chunks.push(sub);
                    sub = String::new();
                    sub_ascii = 0;
                    sub_non_ascii = 0;
                }
                sub.push(ch);
                if ch.is_ascii() {
                    sub_ascii += 1;
                } else {
                    sub_non_ascii += 1;
                }
            }
            if !sub.trim().is_empty() {
                chunks.push(sub);
            }
            continue;
        }

        if current_tokens + line_tokens > budget && !current.is_empty() {
            chunks.push(current.trim_end().to_string());
            current.clear();
            current_tokens = 0;
        }

        current.push_str(line);
        current.push('\n');
        current_tokens += line_tokens;
    }

    if !current.trim().is_empty() {
        chunks.push(current.trim_end().to_string());
    }
    chunks
}

/// Split text into chunks where each chunk's estimated token count is <= `max_tokens`.
/// Prioritizes semantic boundaries (files, sections, functions/structs) to avoid splitting logic mid-body.
pub fn split_into_chunks(text: &str, max_tokens: usize) -> Vec<String> {
    if text.trim().is_empty() {
        return Vec::new();
    }
    let budget = max_tokens.max(64);
    let blocks = split_into_semantic_blocks(text);
    let mut chunks = Vec::new();
    let mut current = String::new();
    let mut current_tokens = 0usize;

    for block in blocks {
        let block_tokens = estimate_tokens(&block) + 1;

        if block_tokens > budget {
            if !current.trim().is_empty() {
                chunks.push(current.trim_end().to_string());
                current.clear();
                current_tokens = 0;
            }
            chunks.extend(split_oversized_block(&block, budget));
            continue;
        }

        if current_tokens + block_tokens > budget && !current.is_empty() {
            chunks.push(current.trim_end().to_string());
            current.clear();
            current_tokens = 0;
        }

        if !current.is_empty() {
            current.push('\n');
        }
        current.push_str(&block);
        current_tokens += block_tokens;
    }

    if !current.trim().is_empty() {
        chunks.push(current.trim_end().to_string());
    }

    chunks
}

/// Truncate text safely on UTF-8 char boundaries so its estimated tokens <= `max_tokens`.
fn truncate_to_tokens(text: &str, max_tokens: usize) -> String {
    if estimate_tokens(text) <= max_tokens {
        return text.to_string();
    }
    let mut out = String::new();
    for line in text.lines() {
        if estimate_tokens(&out) + estimate_tokens(line) + 1 > max_tokens {
            break;
        }
        out.push_str(line);
        out.push('\n');
    }
    if out.is_empty() {
        for ch in text.chars() {
            if estimate_tokens(&out) + 1 >= max_tokens {
                break;
            }
            out.push(ch);
        }
    }
    out.trim_end().to_string()
}

/// Run Map-Reduce distillation if the minified context exceeds `max_tokens`.
pub fn distill_context_with<F>(
    goal: &str,
    raw_context: &str,
    max_tokens: usize,
    chunk_tokens: usize,
    call_fn: F,
) -> Result<(String, bool), String>
where
    F: FnMut(&str, &str) -> Result<String, String>,
{
    distill_context_with_prompt(
        goal,
        raw_context,
        max_tokens,
        chunk_tokens,
        DISTILL_SYSTEM_PROMPT,
        call_fn,
    )
}

pub fn distill_context_with_prompt<F>(
    goal: &str,
    raw_context: &str,
    max_tokens: usize,
    chunk_tokens: usize,
    map_system_prompt: &str,
    call_fn: F,
) -> Result<(String, bool), String>
where
    F: FnMut(&str, &str) -> Result<String, String>,
{
    distill_context_with_prompts(
        goal,
        raw_context,
        max_tokens,
        chunk_tokens,
        map_system_prompt,
        REDUCE_SYSTEM_PROMPT,
        call_fn,
    )
}

pub fn distill_context_with_prompts<F>(
    goal: &str,
    raw_context: &str,
    max_tokens: usize,
    chunk_tokens: usize,
    map_system_prompt: &str,
    reduce_system_prompt: &str,
    mut call_fn: F,
) -> Result<(String, bool), String>
where
    F: FnMut(&str, &str) -> Result<String, String>,
{
    let minified = minify_json_in_text(raw_context);
    let est = estimate_tokens(&minified);

    if est <= max_tokens {
        return Ok((minified, false));
    }

    let chunks = split_into_chunks(&minified, chunk_tokens);
    let total = chunks.len();
    eprintln!(
        "[Strata Optimizer] Context (~{} tokens) exceeds {} tokens; running Map-Reduce across {} chunks (<= {} tokens/chunk)...",
        est, max_tokens, total, chunk_tokens
    );

    // Map phase: distill each chunk serially
    let mut notes = Vec::with_capacity(total);
    for (idx, chunk) in chunks.into_iter().enumerate() {
        let map_prompt = format!(
            "## Goal\n{}\n\n## Chunk {}/{}\n{}",
            goal,
            idx + 1,
            total,
            chunk
        );
        let note = call_fn(map_system_prompt, &map_prompt)?;
        notes.push(format!("### Distilled Part {}/{}\n{}", idx + 1, total, note.trim()));
    }

    let mut combined = notes.join("\n\n");

    // Reduce phase: recursively merge notes if combined output still exceeds max_tokens
    for round in 0..2 {
        if estimate_tokens(&combined) <= max_tokens {
            break;
        }
        let reduce_chunks = split_into_chunks(&combined, chunk_tokens);
        if reduce_chunks.len() <= 1 && round > 0 {
            break;
        }
        eprintln!(
            "[Strata Optimizer] Reduce round {}: compressing {} note groups...",
            round + 1,
            reduce_chunks.len()
        );
        let mut reduced_parts = Vec::with_capacity(reduce_chunks.len());
        for (idx, r_chunk) in reduce_chunks.iter().enumerate() {
            let reduce_prompt = format!(
                "## Goal\n{}\n\n## Notes Group {}/{}\n{}",
                goal,
                idx + 1,
                reduce_chunks.len(),
                r_chunk
            );
            let merged = call_fn(reduce_system_prompt, &reduce_prompt)?;
            reduced_parts.push(merged.trim().to_string());
        }
        combined = reduced_parts.join("\n\n");
    }

    if estimate_tokens(&combined) > max_tokens {
        let before = estimate_tokens(&combined);
        let notice = "\n\n[TRUNCATED: distilled context exceeded token budget and trailing notes were omitted]";
        let notice_tokens = estimate_tokens(notice);
        let kept = truncate_to_tokens(&combined, max_tokens.saturating_sub(notice_tokens));
        eprintln!(
            "[Strata Optimizer] WARNING: distilled output (~{} tokens) exceeded budget ({} tokens) and was truncated.",
            before, max_tokens
        );
        combined = format!("{}{}", kept, notice);
    }

    Ok((combined, true))
}

fn env_usize(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|&v| v > 0)
        .unwrap_or(default)
}

/// Prepare final prompt with JSON minification and Map-Reduce distillation.
/// Preserves raw `target`, `contexts`, and `diff` verbatim whenever they fit within `max_ctx_tokens`,
/// distilling oversized `guidelines` separately so small targets are never degraded.
pub fn prepare_optimized_prompt_with<F>(
    goal: &str,
    target: Option<&str>,
    contexts: &[String],
    diff: Option<&str>,
    guidelines: &[(String, String)],
    max_ctx_tokens: usize,
    chunk_tokens: usize,
    optimize: bool,
    call_fn: F,
) -> Result<String, String>
where
    F: FnMut(&str, &str) -> Result<String, String>,
{
    prepare_optimized_prompt_for_role_with(
        goal,
        target,
        contexts,
        diff,
        guidelines,
        max_ctx_tokens,
        chunk_tokens,
        optimize,
        false,
        call_fn,
    )
    .map(|(prompt, _)| prompt)
}

#[allow(clippy::too_many_arguments)]
pub fn prepare_optimized_prompt_for_role_with<F>(
    goal: &str,
    target: Option<&str>,
    contexts: &[String],
    diff: Option<&str>,
    guidelines: &[(String, String)],
    max_ctx_tokens: usize,
    chunk_tokens: usize,
    optimize: bool,
    is_review: bool,
    mut call_fn: F,
) -> Result<(String, bool), String>
where
    F: FnMut(&str, &str) -> Result<String, String>,
{
    if !optimize {
        return Ok((build_user_prompt(goal, target, contexts, diff, guidelines), false));
    }

    let min_target = target.map(minify_json_in_text);
    let min_contexts: Vec<String> = contexts.iter().map(|c| minify_json_in_text(c)).collect();
    let min_diff = diff.map(minify_json_in_text);

    // Measure the exact prompt that build_user_prompt would send
    let full_prompt = build_user_prompt(
        goal,
        min_target.as_deref(),
        &min_contexts,
        min_diff.as_deref(),
        guidelines,
    );
    if estimate_tokens(&full_prompt) <= max_ctx_tokens {
        return Ok((full_prompt, false));
    }

    // Check if user inputs (goal + target + contexts + diff) fit without guidelines
    let user_only_prompt = build_user_prompt(
        goal,
        min_target.as_deref(),
        &min_contexts,
        min_diff.as_deref(),
        &[],
    );
    let user_only_tokens = estimate_tokens(&user_only_prompt);

    if user_only_tokens <= max_ctx_tokens {
        // Keep target/contexts/diff verbatim; compress guidelines into remaining budget
        let remaining_budget = max_ctx_tokens.saturating_sub(user_only_tokens);
        if remaining_budget < 120 || guidelines.is_empty() {
            if !guidelines.is_empty() {
                eprintln!(
                    "[Strata Optimizer] Skipping guidelines (~{} tokens remaining < 120) to preserve verbatim target/diff.",
                    remaining_budget
                );
            }
            return Ok((user_only_prompt, false));
        }

        let raw_guidelines: String = guidelines
            .iter()
            .map(|(name, content)| format!("### Guideline: {}\n{}", name, content))
            .collect::<Vec<_>>()
            .join("\n\n");
        let (distilled_guide, _) = distill_context_with(
            goal,
            &raw_guidelines,
            remaining_budget,
            chunk_tokens,
            &mut call_fn,
        )?;
        let guide_pair = vec![("Distilled Guidelines".to_string(), distilled_guide)];
        return Ok((
            build_user_prompt(
                goal,
                min_target.as_deref(),
                &min_contexts,
                min_diff.as_deref(),
                &guide_pair,
            ),
            false,
        ));
    }

    // Both or user inputs exceed max_ctx_tokens: reserve budget for guidelines if present
    let goal_tokens = estimate_tokens(goal) + 16;
    let guide_reserve = if guidelines.is_empty() {
        0
    } else {
        350.min(max_ctx_tokens / 3)
    };
    let user_budget = max_ctx_tokens.saturating_sub(goal_tokens + guide_reserve).max(250);

    // Build user context body using build_user_prompt (with empty goal) to stay 100% consistent
    let raw_user_body = build_user_prompt(
        "",
        min_target.as_deref(),
        &min_contexts,
        min_diff.as_deref(),
        &[],
    );
    let (user_map_prompt, user_reduce_prompt) = if is_review {
        (REVIEW_MAP_SYSTEM_PROMPT, REVIEW_REDUCE_SYSTEM_PROMPT)
    } else {
        (DISTILL_SYSTEM_PROMPT, REDUCE_SYSTEM_PROMPT)
    };
    let (distilled_user, did_distill_user) = distill_context_with_prompts(
        goal,
        &raw_user_body,
        user_budget,
        chunk_tokens,
        user_map_prompt,
        user_reduce_prompt,
        &mut call_fn,
    )?;

    let distilled_guidelines = if !guidelines.is_empty() && guide_reserve >= 100 {
        let raw_guidelines: String = guidelines
            .iter()
            .map(|(name, content)| format!("### Guideline: {}\n{}", name, content))
            .collect::<Vec<_>>()
            .join("\n\n");
        let (dg, _) = distill_context_with(
            goal,
            &raw_guidelines,
            guide_reserve,
            chunk_tokens,
            &mut call_fn,
        )?;
        vec![("Distilled Guidelines".to_string(), dg)]
    } else {
        Vec::new()
    };

    Ok((
        build_user_prompt(
            goal,
            None,
            &[distilled_user],
            None,
            &distilled_guidelines,
        ),
        did_distill_user,
    ))
}

pub fn finalize_user_prompt(base: String, is_review: bool, did_distill_user: bool) -> String {
    if is_review && did_distill_user {
        format!("{}{}", base, REVIEW_GLOBAL_STAGE_INSTRUCTIONS)
    } else {
        base
    }
}

#[allow(clippy::too_many_arguments)]
pub fn execute_optimized(
    api_base: &str,
    api_key: &str,
    model: &str,
    persona: &Persona,
    goal: &str,
    target: Option<&str>,
    contexts: &[String],
    diff: Option<&str>,
    guidelines: &[(String, String)],
    temperature: f32,
    max_tokens: u32,
    reasoning_effort: Option<&str>,
    optimize: bool,
) -> Result<String, String> {
    execute_optimized_with_preflight(
        api_base,
        api_key,
        model,
        persona,
        goal,
        target,
        contexts,
        diff,
        guidelines,
        temperature,
        max_tokens,
        reasoning_effort,
        optimize,
        true,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn execute_optimized_with_preflight(
    api_base: &str,
    api_key: &str,
    model: &str,
    persona: &Persona,
    goal: &str,
    target: Option<&str>,
    contexts: &[String],
    diff: Option<&str>,
    guidelines: &[(String, String)],
    temperature: f32,
    max_tokens: u32,
    reasoning_effort: Option<&str>,
    optimize: bool,
    run_preflight: bool,
) -> Result<String, String> {
    let max_ctx_tokens = env_usize("STRATA_MAX_CONTEXT_TOKENS", DEFAULT_MAX_CONTEXT_TOKENS);
    let chunk_tokens = env_usize("STRATA_CHUNK_TOKENS", DEFAULT_CHUNK_TOKENS);

    if run_preflight {
        preflight_intercept(api_base, api_key, model)?;
    }

    let (final_user_prompt, did_distill_user) = prepare_optimized_prompt_for_role_with(
        goal,
        target,
        contexts,
        diff,
        guidelines,
        max_ctx_tokens,
        chunk_tokens,
        optimize,
        persona.is_review,
        |sys_prompt, usr_prompt| {
            call_strata_api(
                api_base,
                api_key,
                model,
                sys_prompt,
                usr_prompt,
                0.1,
                384,
                Some("low"),
            )
        },
    )?;

    let final_user_prompt = finalize_user_prompt(final_user_prompt, persona.is_review, did_distill_user);

    call_strata_api(
        api_base,
        api_key,
        model,
        persona.system_prompt,
        &final_user_prompt,
        temperature,
        max_tokens,
        reasoning_effort,
    )
}
