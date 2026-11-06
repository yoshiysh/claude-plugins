mod durable_storage;
use durable_storage::*;
use std::{fs, io, path::PathBuf, process::Command};
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "formal-storage-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn original() -> Record {
    Record {
        run: "run-a".into(),
        job: "job-a".into(),
        matching:
            "target/model/verifier/config/evidence/property/assumptions/range/criteria/time-v1"
                .into(),
        stopped_report: "STOPPED; unresolved=job-a; user-visible report".into(),
        late_results: vec![],
    }
}
fn next() -> Record {
    let mut r = original();
    r.late_results.push("linked late result".into());
    r
}
fn ok(_: Point) -> io::Result<()> {
    Ok(())
}
#[test]
fn save_reload_append_and_matching() {
    let t = Temp::new();
    save(&t.0, &original(), ok).unwrap();
    assert_eq!(load(&t.0).unwrap(), original());
    save(&t.0, &next(), ok).unwrap();
    let r = load(&t.0).unwrap();
    assert_eq!(r, next());
    assert!(r.reusable("run-a", "job-a", &r.matching));
    for (run, job, key) in [
        ("wrong", "job-a", r.matching.as_str()),
        ("run-a", "wrong", r.matching.as_str()),
        ("run-a", "job-a", "v2"),
    ] {
        assert!(!r.reusable(run, job, key));
    }
    assert_eq!(r.stopped_report, original().stopped_report);
}
#[test]
fn failures_keep_committed_bytes() {
    for point in [
        Point::Create,
        Point::Write,
        Point::FileSync,
        Point::Rename,
        Point::DirectorySync,
    ] {
        let t = Temp::new();
        save(&t.0, &original(), ok).unwrap();
        let old = fs::read(t.0.join("record")).unwrap();
        let result = save(&t.0, &next(), |p| {
            if p == point {
                Err(io::Error::other("injected"))
            } else {
                Ok(())
            }
        });
        if point == Point::DirectorySync {
            assert!(matches!(result, Err(SaveError::CommitUncertain(_))));
            assert_eq!(load(&t.0).unwrap(), next());
        } else {
            assert!(matches!(result, Err(SaveError::BeforeCommit(_))));
            assert_eq!(fs::read(t.0.join("record")).unwrap(), old);
            assert_eq!(load(&t.0).unwrap(), original());
        }
        save(&t.0, &next(), ok).unwrap();
        assert_eq!(load(&t.0).unwrap(), next());
    }
}
#[test]
fn corruption_version_truncation_fail_closed() {
    let good = Temp::new();
    save(&good.0, &original(), ok).unwrap();
    let bytes = fs::read(good.0.join("record")).unwrap();
    let mut cases = vec![bytes[..bytes.len() - 1].to_vec(), vec![], bytes.clone()];
    cases[2][7] = 2;
    let mut corrupt = bytes.clone();
    corrupt[15] ^= 1;
    cases.push(corrupt);
    for b in cases {
        let t = Temp::new();
        fs::write(t.0.join("record"), &b).unwrap();
        assert!(load(&t.0).is_err());
        assert!(save(&t.0, &next(), ok).is_err());
        assert_eq!(fs::read(t.0.join("record")).unwrap(), b);
    }
}
#[test]
fn immutable_report_identity_and_append_only() {
    let t = Temp::new();
    save(&t.0, &next(), ok).unwrap();
    for field in 0..5 {
        let mut r = next();
        match field {
            0 => r.run.push('x'),
            1 => r.job.push('x'),
            2 => r.matching.push('x'),
            3 => r.stopped_report.push('x'),
            _ => r.late_results.clear(),
        };
        assert!(save(&t.0, &r, ok).is_err());
        assert_eq!(load(&t.0).unwrap(), next());
    }
    delete(&t.0, DeletionRequest::User).unwrap();
    assert_eq!(load(&t.0).unwrap_err().kind(), io::ErrorKind::NotFound);
}
#[test]
fn child_exit_at_boundary() {
    let Ok(root) = std::env::var("FORMAL_STORAGE_CHILD") else {
        return;
    };
    let point = std::env::var("FORMAL_STORAGE_POINT").unwrap();
    save(std::path::Path::new(&root), &next(), |p| {
        if format!("{p:?}") == point {
            std::process::exit(73)
        }
        Ok(())
    })
    .unwrap();
    panic!("child failed to exit");
}
#[test]
fn restart_recovers_prior_or_new_commit() {
    for point in [
        Point::Create,
        Point::Write,
        Point::FileSync,
        Point::Rename,
        Point::DirectorySync,
    ] {
        let t = Temp::new();
        save(&t.0, &original(), ok).unwrap();
        let s = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "child_exit_at_boundary", "--nocapture"])
            .env("FORMAL_STORAGE_CHILD", &t.0)
            .env("FORMAL_STORAGE_POINT", format!("{point:?}"))
            .status()
            .unwrap();
        assert_eq!(s.code(), Some(73));
        let r = load(&t.0).unwrap();
        assert_eq!(
            r,
            if point == Point::DirectorySync {
                next()
            } else {
                original()
            }
        );
        recover_pending(&t.0).unwrap();
        save(&t.0, &next(), ok).unwrap();
        assert_eq!(load(&t.0).unwrap(), next());
    }
}
#[test]
fn existing_directory_is_rejected_before_staging() {
    let t = Temp::new();
    fs::create_dir(t.0.join("record")).unwrap();
    assert!(save(&t.0, &original(), ok).is_err());
    assert!(t.0.join("record").is_dir());
    assert!(!t.0.join("pending").exists());
}
#[test]
fn stale_pending_and_partial_write_are_not_reused() {
    let t = Temp::new();
    save(&t.0, &original(), ok).unwrap();
    fs::write(t.0.join("pending"), b"partial bytes").unwrap();
    assert_eq!(load(&t.0).unwrap(), original());
    let err = save(&t.0, &next(), ok).unwrap_err();
    match err {
        SaveError::BeforeCommit(e) => assert_eq!(e.kind(), io::ErrorKind::AlreadyExists),
        _ => panic!("unexpected publish"),
    };
    recover_pending(&t.0).unwrap();
    save(&t.0, &next(), ok).unwrap();
    assert_eq!(load(&t.0).unwrap(), next());
}
#[test]
fn os_rename_failure_before_first_commit() {
    let t = Temp::new();
    let mut reached_rename = false;
    let err = save(&t.0, &original(), |p| {
        if p == Point::Rename {
            reached_rename = true;
            assert!(t.0.join("pending").is_file());
            assert!(!t.0.join("record").exists());
            fs::create_dir(t.0.join("record"))?;
        }
        Ok(())
    })
    .unwrap_err();
    assert!(reached_rename);
    match err {
        SaveError::BeforeCommit(e) => assert_ne!(e.kind(), io::ErrorKind::NotFound),
        _ => panic!("unexpected publish"),
    };
    assert!(t.0.join("record").is_dir());
    assert!(!t.0.join("pending").exists());
}
#[test]
fn directory_sync_error_has_uncertain_classification() {
    let t = Temp::new();
    let err = save(&t.0, &original(), |p| {
        if p == Point::DirectorySync {
            Err(io::Error::other("directory sync failed"))
        } else {
            Ok(())
        }
    })
    .unwrap_err();
    match err {
        SaveError::CommitUncertain(e) => assert_eq!(e.kind(), io::ErrorKind::Other),
        _ => panic!("wrong failure class"),
    };
    assert_eq!(load(&t.0).unwrap(), original());
}

#[test]
fn os_rename_source_disappearance_preserves_existing_record() {
    let t = Temp::new();
    save(&t.0, &original(), ok).unwrap();
    let prior_bytes = fs::read(t.0.join("record")).unwrap();
    let mut reached_rename = false;
    let err = save(&t.0, &next(), |p| {
        if p == Point::Rename {
            reached_rename = true;
            assert!(t.0.join("pending").is_file());
            fs::remove_file(t.0.join("pending"))?;
        }
        Ok(())
    })
    .unwrap_err();
    assert!(reached_rename);
    match err {
        SaveError::BeforeCommit(e) => assert_eq!(e.kind(), io::ErrorKind::NotFound),
        _ => panic!("unexpected publish"),
    }
    assert_eq!(fs::read(t.0.join("record")).unwrap(), prior_bytes);
    assert_eq!(load(&t.0).unwrap(), original());
    save(&t.0, &next(), ok).unwrap();
    assert_eq!(load(&t.0).unwrap(), next());
}
