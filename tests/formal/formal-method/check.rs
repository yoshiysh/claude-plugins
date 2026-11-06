use std::env;
use std::fs;
use std::io::{self, Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

mod extra_checks;
mod operational_checks;
mod boundary_composition;
mod storage_checks;
const IDENTITY_MODEL: &str = include_str!("identity.smt2");
const MAPPING_MODEL: &str = include_str!("mapping.smt2");
const REPORTING_MODEL: &str = include_str!("reporting.smt2");
const JOB_LEDGER: &str = include_str!("job-ledger.smt2");
const EXTRA_CHECKS: &str = include_str!("extra_checks.rs");
const REQUIREMENTS_MAP: &str = include_str!("requirements-map.json");
const BOUNDARY_CHECKS: &str = include_str!("boundary_composition.rs");
const DEADLINE: Duration = Duration::from_secs(14);
const CLEANUP_GRACE: Duration = Duration::from_secs(1);
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SolverResult {
    Sat,
    Unsat,
    Unknown,
    Timeout,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChildStatus {
    Exited(Option<i32>),
    InputFailure(Option<i32>),
    ExitedWithOpenPipes(Option<i32>),
    Deadline,
}

fn classify(status: ChildStatus, out: &str) -> SolverResult {
    match status {
        ChildStatus::Deadline => SolverResult::Timeout,
        ChildStatus::Exited(Some(0)) => match out.trim() {
            "sat" => SolverResult::Sat,
            "unsat" => SolverResult::Unsat,
            "unknown" => SolverResult::Unknown,
            "timeout" => SolverResult::Timeout,
            _ => SolverResult::Error,
        },
        ChildStatus::Exited(_)
        | ChildStatus::InputFailure(_)
        | ChildStatus::ExitedWithOpenPipes(_) => SolverResult::Error,
    }
}

const STDOUT_LIMIT: usize = 65_536;
const STDERR_LIMIT: usize = 480;

fn drain<R: Read>(mut stream: R, limit: usize) -> io::Result<String> {
    let mut captured = Vec::new();
    let mut truncated = false;
    let mut buffer = [0u8; 8192];
    loop {
        let read = stream.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        let take = read.min(limit.saturating_sub(captured.len()));
        captured.extend_from_slice(&buffer[..take]);
        truncated |= take < read;
    }
    let mut text = String::from_utf8_lossy(&captured).into_owned();
    if truncated {
        text.push_str(" [output truncated]");
    }
    Ok(text)
}

enum StreamResult {
    Input(io::Result<()>),
    Stdout(io::Result<String>),
    Stderr(io::Result<String>),
}

#[cfg(unix)]
fn stop_group(pid: u32) -> io::Result<()> {
    let status = Command::new("/bin/kill")
        .args(["-KILL", "--", &format!("-{pid}")])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::other("cannot stop solver process group"))
    }
}

#[cfg(not(unix))]
fn stop_group(_pid: u32) -> io::Result<()> {
    Err(io::Error::other("solver process supervision requires Unix"))
}

fn run_program_until(
    z3: &str,
    args: &[&str],
    formula: &str,
    deadline: Duration,
) -> io::Result<(ChildStatus, String, String)> {
    let started = Instant::now();
    let mut command = Command::new(z3);
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(not(unix))]
    return Err(io::Error::other("solver process supervision requires Unix"));
    let mut child = command.spawn()?;
    let pid = child.id();
    let mut input = child
        .stdin
        .take()
        .ok_or_else(|| io::Error::other("missing solver stdin"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("missing solver stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| io::Error::other("missing solver stderr"))?;
    let bytes = formula.as_bytes().to_vec();
    let (tx, rx) = mpsc::channel();
    let input_tx = tx.clone();
    thread::spawn(move || {
        let _ = input_tx.send(StreamResult::Input(input.write_all(&bytes)));
    });
    let stdout_tx = tx.clone();
    thread::spawn(move || {
        let _ = stdout_tx.send(StreamResult::Stdout(drain(stdout, STDOUT_LIMIT)));
    });
    thread::spawn(move || {
        let _ = tx.send(StreamResult::Stderr(drain(stderr, STDERR_LIMIT)));
    });
    let mut result = None;
    let mut input_result = None;
    let mut out_result = None;
    let mut err_result = None;
    let mut cutoff = None;
    loop {
        if result.is_none() {
            if let Some(status) = child.try_wait()? {
                result = Some(ChildStatus::Exited(status.code()));
            }
        }
        if input_result.is_some()
            && out_result.is_some()
            && err_result.is_some()
            && result.is_some()
        {
            break;
        }
        if cutoff.is_none() && started.elapsed() >= deadline {
            let previous = result;
            stop_group(pid)?;
            if previous.is_none() {
                child.wait()?;
                result = Some(ChildStatus::Deadline);
            } else if let Some(ChildStatus::Exited(code)) = previous {
                result = Some(ChildStatus::ExitedWithOpenPipes(code));
            }
            cutoff = Some(Instant::now() + CLEANUP_GRACE);
        }
        if cutoff.is_some_and(|until| Instant::now() >= until) {
            return Err(io::Error::other(
                "solver pipes remain open after process-group termination",
            ));
        }
        match rx.recv_timeout(Duration::from_millis(10)) {
            Ok(StreamResult::Input(value)) => input_result = Some(value),
            Ok(StreamResult::Stdout(value)) => out_result = Some(value),
            Ok(StreamResult::Stderr(value)) => err_result = Some(value),
            Err(mpsc::RecvTimeoutError::Timeout) => (),
            Err(mpsc::RecvTimeoutError::Disconnected)
                if input_result.is_some() && out_result.is_some() && err_result.is_some() =>
            {
                thread::sleep(Duration::from_millis(10));
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(io::Error::other("solver stream workers disconnected"));
            }
        }
    }
    let input = input_result.ok_or_else(|| io::Error::other("missing input result"))?;
    let stdout = out_result.ok_or_else(|| io::Error::other("missing stdout result"))??;
    let stderr = err_result.ok_or_else(|| io::Error::other("missing stderr result"))??;
    let status = match (
        result.ok_or_else(|| io::Error::other("missing solver exit"))?,
        input,
    ) {
        (ChildStatus::Exited(Some(0)), Err(_)) => ChildStatus::InputFailure(Some(0)),
        (status, _) => status,
    };
    Ok((status, stdout, stderr))
}

fn run_program(
    z3: &str,
    args: &[&str],
    formula: &str,
) -> io::Result<(ChildStatus, String, String)> {
    run_program_until(z3, args, formula, DEADLINE)
}

fn run_solver(z3: &str, formula: &str) -> io::Result<(ChildStatus, String, String)> {
    run_program(z3, &["-in", "-T:10"], formula)
}

fn diagnostic(status: ChildStatus, stderr: &str) -> String {
    let excerpt: String = stderr
        .chars()
        .take(512)
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    format!("status={status:?}; stderr(first 512 chars)={excerpt:?}")
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Expr {
    Atom(String),
    List(Vec<Expr>),
}

impl Expr {
    fn atom(&self) -> Option<&str> {
        match self {
            Self::Atom(x) => Some(x),
            _ => None,
        }
    }
    fn list(&self) -> Option<&[Self]> {
        match self {
            Self::List(x) => Some(x),
            _ => None,
        }
    }
    fn render(&self) -> String {
        match self {
            Self::Atom(x) => x.clone(),
            Self::List(xs) => format!(
                "({})",
                xs.iter().map(Self::render).collect::<Vec<_>>().join(" ")
            ),
        }
    }
}

// This reader handles the simple symbol/numeral/list subset used by model.smt2.
// Unsupported syntax is rejected so the projection cannot silently lose semantics.
fn parse_model(text: &str) -> Result<Vec<Expr>, String> {
    let mut tokens = Vec::new();
    for line in text.lines() {
        let mut atom = String::new();
        for ch in line.split(';').next().unwrap_or("").chars() {
            if matches!(ch, '"' | '|' | '\\') {
                return Err("unsupported SMT token".into());
            }
            if ch.is_whitespace() || ch == '(' || ch == ')' {
                if !atom.is_empty() {
                    tokens.push(std::mem::take(&mut atom));
                }
                if ch == '(' || ch == ')' {
                    tokens.push(ch.to_string());
                }
            } else {
                atom.push(ch);
            }
        }
        if !atom.is_empty() {
            tokens.push(atom);
        }
    }
    fn parse(tokens: &[String], i: &mut usize) -> Result<Expr, String> {
        let token = tokens.get(*i).ok_or("unexpected end of SMT")?;
        *i += 1;
        if token == ")" {
            return Err("unexpected closing parenthesis".into());
        }
        if token != "(" {
            return Ok(Expr::Atom(token.clone()));
        }
        let mut xs = Vec::new();
        while tokens.get(*i).map(String::as_str) != Some(")") {
            if *i >= tokens.len() {
                return Err("unclosed SMT list".into());
            }
            xs.push(parse(tokens, i)?);
        }
        *i += 1;
        Ok(Expr::List(xs))
    }
    let mut i = 0;
    let mut result = Vec::new();
    while i < tokens.len() {
        result.push(parse(&tokens, &mut i)?);
    }
    Ok(result)
}

fn run_case(z3: &str, name: &str, model: &str, preconditions: &str, query: &str, expected: SolverResult) -> Result<(), String> {
 let formula=format!("{model}\n{preconditions}\n(assert {query})\n(check-sat)\n");
 let (status,output,stderr)=run_solver(z3,&formula).map_err(|e|format!("{name}: cannot execute solver: {e}"))?;
 let result=classify(status,&output); println!("{name}: {result:?} (expected {expected:?})");
 if result!=expected {return Err(format!("{name}: unexpected {result:?}; {}; no verification pass",diagnostic(status,&stderr)));}
 Ok(())
}
fn ensure_prd_fresh() -> Result<(), String> {
    let root = Path::new("docs/requirements/formal-method.md");
    let text = fs::read_to_string(root).map_err(|e| format!("cannot read PRD: {e}"))?;
    let expected = fs::read_to_string("tests/formal/formal-method/PRD.sha256")
        .map_err(|e| format!("cannot read PRD fingerprint: {e}"))?;
    let digest = Command::new("shasum")
        .args(["-a", "256", "docs/requirements/formal-method.md"])
        .output()
        .map_err(|e| format!("cannot compute PRD fingerprint: {e}"))?;
    let expected = expected.trim();
    if expected.len() != 64 || !expected.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("invalid PRD fingerprint".into());
    }
    let output = String::from_utf8_lossy(&digest.stdout);
    if !digest.status.success() || output.split_whitespace().next() != Some(expected) {
        return Err(
            "PRD has changed; reassess model correspondence before updating its fingerprint".into(),
        );
    }
    for id in [
        "PR-FORMALMETHOD-003",
        "PR-FORMALMETHOD-004",
        "PR-FORMALMETHOD-005",
        "PR-FORMALMETHOD-007",
        "PR-FORMALMETHOD-008",
        "PR-FORMALMETHOD-009",
        "PR-FORMALMETHOD-010",
        "PR-FORMALMETHOD-011",
        "PR-FORMALMETHOD-012",
        "PR-FORMALMETHOD-013",
        "PR-FORMALMETHOD-014",
        "PR-FORMALMETHOD-015",
    ] {
        if !text.contains(&format!("#### {id} ")) {
            return Err(format!(
                "PRD no longer contains {id}; re-evaluate the model"
            ));
        }
    }
    Ok(())
}

fn fingerprint(path: &str, embedded: Option<&str>) -> Result<String, String> {
    if let Some(expected) = embedded {
        let current = fs::read_to_string(path).map_err(|e| format!("cannot read {path}: {e}"))?;
        if current != expected {
            return Err(format!(
                "{path} changed after compilation; recompile before checking"
            ));
        }
    }
    let result = Command::new("shasum")
        .args(["-a", "256", path])
        .output()
        .map_err(|e| format!("cannot fingerprint {path}: {e}"))?;
    let output = String::from_utf8_lossy(&result.stdout);
    let digest = output.split_whitespace().next().unwrap_or("");
    if !result.status.success()
        || digest.len() != 64
        || !digest.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(format!("cannot obtain valid fingerprint for {path}"));
    }
    Ok(digest.to_owned())
}

fn resolve_solver(name: &str) -> Result<String, String> {
    let path = Path::new(name);
    let candidate = if path.components().count() > 1 || path.is_absolute() {
        path.to_path_buf()
    } else {
        env::split_paths(&env::var_os("PATH").ok_or("PATH is not set")?)
            .map(|dir| dir.join(name))
            .find(|p| p.is_file())
            .ok_or_else(|| format!("solver not found: {name}"))?
    };
    let resolved =
        fs::canonicalize(candidate).map_err(|e| format!("cannot resolve solver: {e}"))?;
    resolved
        .to_str()
        .map(str::to_owned)
        .ok_or_else(|| "solver path is not UTF-8".into())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
 ensure_prd_fresh().map_err(io::Error::other)?;
 let z3=resolve_solver(&env::var("Z3").unwrap_or_else(|_|"z3".into())).map_err(io::Error::other)?;
 let dependencies=[("docs/requirements/formal-method.md",None),("tests/formal/formal-method/PRD.sha256",None),
 ("tests/formal/formal-method/identity.smt2",Some(IDENTITY_MODEL)),
("tests/formal/formal-method/mapping.smt2",Some(MAPPING_MODEL)),
("tests/formal/formal-method/reporting.smt2",Some(REPORTING_MODEL)),
("tests/formal/formal-method/job-ledger.smt2",Some(JOB_LEDGER)),
("tests/formal/formal-method/extra_checks.rs",Some(EXTRA_CHECKS)),
 ("tests/formal/formal-method/requirements-map.json",Some(REQUIREMENTS_MAP)),
("tests/formal/formal-method/operational.smt2",Some(operational_checks::MODEL)),
("tests/formal/formal-method/operational_checks.rs",Some(operational_checks::SOURCE)),
("tests/formal/formal-method/boundary_composition.rs",Some(BOUNDARY_CHECKS)),
("tests/formal/formal-method/boundary-contracts.smt2",Some(boundary_composition::CONTRACTS)),
("tests/formal/formal-method/storage.smt2",Some(storage_checks::MODEL)),
("tests/formal/formal-method/storage_checks.rs",Some(storage_checks::SOURCE)),
("tests/formal/formal-method/durable_storage.rs",Some(storage_checks::IMPLEMENTATION)),
("tests/formal/formal-method/durable_storage_tests.rs",Some(storage_checks::TESTS)),
 (z3.as_str(),None)];
 let before=dependencies.iter().map(|(p,e)|fingerprint(p,*e)).collect::<Result<Vec<_>,_>>().map_err(io::Error::other)?;
 let (status,version,stderr)=run_program(&z3,&["-version"],"")?;
 if status!=ChildStatus::Exited(Some(0))||!version.starts_with("Z3 version ")||version.lines().count()!=1 {return Err(io::Error::other(format!("cannot verify solver version: {}",diagnostic(status,&stderr))).into());}
 println!("solver: {}",version.trim());
 for ((path,_),sha) in dependencies.iter().zip(&before){println!("dependency sha256: {path} {sha}");}
 extra_checks::run_all(&z3).map_err(io::Error::other)?;
 operational_checks::run(&z3).map_err(io::Error::other)?;
 boundary_composition::run(&z3).map_err(io::Error::other)?;
 storage_checks::run(&z3).map_err(io::Error::other)?;
 ensure_prd_fresh().map_err(io::Error::other)?;
 for ((path,embedded),expected) in dependencies.iter().zip(&before){if fingerprint(path,*embedded).map_err(io::Error::other)?!=*expected{return Err(io::Error::other(format!("dependency changed during verification: {path}")).into());}}
 let (s,v,e)=run_program(&z3,&["-version"],"")?;
 if s!=ChildStatus::Exited(Some(0))||v!=version{return Err(io::Error::other(format!("solver version changed or could not be verified: {}",diagnostic(s,&e))).into());}
 println!("dependency fingerprints match after verification");
 println!("PASS: current scoped canonical models; whole PRD and concrete refinement remain unverified"); Ok(())
}
#[cfg(test)]
mod tests {
 use super::{classify,diagnostic,run_program,run_program_until,ChildStatus,SolverResult};
    #[cfg(unix)]
    #[test]
    fn process_failure_preserves_exit_code_and_bounded_diagnostics() {
        let (status, out, stderr) = run_program(
            "/bin/sh",
            &[
                "-c",
                "printf 'timeout\\n'; printf 'solver diagnostic\\n' >&2; exit 42",
            ],
            "",
        )
        .expect("start fake solver");
        assert_eq!(status, ChildStatus::Exited(Some(42)));
        assert_eq!(classify(status, &out), SolverResult::Error);
        assert!(diagnostic(status, &stderr).contains("42"));
        assert!(diagnostic(status, &stderr).contains("solver diagnostic"));
        let long = "x".repeat(1000);
        assert!(!diagnostic(status, &long).contains(&long));

        let (status, out, _) =
            run_program("/bin/sh", &["-c", "printf 'unknown\\n'"], "").expect("start fake solver");
        assert_eq!(classify(status, &out), SolverResult::Unknown);
    }

    #[cfg(unix)]
    #[test]
    fn drains_large_outputs_and_preserves_failure_and_timeout() {
        use std::time::Duration;
        let (status, out, stderr) = run_program_until(
            "/bin/sh",
            &[
                "-c",
                "head -c 1048576 /dev/zero; head -c 1048576 /dev/zero >&2; exit 42",
            ],
            "",
            Duration::from_secs(5),
        )
        .expect("run noisy fake solver");
        assert_eq!(status, ChildStatus::Exited(Some(42)));
        assert_eq!(classify(status, &out), SolverResult::Error);
        assert!(stderr.contains("[output truncated]"));
        assert!(out.contains("[output truncated]"));
        let (status, out, _) = run_program_until(
            "/bin/sh",
            &["-c", "exec sleep 2"],
            "",
            Duration::from_millis(30),
        )
        .expect("run stalled fake solver");
        assert_eq!(status, ChildStatus::Deadline);
        assert_eq!(classify(status, &out), SolverResult::Timeout);
    }

    #[cfg(unix)]
    #[test]
    fn success_with_unwritten_solver_input_is_not_accepted() {
        use std::time::Duration;
        let input = "x".repeat(1_048_576);
        let (status, output, _) = run_program_until(
            "/bin/sh",
            &["-c", "printf 'sat\\n'; exit 0"],
            &input,
            Duration::from_secs(3),
        )
        .expect("run short fake solver");
        assert_eq!(status, ChildStatus::InputFailure(Some(0)));
        assert_eq!(classify(status, &output), SolverResult::Error);
    }

    #[cfg(unix)]
    #[test]
    fn exited_parent_with_inherited_pipes_is_stopped_with_its_process_group() {
        use std::process::{Command, Stdio};
        use std::time::{Duration, Instant};
        let start = Instant::now();
        let (status, out, stderr) = run_program_until(
            "/bin/sh",
            &["-c", "sleep 18 & echo $! >&2; exit 42"],
            "",
            Duration::from_millis(100),
        )
        .expect("stop orphan process group");
        assert_eq!(status, ChildStatus::ExitedWithOpenPipes(Some(42)));
        assert_eq!(classify(status, &out), SolverResult::Error);
        assert!(start.elapsed() < Duration::from_secs(3));
        let pid = stderr.trim().parse::<u32>().expect("sleep pid");
        let kill_check = Command::new("/bin/kill")
            .args(["-0", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("kill check");
        if kill_check.success() {
            let ps = Command::new("/bin/ps")
                .args(["-p", &pid.to_string(), "-o", "stat="])
                .output()
                .expect("ps check");
            assert!(
                String::from_utf8_lossy(&ps.stdout).trim().starts_with('Z'),
                "orphan still running"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn solver_success_with_open_descendant_pipes_is_not_accepted() {
        use std::time::Duration;
        let (status, out, _) = run_program_until(
            "/bin/sh",
            &["-c", "sleep 18 & echo sat; exit 0"],
            "",
            Duration::from_millis(100),
        )
        .expect("stop orphan process group");
        assert_eq!(status, ChildStatus::ExitedWithOpenPipes(Some(0)));
        assert_eq!(classify(status, &out), SolverResult::Error);
    }

    #[test]
    fn distinguishes_solver_outcomes_and_rejects_unexpected_output() {
        assert_eq!(
            classify(ChildStatus::Exited(Some(0)), "sat\n"),
            SolverResult::Sat
        );
        assert_eq!(
            classify(ChildStatus::Exited(Some(0)), "unsat\n"),
            SolverResult::Unsat
        );
        assert_eq!(
            classify(ChildStatus::Exited(Some(0)), "unknown\n"),
            SolverResult::Unknown
        );
        assert_eq!(
            classify(ChildStatus::Exited(Some(1)), "timeout\n"),
            SolverResult::Error
        );
        assert_eq!(
            classify(ChildStatus::Exited(Some(1)), "sat\n"),
            SolverResult::Error
        );
        assert_eq!(
            classify(ChildStatus::Exited(Some(0)), "(error \"bad input\")\nsat\n"),
            SolverResult::Error
        );
        assert_eq!(classify(ChildStatus::Deadline, ""), SolverResult::Timeout);
        assert_eq!(
            classify(ChildStatus::Exited(Some(0)), "timeout\n"),
            SolverResult::Timeout
        );
        assert_eq!(
            classify(ChildStatus::Exited(Some(0)), ""),
            SolverResult::Error
        );
    }
}
