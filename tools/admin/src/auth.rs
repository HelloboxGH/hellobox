use std::{
    io::{ErrorKind, Read, Write},
    net::{TcpListener, TcpStream},
    thread,
    time::{Duration, Instant},
};

use anyhow::{Result, bail};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::RngCore;
use serde_json::json;
use sha2::{Digest, Sha256};
use url::Url;

use crate::api::{Api, TokenResponse};

const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);

fn random_base64(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    rand::rng().fill_bytes(&mut buffer);
    URL_SAFE_NO_PAD.encode(buffer)
}

/// PKCE S256 (RFC 7636). Only the process holding the verifier can trade the code.
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

pub fn challenge_for(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

pub fn pkce() -> Pkce {
    let verifier = random_base64(32);
    let challenge = challenge_for(&verifier);
    Pkce {
        verifier,
        challenge,
    }
}

/// The same code the browser shows, so you can tell it's your own sign-in.
pub fn confirmation_code(challenge: &str) -> String {
    let hex: String = Sha256::digest(challenge.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let short = hex[..8].to_uppercase();
    format!("{}-{}", &short[..4], &short[4..])
}

/// Admin traffic carries a token, so it goes over HTTPS unless it stays on this computer.
pub fn parse_base_url(input: &str) -> Result<Url> {
    let mut url = Url::parse(input.trim())?;
    let local = matches!(
        url.host_str(),
        Some("127.0.0.1" | "localhost" | "[::1]" | "::1")
    );
    match url.scheme() {
        "https" => {}
        "http" if local => {}
        "http" => bail!(
            "Use https:// for {}. Plain http only works for this computer",
            url.host_str().unwrap_or("")
        ),
        other => bail!("Unsupported URL scheme {other}"),
    }
    url.set_query(None);
    url.set_fragment(None);
    if !url.path().ends_with('/') {
        let path = format!("{}/", url.path());
        url.set_path(&path);
    }
    Ok(url)
}

#[derive(Debug, PartialEq)]
pub enum Callback {
    Code(String),
    Denied(String),
    WrongState,
    Other,
}

/// Reads the request line the browser sends to the loopback listener.
pub fn parse_callback(request_line: &str, expected_state: &str) -> Callback {
    let mut parts = request_line.split_whitespace();
    let (Some("GET"), Some(target)) = (parts.next(), parts.next()) else {
        return Callback::Other;
    };
    let Ok(url) = Url::parse(&format!("http://127.0.0.1{target}")) else {
        return Callback::Other;
    };
    if url.path() != "/callback" {
        return Callback::Other;
    }
    let param = |name: &str| {
        url.query_pairs()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
    };
    if param("state").as_deref() != Some(expected_state) {
        return Callback::WrongState;
    }
    if let Some(error) = param("error") {
        return Callback::Denied(error);
    }
    match param("code") {
        Some(code) if !code.is_empty() => Callback::Code(code),
        _ => Callback::Denied("The browser didn't send a code".into()),
    }
}

fn respond(stream: &mut TcpStream, status: &str, message: &str) {
    let body = format!(
        "<!doctype html><meta charset=utf-8><title>HelloBox admin</title>\
         <body style=\"font-family:system-ui;display:grid;place-items:center;height:90vh;color:#222\">\
         <p>{message}</p></body>"
    );
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n{body}",
        body.len()
    );
}

fn read_request_line(stream: &mut TcpStream) -> Option<String> {
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    let mut buffer = [0u8; 8192];
    let mut read = 0;
    while read < buffer.len() {
        let n = stream.read(&mut buffer[read..]).ok()?;
        if n == 0 {
            break;
        }
        read += n;
        if buffer[..read].windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
    }
    let head = String::from_utf8_lossy(&buffer[..read]);
    head.lines().next().map(str::to_owned)
}

fn wait_for_code(listener: &TcpListener, state: &str) -> Result<String> {
    listener.set_nonblocking(true)?;
    let deadline = Instant::now() + LOGIN_TIMEOUT;
    while Instant::now() < deadline {
        match listener.accept() {
            Ok((mut stream, _)) => {
                stream.set_nonblocking(false)?;
                let Some(line) = read_request_line(&mut stream) else {
                    continue;
                };
                match parse_callback(&line, state) {
                    Callback::Code(code) => {
                        respond(
                            &mut stream,
                            "200 OK",
                            "You're signed in. Go back to your terminal.",
                        );
                        return Ok(code);
                    }
                    Callback::Denied(reason) => {
                        respond(&mut stream, "400 Bad Request", "Sign-in was cancelled.");
                        bail!("Sign-in was cancelled: {reason}");
                    }
                    // Anything else on this port isn't ours to act on, so keep waiting.
                    Callback::WrongState => respond(
                        &mut stream,
                        "400 Bad Request",
                        "This sign-in doesn't match.",
                    ),
                    Callback::Other => respond(&mut stream, "404 Not Found", "Not found."),
                }
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(100))
            }
            Err(error) => return Err(error.into()),
        }
    }
    bail!("Timed out waiting for the browser. Run hellobox-admin login again")
}

/// Signs in through the browser, where you're already signed in to HelloBox.
pub fn login(base: &Url) -> Result<TokenResponse> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    let pkce = pkce();
    let state = random_base64(24);
    let mut url = base.join("admin/cli")?;
    url.query_pairs_mut()
        .append_pair("port", &port.to_string())
        .append_pair("state", &state)
        .append_pair("challenge", &pkce.challenge);

    println!("Approve this sign-in in your browser.");
    println!("Confirmation code: {}", confirmation_code(&pkce.challenge));
    println!("If the browser doesn't open, go to:\n  {url}\n");
    if open::that(url.as_str()).is_err() {
        println!("Couldn't open a browser. Open the link above yourself.");
    }

    let code = wait_for_code(&listener, &state)?;
    Api::new(base, None)?.call(
        "/admin/auth/token",
        &json!({ "code": code, "verifier": pkce.verifier }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn challenge_matches_rfc_7636() {
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(
            challenge_for(verifier),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn confirmation_code_matches_the_server() {
        // The web app's confirmationCode() gives the same for this challenge.
        assert_eq!(
            confirmation_code("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"),
            "0D29-9B1E"
        );
    }

    #[test]
    fn pkce_values_are_valid() {
        let pair = pkce();
        assert_eq!(pair.verifier.len(), 43);
        assert_eq!(pair.challenge, challenge_for(&pair.verifier));
        assert_ne!(pkce().verifier, pair.verifier);
    }

    #[test]
    fn base_url_needs_https_unless_local() {
        assert_eq!(
            parse_base_url("https://hellobox.app").unwrap().as_str(),
            "https://hellobox.app/"
        );
        assert_eq!(
            parse_base_url("http://127.0.0.1:3010").unwrap().as_str(),
            "http://127.0.0.1:3010/"
        );
        assert!(parse_base_url("http://localhost:3010/").is_ok());
        assert!(parse_base_url("http://hellobox.app").is_err());
        assert!(parse_base_url("ftp://hellobox.app").is_err());
        assert_eq!(
            parse_base_url("https://x.test/app?a=1#b").unwrap().as_str(),
            "https://x.test/app/"
        );
    }

    #[test]
    fn callback_takes_the_code_only_with_the_right_state() {
        let state = "abcdefghijklmnopqrstuvwxyz012345";
        assert_eq!(
            parse_callback(
                &format!("GET /callback?code=xyz&state={state} HTTP/1.1"),
                state
            ),
            Callback::Code("xyz".into())
        );
        assert_eq!(
            parse_callback("GET /callback?code=xyz&state=other HTTP/1.1", state),
            Callback::WrongState
        );
        assert_eq!(
            parse_callback("GET /favicon.ico HTTP/1.1", state),
            Callback::Other
        );
        assert_eq!(
            parse_callback("POST /callback?code=x HTTP/1.1", state),
            Callback::Other
        );
        assert!(matches!(
            parse_callback(
                &format!("GET /callback?error=denied&state={state} HTTP/1.1"),
                state
            ),
            Callback::Denied(_)
        ));
    }
}
