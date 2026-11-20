//! A terminal admin tool for HelloBox. It signs in through the browser and talks
//! to the web app's admin API, which only accepts the emails in ADMIN_EMAILS.

mod api;
mod auth;
mod format;
mod requests;
mod session;
mod tui;

use std::{
    io::{self, BufRead, Write},
    path::PathBuf,
    process::ExitCode,
};

use anyhow::Result;
use clap::{Parser, Subcommand};
use url::Url;

use crate::{
    api::{Api, Done, Empty, Flushed, Me, ProviderRequest, Stats, is_unauthorized},
    format::{bytes, money, number, percent},
    session::Saved,
};

#[derive(Parser)]
#[command(
    name = "hellobox-admin",
    version,
    about = "Usage stats and moderation for HelloBox, in your terminal"
)]
struct Cli {
    /// The HelloBox app to manage.
    #[arg(
        long,
        env = "HELLOBOX_URL",
        default_value = "https://hellobox.app",
        global = true
    )]
    url: String,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Open the dashboard. This is the default.
    Tui,
    /// Sign in through your browser.
    Login,
    /// End this computer's admin session.
    Logout,
    /// Show who you're signed in as.
    Whoami,
    /// Print usage stats.
    Stats {
        /// Print the raw JSON.
        #[arg(long)]
        json: bool,
    },
    /// Provider requests from "Using something else? Tell us".
    Requests {
        #[command(subcommand)]
        command: RequestsCommand,
    },
}

#[derive(Subcommand)]
enum RequestsCommand {
    /// Write every request to an HTML page, with counts per provider.
    Export {
        /// Where to write it. Defaults to provider-requests-<date>.html here.
        #[arg(long, short)]
        out: Option<PathBuf>,
        /// Open the page in your browser afterwards.
        #[arg(long)]
        open: bool,
    },
    /// Delete every request so far. Export them first.
    Flush {
        /// Skip the confirmation.
        #[arg(long)]
        yes: bool,
    },
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("error: {error:#}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<()> {
    let cli = Cli::parse();
    let base = auth::parse_base_url(&cli.url)?;
    match cli.command.unwrap_or(Command::Tui) {
        Command::Login => {
            let saved = login(&base)?;
            println!(
                "Signed in to {base} as {} until {}",
                saved.email,
                format::date_time(&saved.expires_at)
            );
        }
        Command::Logout => {
            if let Some(saved) = current(&base) {
                // The local copy goes even if the server can't be reached.
                let _ = Api::new(&base, Some(saved.token))?
                    .call::<Done>("/admin/auth/logout", &Empty {});
            }
            session::forget(&base)?;
            println!("Signed out of {base}");
        }
        Command::Whoami => {
            let me: Me = with_session(&base, |api| api.call("/admin/auth/me", &Empty {}))?;
            let until = me
                .expires_at
                .as_deref()
                .map(format::date_time)
                .unwrap_or_default();
            println!("{} on {base}, session until {until}", me.email);
        }
        Command::Stats { json } => {
            let value: serde_json::Value =
                with_session(&base, |api| api.call("/admin/stats", &Empty {}))?;
            if json {
                println!("{}", serde_json::to_string_pretty(&value)?);
            } else {
                print_stats(&serde_json::from_value(value)?);
            }
        }
        Command::Requests { command } => match command {
            RequestsCommand::Export { out, open } => {
                require_section(&base, "provider-requests")?;
                let requests: Vec<ProviderRequest> = with_session(&base, |api| {
                    api.call("/admin/provider-requests/list", &Empty {})
                })?;
                let path = out.unwrap_or_else(|| {
                    PathBuf::from(format!(
                        "provider-requests-{}.html",
                        chrono::Utc::now().format("%Y-%m-%d")
                    ))
                });
                std::fs::write(&path, requests::html(&requests, base.as_str()))?;
                println!(
                    "Wrote {} requests to {}",
                    format::number(requests.len() as u64),
                    path.display()
                );
                if open {
                    open::that(&path)?;
                }
            }
            RequestsCommand::Flush { yes } => {
                require_section(&base, "provider-requests")?;
                let requests: Vec<ProviderRequest> = with_session(&base, |api| {
                    api.call("/admin/provider-requests/list", &Empty {})
                })?;
                // Newest first, so this is the last one counted here. Anything newer stays.
                let Some(newest) = requests.first() else {
                    println!("No provider requests to flush");
                    return Ok(());
                };
                let top: Vec<String> = requests::tally(&requests)
                    .into_iter()
                    .take(5)
                    .map(|(provider, count)| format!("{provider} {count}"))
                    .collect();
                println!(
                    "{} requests on {base}: {}",
                    format::number(requests.len() as u64),
                    top.join(", ")
                );
                if !yes && !confirm("This deletes them for good. Type flush to go on: ")? {
                    println!("Nothing deleted");
                    return Ok(());
                }
                let flushed: Flushed = with_session(&base, |api| {
                    api.call(
                        "/admin/provider-requests/flush",
                        &serde_json::json!({ "through": newest.created_at }),
                    )
                })?;
                println!("Deleted {} requests", format::number(flushed.deleted));
            }
        },
        Command::Tui => {
            let saved = match current(&base) {
                Some(saved) => saved,
                None => login(&base)?,
            };
            let api = Api::new(&base, Some(saved.token))?;
            // Which screens this server has. An older server doesn't say: show everything.
            let sections = api
                .call::<Me>("/admin/auth/me", &Empty {})
                .ok()
                .and_then(|me| me.sections);
            if let tui::Outcome::SessionEnded =
                tui::run(api, saved.email, saved.expires_at, sections)?
            {
                session::forget(&base)?;
                eprintln!("Your admin session ended. Run hellobox-admin login to sign in again.");
            }
        }
    }
    Ok(())
}

/// Stops with a plain message when the server says it doesn't have a section. A server that
/// doesn't list its sections is older than the field and has everything.
fn require_section(base: &Url, section: &str) -> Result<()> {
    let me: Me = with_session(base, |api| api.call("/admin/auth/me", &Empty {}))?;
    match me.sections {
        Some(sections) if !sections.iter().any(|s| s == section) => {
            anyhow::bail!("{base} has no {section}")
        }
        _ => Ok(()),
    }
}

fn confirm(prompt: &str) -> Result<bool> {
    print!("{prompt}");
    io::stdout().flush()?;
    let mut answer = String::new();
    io::stdin().lock().read_line(&mut answer)?;
    Ok(answer.trim() == "flush")
}

fn login(base: &Url) -> Result<Saved> {
    let token = auth::login(base)?;
    let saved = Saved {
        token: token.token,
        email: token.email,
        expires_at: token.expires_at,
    };
    session::save(base, saved.clone())?;
    Ok(saved)
}

// HELLOBOX_ADMIN_TOKEN wins over the saved session, for scripts.
fn current(base: &Url) -> Option<Saved> {
    match std::env::var("HELLOBOX_ADMIN_TOKEN") {
        Ok(token) if !token.is_empty() => Some(Saved {
            token,
            email: "HELLOBOX_ADMIN_TOKEN".into(),
            expires_at: String::new(),
        }),
        _ => session::load(base),
    }
}

fn with_session<T>(base: &Url, work: impl FnOnce(&Api) -> Result<T>) -> Result<T> {
    let Some(saved) = current(base) else {
        anyhow::bail!("Not signed in to {base}. Run hellobox-admin login");
    };
    let result = work(&Api::new(base, Some(saved.token))?);
    if let Err(error) = &result
        && is_unauthorized(error)
    {
        session::forget(base)?;
        anyhow::bail!("{error}. Run hellobox-admin login");
    }
    result
}

fn print_stats(stats: &Stats) {
    let users = &stats.users;
    let spaces = &stats.workspaces;
    let row = |label: &str, value: String| println!("  {label:<26}{value}");
    println!("Users");
    row("Total", number(users.total));
    row(
        "New, 7 / 30 days",
        format!("{} / {}", number(users.new7d), number(users.new30d)),
    );
    row(
        "Active, 7 days",
        format!(
            "{} ({})",
            number(users.active7d),
            percent(users.active7d, users.total)
        ),
    );
    row(
        "Active, 30 days",
        format!(
            "{} ({})",
            number(users.active30d),
            percent(users.active30d, users.total)
        ),
    );
    row(
        "Verified email",
        format!(
            "{} ({})",
            number(users.verified),
            percent(users.verified, users.total)
        ),
    );
    row(
        "Two-factor on",
        format!(
            "{} ({})",
            number(users.two_factor),
            percent(users.two_factor, users.total)
        ),
    );
    row("Banned", number(users.banned));
    println!("Workspaces");
    row("Total", number(spaces.total));
    // Plans and revenue only come from a server with billing.
    if let Some(by_plan) = &spaces.by_plan {
        for (name, count) in [
            ("Solo", by_plan.solo),
            ("Team", by_plan.team),
            ("Business", by_plan.business),
        ] {
            row(
                name,
                format!("{} ({})", number(count), percent(count, spaces.total)),
            );
        }
    }
    if let Some(paying) = spaces.paying {
        row(
            "Paying",
            format!("{} ({})", number(paying), percent(paying, spaces.total)),
        );
    }
    if let Some(mrr) = spaces.estimated_mrr {
        row("Estimated MRR", money(mrr));
        row(
            "Past due / suspended",
            format!("{} / {}", spaces.past_due.unwrap_or(0), spaces.suspended),
        );
    } else {
        row("Suspended", spaces.suspended.to_string());
    }
    row(
        "Connected to Resend",
        format!(
            "{} ({})",
            number(spaces.connected_to_resend),
            percent(spaces.connected_to_resend, spaces.total)
        ),
    );
    println!("Mail");
    row("Messages", number(stats.mail.messages));
    row(
        "Received / sent, 30 days",
        format!(
            "{} / {}",
            number(stats.mail.inbound30d),
            number(stats.mail.outbound30d)
        ),
    );
    row("Storage", bytes(stats.mail.storage_bytes));
    row("Contacts", number(stats.mail.contacts));
    row(
        "Campaigns sent",
        format!(
            "{} to {} recipients",
            number(stats.campaigns.sent),
            number(stats.campaigns.recipients)
        ),
    );
    row("Agent connections", number(stats.agents.active_connections));
}
