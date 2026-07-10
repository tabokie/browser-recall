use browser_recall_replay::generate_slug_from_url;
use std::io::{self, Read};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    let urls: Vec<String> = serde_json::from_str(&input)?;
    let slugs = urls
        .iter()
        .map(|url| generate_slug_from_url(url))
        .collect::<Result<Vec<_>, _>>()?;
    serde_json::to_writer(io::stdout(), &slugs)?;
    Ok(())
}
