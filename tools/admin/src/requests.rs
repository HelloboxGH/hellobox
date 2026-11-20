//! Provider requests: export them to an HTML page, and clear them once read.

use std::collections::BTreeMap;

use crate::{api::ProviderRequest, format};

/// The same provider typed differently ("SendGrid", " sendgrid") counts once.
fn key(provider: &str) -> String {
    provider.trim().to_lowercase()
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Providers by how often they were asked for, most first, with the spelling seen first.
pub fn tally(requests: &[ProviderRequest]) -> Vec<(String, u64)> {
    let mut counts: BTreeMap<String, (String, u64)> = BTreeMap::new();
    for request in requests {
        counts
            .entry(key(&request.provider))
            .or_insert_with(|| (request.provider.trim().to_string(), 0))
            .1 += 1;
    }
    let mut tally: Vec<_> = counts.into_values().collect();
    tally.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    tally
}

/// A standalone page: counts per provider, then every request.
pub fn html(requests: &[ProviderRequest], base: &str) -> String {
    let tally = tally(requests);
    let top = tally.first().map(|(_, count)| *count).unwrap_or(1).max(1);
    let bars: String = tally
        .iter()
        .map(|(provider, count)| {
            format!(
                "<tr><td>{}</td><td class=bar><span style=\"width:{}%\"></span></td><td class=n>{count}</td></tr>",
                escape(provider),
                count * 100 / top
            )
        })
        .collect();
    let rows: String = requests
        .iter()
        .map(|request| {
            let receives = match request.receives_mail {
                Some(true) => "Yes",
                Some(false) => "No",
                None => "Not sure",
            };
            format!(
                "<tr><td class=when>{}</td><td><b>{}</b></td><td>{receives}</td><td>{}</td><td>{}</td><td>{}</td><td class=details>{}</td></tr>",
                escape(&format::date_time(&request.created_at)),
                escape(request.provider.trim()),
                escape(request.email.as_deref().unwrap_or("–")),
                escape(request.workspace.as_deref().unwrap_or("–")),
                escape(&request.source),
                escape(request.details.as_deref().unwrap_or("")),
            )
        })
        .collect();
    let exported = chrono::Utc::now().format("%Y-%m-%d %H:%M UTC");
    format!(
        r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Provider requests</title>
<style>
  body {{ font: 15px/1.5 system-ui, sans-serif; color: #1c1c22; background: #f5f6fa; margin: 0; padding: 40px 24px; }}
  main {{ max-width: 1100px; margin: 0 auto; }}
  h1 {{ font-size: 28px; margin: 0; }} h2 {{ font-size: 18px; margin: 36px 0 12px; }}
  .meta {{ color: #6b6b78; margin: 4px 0 0; }}
  .card {{ background: #fff; border: 1px solid #e4e5ec; border-radius: 14px; padding: 8px 16px; overflow-x: auto; }}
  table {{ width: 100%; border-collapse: collapse; }}
  td, th {{ text-align: left; padding: 9px 10px; border-bottom: 1px solid #eef0f4; vertical-align: top; }}
  tr:last-child td {{ border-bottom: 0; }}
  th {{ font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #6b6b78; font-weight: 600; }}
  .bar {{ width: 60%; }} .bar span {{ display: block; height: 10px; border-radius: 99px; background: #4f7fe0; min-width: 4px; margin-top: 7px; }}
  .n {{ text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }}
  .when {{ white-space: nowrap; color: #6b6b78; font-variant-numeric: tabular-nums; }}
  .details {{ min-width: 260px; white-space: pre-wrap; }}
</style></head>
<body><main>
<h1>Provider requests</h1>
<p class="meta">{total} from {base}, exported {exported}</p>
<h2>Most asked for</h2>
<div class="card"><table>{bars}</table></div>
<h2>Every request</h2>
<div class="card"><table>
<tr><th>When</th><th>Provider</th><th>Receives mail</th><th>Email</th><th>Workspace</th><th>From</th><th>Details</th></tr>
{rows}
</table></div>
</main></body></html>
"#,
        total = format::number(requests.len() as u64),
        base = escape(base),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(provider: &str) -> ProviderRequest {
        ProviderRequest {
            provider: provider.into(),
            details: Some("<script>alert(1)</script>".into()),
            receives_mail: None,
            email: None,
            source: "landing".into(),
            workspace: None,
            created_at: "2026-11-12T10:00:00.000Z".into(),
        }
    }

    #[test]
    fn tally_merges_spellings_and_sorts_by_count() {
        let requests = [request("SendGrid"), request(" sendgrid "), request("Brevo")];
        assert_eq!(
            tally(&requests),
            vec![("SendGrid".into(), 2), ("Brevo".into(), 1)]
        );
    }

    #[test]
    fn html_escapes_what_people_typed() {
        let page = html(&[request("A&B")], "https://hellobox.app");
        assert!(page.contains("A&amp;B"));
        assert!(!page.contains("<script>alert"));
    }
}
