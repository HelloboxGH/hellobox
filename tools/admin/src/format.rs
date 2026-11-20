use chrono::{DateTime, Utc};

pub fn percent(part: u64, whole: u64) -> String {
    if whole == 0 {
        "–".into()
    } else {
        format!("{:.1}%", part as f64 * 100.0 / whole as f64)
    }
}

pub fn ratio(part: u64, whole: u64) -> f64 {
    if whole == 0 {
        0.0
    } else {
        (part as f64 / whole as f64).clamp(0.0, 1.0)
    }
}

pub fn number(value: u64) -> String {
    let digits = value.to_string();
    let mut out = String::new();
    for (i, ch) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

pub fn bytes(value: f64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut size = value.max(0.0);
    let mut unit = 0;
    while size >= 1024.0 && unit < UNITS.len() - 1 {
        size /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{size:.0} B")
    } else {
        format!("{size:.1} {}", UNITS[unit])
    }
}

pub fn money(value: f64) -> String {
    format!("${}", number(value.round() as u64))
}

fn parse(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|at| at.with_timezone(&Utc))
}

pub fn date(value: &str) -> String {
    parse(value)
        .map(|at| at.format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| value.to_string())
}

pub fn date_time(value: &str) -> String {
    parse(value)
        .map(|at| at.format("%Y-%m-%d %H:%M UTC").to_string())
        .unwrap_or_else(|| value.to_string())
}

pub fn ago(value: Option<&str>) -> String {
    let Some(at) = value.and_then(parse) else {
        return "never".into();
    };
    let minutes = (Utc::now() - at).num_minutes().max(0);
    match minutes {
        0 => "just now".into(),
        1..=59 => format!("{minutes}m ago"),
        60..=1439 => format!("{}h ago", minutes / 60),
        _ => format!("{}d ago", minutes / 1440),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_numbers_and_sizes() {
        assert_eq!(number(1_234_567), "1,234,567");
        assert_eq!(number(12), "12");
        assert_eq!(percent(1, 3), "33.3%");
        assert_eq!(percent(1, 0), "–");
        assert_eq!(bytes(1536.0), "1.5 KB");
        assert_eq!(bytes(10.0), "10 B");
        assert_eq!(money(1234.56), "$1,235");
    }

    #[test]
    fn formats_dates() {
        assert_eq!(date("2026-11-07T10:20:30.000Z"), "2026-11-07");
        assert_eq!(
            date_time("2026-11-07T10:20:30.000Z"),
            "2026-11-07 10:20 UTC"
        );
        assert_eq!(ago(None), "never");
    }
}
