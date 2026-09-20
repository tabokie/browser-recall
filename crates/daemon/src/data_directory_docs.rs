use crate::storage::write_atomic;
use std::{io, path::Path};
use tokio::fs;

const START: &str = "<!-- Browser Recall managed instructions: begin -->";
const END: &str = "<!-- Browser Recall managed instructions: end -->";

pub(crate) async fn install(root: &Path, device_id: &str) -> io::Result<()> {
    let path = root.join("AGENTS.md");
    let old = match fs::read_to_string(&path).await {
        Ok(value) => value,
        Err(error) if error.kind() == io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error),
    };
    let body = include_str!("../resources/data-AGENTS.md").replace("{{DEVICE_ID}}", device_id);
    let section = format!("{START}\n{body}\n{END}");
    let updated = match (old.find(START), old.find(END)) {
        (Some(start), Some(end)) if start < end => {
            format!("{}{}{}", &old[..start], section, &old[end + END.len()..])
        }
        (None, None) if old.is_empty() => format!("{section}\n"),
        (None, None) => format!("{}\n\n{section}\n", old.trim_end()),
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "AGENTS.md has incomplete Browser Recall managed markers",
            ))
        }
    };
    if updated != old {
        write_atomic(path, updated.as_bytes()).await?;
    }
    Ok(())
}
