use std::{fmt, time::Duration};

use anyhow::{Context, Result, anyhow};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use url::Url;

/// An error the admin API answered with. A 401 means the session has ended.
#[derive(Debug)]
pub struct ApiError {
    pub status: u16,
    pub message: String,
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for ApiError {}

pub fn is_unauthorized(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<ApiError>()
        .is_some_and(|e| e.status == 401)
}

#[derive(Deserialize)]
struct Envelope<T> {
    data: Option<T>,
    error: Option<ErrorBody>,
}

#[derive(Deserialize)]
struct ErrorBody {
    message: String,
}

pub struct Api {
    base: Url,
    token: Option<String>,
    http: Client,
}

impl Api {
    pub fn new(base: &Url, token: Option<String>) -> Result<Self> {
        let http = Client::builder()
            .user_agent(concat!("hellobox-admin/", env!("CARGO_PKG_VERSION")))
            .timeout(Duration::from_secs(30))
            // The token must never follow a redirect to another host.
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        Ok(Self {
            base: base.clone(),
            token,
            http,
        })
    }

    /// Calls one of the web app's actions, which all take and return JSON.
    pub fn call<T: DeserializeOwned>(&self, path: &str, body: &impl Serialize) -> Result<T> {
        let url = self.base.join(&format!("api/actions{path}"))?;
        let mut request = self.http.post(url).json(body);
        if let Some(token) = &self.token {
            request = request.bearer_auth(token);
        }
        let response = request
            .send()
            .with_context(|| format!("Couldn't reach {}", self.base))?;
        let status = response.status();
        let text = response.text()?;
        let envelope: Envelope<T> = serde_json::from_str(&text).map_err(|_| ApiError {
            status: status.as_u16(),
            message: format!(
                "{} answered {status} without the JSON the admin tool expects",
                self.base
            ),
        })?;
        if let Some(error) = envelope.error {
            return Err(ApiError {
                status: status.as_u16(),
                message: error.message,
            }
            .into());
        }
        if !status.is_success() {
            return Err(ApiError {
                status: status.as_u16(),
                message: format!("Request failed with {status}"),
            }
            .into());
        }
        envelope
            .data
            .ok_or_else(|| anyhow!("The response had no data"))
    }
}

#[derive(Serialize)]
pub struct Empty {}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenResponse {
    pub token: String,
    pub email: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Me {
    pub email: String,
    pub expires_at: Option<String>,
    /// The screens the server has. Missing on a server that predates this field: show everything.
    #[serde(default)]
    pub sections: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub users: UserStats,
    pub workspaces: WorkspaceStats,
    pub mail: MailStats,
    pub campaigns: CampaignStats,
    pub agents: AgentStats,
    pub signups: Vec<SignupDay>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserStats {
    pub total: u64,
    pub verified: u64,
    pub two_factor: u64,
    pub onboarded: u64,
    pub banned: u64,
    pub new7d: u64,
    pub new30d: u64,
    pub active7d: u64,
    pub active30d: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Plans {
    pub solo: u64,
    pub team: u64,
    pub business: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceStats {
    pub total: u64,
    pub suspended: u64,
    pub new30d: u64,
    pub connected_to_resend: u64,
    pub members: u64,
    /// Plans and revenue only come from a server with billing.
    #[serde(default)]
    pub by_plan: Option<Plans>,
    #[serde(default)]
    pub paying: Option<u64>,
    #[serde(default)]
    pub past_due: Option<u64>,
    #[serde(default)]
    pub estimated_mrr: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailStats {
    pub messages: u64,
    pub inbound30d: u64,
    pub outbound30d: u64,
    pub threads: u64,
    pub mailboxes: u64,
    pub domains: u64,
    pub contacts: u64,
    pub storage_bytes: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CampaignStats {
    pub sent: u64,
    pub recipients: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStats {
    pub active_connections: u64,
    pub messages_sent30d: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SignupDay {
    pub day: String,
    pub users: u64,
    pub workspaces: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserRow {
    pub id: String,
    pub name: String,
    pub email: String,
    pub email_verified: bool,
    pub two_factor_enabled: Option<bool>,
    pub banned_at: Option<String>,
    pub created_at: String,
    pub workspaces: u64,
    pub last_active_at: Option<String>,
    pub is_admin: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserPage {
    pub users: Vec<UserRow>,
    pub matching: u64,
    pub page_size: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Membership {
    pub name: String,
    #[serde(default)]
    pub plan: Option<String>,
    pub role: String,
    pub suspended_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserDetail {
    pub id: String,
    pub name: String,
    pub email: String,
    pub email_verified: bool,
    pub two_factor_enabled: Option<bool>,
    pub onboarded_at: Option<String>,
    pub banned_at: Option<String>,
    pub ban_reason: Option<String>,
    pub created_at: String,
    pub is_admin: bool,
    pub workspaces: Vec<Membership>,
    pub active_sessions: u64,
    pub last_active_at: Option<String>,
    pub agent_connections: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRow {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub plan: Option<String>,
    pub subscription_status: Option<String>,
    pub storage_bytes_used: u64,
    pub suspended_at: Option<String>,
    pub created_at: String,
    pub owner: Option<String>,
    pub members: u64,
    pub mailboxes: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePage {
    pub workspaces: Vec<WorkspaceRow>,
    pub matching: u64,
    pub page_size: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub email: String,
    pub role: String,
    pub banned_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Domain {
    pub name: String,
    pub enabled: bool,
    pub sending_enabled: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceUsage {
    pub threads: u64,
    pub messages30d: u64,
    pub contacts: u64,
    pub campaigns_sent: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDetail {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub plan: Option<String>,
    pub subscription_status: Option<String>,
    pub billing_interval: Option<String>,
    pub current_period_end: Option<String>,
    pub storage_bytes_used: u64,
    pub suspended_at: Option<String>,
    pub suspend_reason: Option<String>,
    pub created_at: String,
    pub members: Vec<Person>,
    pub domains: Vec<Domain>,
    pub usage: WorkspaceUsage,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub admin_email: String,
    pub action: String,
    pub target_type: String,
    pub target_id: String,
    pub target_label: Option<String>,
    pub reason: Option<String>,
    pub created_at: String,
}

/// Actions that change something answer { ok: true }.
#[derive(Debug, Clone, Deserialize)]
pub struct Done {}

/// A "Using something else? Tell us" request, newest first from the list.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRequest {
    pub provider: String,
    pub details: Option<String>,
    pub receives_mail: Option<bool>,
    pub email: Option<String>,
    pub source: String,
    pub workspace: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Flushed {
    pub deleted: u64,
}

/// The provider directory's review queue: versions waiting, then listings with open reports.
#[derive(Debug, Clone, Deserialize)]
pub struct DirectoryQueue {
    pub reviews: Vec<ReviewRow>,
    pub reports: Vec<ReportGroup>,
    /// Proven badge records whose listing name doesn't match the domain.
    #[serde(default)]
    pub badges: Vec<BadgeRow>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BadgeRow {
    pub listing_id: String,
    pub name: String,
    pub domain: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRow {
    pub version_id: String,
    pub name: String,
    pub number: u64,
    /// A new version of a live listing, rather than a first submission.
    pub update: bool,
    /// The most serious flag: red, amber or info.
    pub worst: Option<String>,
    pub workspace: String,
    pub submitted_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportGroup {
    pub listing_id: String,
    pub slug: String,
    pub name: String,
    pub open: u64,
    pub hidden: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Flag {
    pub level: String,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Publisher {
    pub workspace: String,
    pub plan: String,
    pub created_at: Option<String>,
    pub members: u64,
    pub domains: u64,
    pub other_listings: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Verification {
    pub domain: String,
    pub state: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub reason: String,
    pub details: Option<String>,
    pub email: Option<String>,
    pub created_at: String,
}

/// One version of a listing, with everything the reviewer weighs.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewDetail {
    pub version_id: String,
    pub listing_id: String,
    pub slug: String,
    pub number: u64,
    pub status: String,
    pub listing_status: String,
    pub hidden: bool,
    pub name: String,
    pub description: String,
    pub category: String,
    pub docs_url: Option<String>,
    pub logo_url: Option<String>,
    pub page_url: String,
    pub hosts: Vec<String>,
    pub approved_hosts: Vec<String>,
    pub flags: Vec<Flag>,
    pub reserved_name_allowed: bool,
    pub diff: String,
    pub diff_against: Option<u64>,
    pub note: Option<String>,
    pub submitted_by: Option<String>,
    pub submitted_at: String,
    pub installs: u64,
    pub publisher: Publisher,
    pub verification: Option<Verification>,
    pub reports: Vec<Report>,
}
