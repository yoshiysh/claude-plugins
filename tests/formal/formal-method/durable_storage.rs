use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::Path;

const MAGIC: &[u8] = b"FMSTORE\x01";
const LIMIT: usize = 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Record {
    pub run: String,
    pub job: String,
    pub matching: String,
    pub stopped_report: String,
    pub late_results: Vec<String>,
}
impl Record {
    pub fn reusable(&self, run: &str, job: &str, matching: &str) -> bool {
        self.run == run && self.job == job && self.matching == matching
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Point {
    Create,
    Write,
    FileSync,
    Rename,
    DirectorySync,
}
#[derive(Debug)]
pub enum SaveError {
    BeforeCommit(io::Error),
    CommitUncertain(io::Error),
}
fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "invalid storage record")
}
fn hash(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf29ce484222325u64, |h, b| {
        (h ^ u64::from(*b)).wrapping_mul(0x100000001b3)
    })
}
fn encode(r: &Record) -> io::Result<Vec<u8>> {
    let fields = [&r.run, &r.job, &r.matching, &r.stopped_report];
    let mut out = MAGIC.to_vec();
    for s in fields.into_iter().chain(r.late_results.iter()) {
        let n = u32::try_from(s.len()).map_err(|_| invalid())?;
        out.extend(n.to_le_bytes());
        out.extend(s.as_bytes());
    }
    if out.len() > LIMIT {
        return Err(invalid());
    }
    out.extend(hash(&out).to_le_bytes());
    Ok(out)
}
fn decode(bytes: &[u8]) -> io::Result<Record> {
    if bytes.len() < MAGIC.len() + 8 || bytes.len() > LIMIT + 8 || !bytes.starts_with(MAGIC) {
        return Err(invalid());
    }
    let end = bytes.len() - 8;
    if hash(&bytes[..end]).to_le_bytes() != bytes[end..] {
        return Err(invalid());
    }
    let mut cursor = MAGIC.len();
    let mut fields = Vec::new();
    while cursor < end {
        let nbytes = bytes
            .get(cursor..cursor + 4)
            .filter(|_| cursor + 4 <= end)
            .ok_or_else(invalid)?;
        let n = u32::from_le_bytes(nbytes.try_into().unwrap()) as usize;
        cursor += 4;
        let next = cursor
            .checked_add(n)
            .filter(|next| *next <= end)
            .ok_or_else(invalid)?;
        fields.push(String::from_utf8(bytes[cursor..next].to_vec()).map_err(|_| invalid())?);
        cursor = next;
    }
    if fields.len() < 4 {
        return Err(invalid());
    }
    Ok(Record {
        run: fields[0].clone(),
        job: fields[1].clone(),
        matching: fields[2].clone(),
        stopped_report: fields[3].clone(),
        late_results: fields[4..].to_vec(),
    })
}
pub fn load(root: &Path) -> io::Result<Record> {
    use std::io::Read;
    let mut bytes = Vec::new();
    File::open(root.join("record"))?
        .take((LIMIT + 9) as u64)
        .read_to_end(&mut bytes)?;
    decode(&bytes)
}
pub fn save(
    root: &Path,
    next: &Record,
    mut boundary: impl FnMut(Point) -> io::Result<()>,
) -> Result<(), SaveError> {
    let before = SaveError::BeforeCommit;
    let bytes = encode(next).map_err(before)?;
    match load(root) {
        Ok(old)
            if old.run != next.run
                || old.job != next.job
                || old.matching != next.matching
                || old.stopped_report != next.stopped_report
                || !next.late_results.starts_with(&old.late_results) =>
        {
            return Err(before(invalid()))
        }
        Ok(_) => (),
        Err(e) if e.kind() == io::ErrorKind::NotFound => (),
        Err(e) => return Err(before(e)),
    }
    boundary(Point::Create).map_err(before)?;
    let temp = root.join("pending");
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(before)?;
    let staged = (|| {
        boundary(Point::Write)?;
        file.write_all(&bytes)?;
        boundary(Point::FileSync)?;
        file.sync_all()?;
        boundary(Point::Rename)?;
        fs::rename(&temp, root.join("record"))
    })();
    if let Err(e) = staged {
        let _ = fs::remove_file(&temp);
        return Err(before(e));
    }
    boundary(Point::DirectorySync)
        .and_then(|_| File::open(root)?.sync_all())
        .map_err(SaveError::CommitUncertain)
}
pub fn recover_pending(root: &Path) -> io::Result<()> {
    match fs::remove_file(root.join("pending")) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}
pub enum DeletionRequest {
    User,
}
pub fn delete(root: &Path, _: DeletionRequest) -> io::Result<()> {
    fs::remove_file(root.join("record"))?;
    File::open(root)?.sync_all()
}
