use anyhow::Result;
use ratatui::{
    DefaultTerminal, Frame,
    crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers},
    layout::{Constraint, Direction, Flex, Layout, Rect},
    style::{Color, Modifier, Style, Stylize},
    text::{Line, Span, Text},
    widgets::{
        Bar, BarChart, BarGroup, Block, BorderType, Clear, LineGauge, Paragraph, Row, Sparkline,
        Table, TableState, Tabs, Wrap,
    },
};
use serde_json::json;

use crate::{
    api::{
        Activity, Api, Done, Empty, Stats, UserDetail, UserPage, UserRow, WorkspaceDetail,
        WorkspacePage, WorkspaceRow, is_unauthorized,
    },
    format::{ago, bytes, date, date_time, money, number, percent, ratio},
};

const ACCENT: Color = Color::Rgb(137, 152, 255);
const DIM: Style = Style::new().fg(Color::DarkGray);
const USER_FILTERS: [&str; 3] = ["all", "banned", "unverified"];
const WORKSPACE_FILTERS: [&str; 3] = ["all", "paying", "suspended"];
// Without billing there are no paying workspaces to filter for.
const OPEN_WORKSPACE_FILTERS: [&str; 2] = ["all", "suspended"];

pub enum Outcome {
    Quit,
    SessionEnded,
}

#[derive(Clone, Copy, PartialEq)]
enum Tab {
    Overview,
    Users,
    Workspaces,
    Activity,
}

const TABS: [Tab; 4] = [Tab::Overview, Tab::Users, Tab::Workspaces, Tab::Activity];

impl Tab {
    fn index(self) -> usize {
        TABS.iter().position(|tab| *tab == self).unwrap_or(0)
    }
}

struct Page<T> {
    rows: Vec<T>,
    matching: u64,
    page_size: u64,
    page: u64,
    query: String,
    filter: usize,
    table: TableState,
    loaded: bool,
}

impl<T> Page<T> {
    fn new() -> Self {
        Self {
            rows: vec![],
            matching: 0,
            page_size: 50,
            page: 0,
            query: String::new(),
            filter: 0,
            table: TableState::default(),
            loaded: false,
        }
    }

    fn pages(&self) -> u64 {
        self.matching.div_ceil(self.page_size.max(1)).max(1)
    }

    fn selected(&self) -> Option<&T> {
        self.table.selected().and_then(|i| self.rows.get(i))
    }

    fn fill(&mut self, rows: Vec<T>, matching: u64, page_size: u64) {
        self.rows = rows;
        self.matching = matching;
        self.page_size = page_size;
        self.loaded = true;
        let keep = self
            .table
            .selected()
            .unwrap_or(0)
            .min(self.rows.len().saturating_sub(1));
        self.table.select(if self.rows.is_empty() {
            None
        } else {
            Some(keep)
        });
    }

    fn step(&mut self, by: isize) {
        if self.rows.is_empty() {
            return;
        }
        let current = self.table.selected().unwrap_or(0) as isize;
        let next = (current + by).clamp(0, self.rows.len() as isize - 1);
        self.table.select(Some(next as usize));
    }
}

#[derive(Clone)]
enum Pending {
    Ban { id: String, label: String },
    Unban { id: String, label: String },
    SignOut { id: String, label: String },
    Suspend { id: String, label: String },
    Unsuspend { id: String, label: String },
}

impl Pending {
    fn title(&self) -> String {
        match self {
            Pending::Ban { label, .. } => format!("Ban {label}"),
            Pending::Unban { label, .. } => format!("Unban {label}"),
            Pending::SignOut { label, .. } => format!("Sign out {label} everywhere"),
            Pending::Suspend { label, .. } => format!("Suspend {label}"),
            Pending::Unsuspend { label, .. } => format!("Lift the suspension on {label}"),
        }
    }

    fn explanation(&self) -> &'static str {
        match self {
            Pending::Ban { .. } => {
                "They're signed out everywhere, their agent connections stop, and they can't sign in again."
            }
            Pending::Unban { .. } => {
                "They can sign in again. Their old sessions and agent connections stay ended."
            }
            Pending::SignOut { .. } => {
                "Ends their browser sessions, agent connections and admin sessions. They can sign in again."
            }
            Pending::Suspend { .. } => {
                "Nobody can open the workspace, and queued mail and campaigns stop sending."
            }
            Pending::Unsuspend { .. } => "Members can open the workspace and send again.",
        }
    }

    fn needs_reason(&self) -> bool {
        matches!(self, Pending::Ban { .. } | Pending::Suspend { .. })
    }

    fn run(&self, api: &Api, reason: &str) -> Result<Done> {
        match self {
            Pending::Ban { id, .. } => {
                api.call("/admin/users/ban", &json!({ "id": id, "reason": reason }))
            }
            Pending::Unban { id, .. } => api.call("/admin/users/unban", &json!({ "id": id })),
            Pending::SignOut { id, .. } => api.call("/admin/users/sign-out", &json!({ "id": id })),
            Pending::Suspend { id, .. } => api.call(
                "/admin/workspaces/suspend",
                &json!({ "id": id, "reason": reason }),
            ),
            Pending::Unsuspend { id, .. } => {
                api.call("/admin/workspaces/unsuspend", &json!({ "id": id }))
            }
        }
    }

    fn done(&self) -> String {
        match self {
            Pending::Ban { label, .. } => format!("Banned {label}"),
            Pending::Unban { label, .. } => format!("Unbanned {label}"),
            Pending::SignOut { label, .. } => format!("Signed {label} out everywhere"),
            Pending::Suspend { label, .. } => format!("Suspended {label}"),
            Pending::Unsuspend { label, .. } => format!("Lifted the suspension on {label}"),
        }
    }
}

#[derive(Clone)]
enum Detail {
    User(Box<UserDetail>),
    Workspace(Box<WorkspaceDetail>),
}

enum Mode {
    Normal,
    Search(String),
    Detail(Detail),
    Reason {
        pending: Pending,
        input: String,
        back: Option<Detail>,
    },
    Confirm {
        pending: Pending,
        back: Option<Detail>,
    },
    Help,
}

struct Status {
    text: String,
    error: bool,
}

struct App {
    api: Api,
    email: String,
    expires_at: String,
    /// The screens the server has; None = an older server, which has them all.
    sections: Option<Vec<String>>,
    tab: Tab,
    mode: Mode,
    status: Option<Status>,
    stats: Option<Stats>,
    users: Page<UserRow>,
    workspaces: Page<WorkspaceRow>,
    activity: Vec<Activity>,
    activity_table: TableState,
    activity_loaded: bool,
    quit: bool,
    session_ended: bool,
}

pub fn run(api: Api, email: String, expires_at: String, sections: Option<Vec<String>>) -> Result<Outcome> {
    let mut terminal = ratatui::init();
    let mut app = App::new(api, email, expires_at, sections);
    let result = app.run(&mut terminal);
    ratatui::restore();
    result
}

impl App {
    fn new(api: Api, email: String, expires_at: String, sections: Option<Vec<String>>) -> Self {
        Self {
            api,
            email,
            expires_at,
            sections,
            tab: Tab::Overview,
            mode: Mode::Normal,
            status: None,
            stats: None,
            users: Page::new(),
            workspaces: Page::new(),
            activity: vec![],
            activity_table: TableState::default(),
            activity_loaded: false,
            quit: false,
            session_ended: false,
        }
    }

    fn has(&self, section: &str) -> bool {
        self.sections
            .as_ref()
            .is_none_or(|sections| sections.iter().any(|s| s == section))
    }

    fn workspace_filters(&self) -> &'static [&'static str] {
        if self.has("billing") {
            &WORKSPACE_FILTERS
        } else {
            &OPEN_WORKSPACE_FILTERS
        }
    }

    fn run(&mut self, terminal: &mut DefaultTerminal) -> Result<Outcome> {
        self.load(terminal);
        loop {
            terminal.draw(|frame| self.draw(frame))?;
            if self.session_ended {
                return Ok(Outcome::SessionEnded);
            }
            if self.quit {
                return Ok(Outcome::Quit);
            }
            if let Event::Key(key) = event::read()?
                && key.kind == KeyEventKind::Press
            {
                self.on_key(key, terminal);
            }
        }
    }

    // Requests block, so the screen says what's loading before each one.
    fn busy<T>(
        &mut self,
        terminal: &mut DefaultTerminal,
        label: &str,
        work: impl FnOnce(&Api) -> Result<T>,
    ) -> Option<T> {
        self.status = Some(Status {
            text: format!("{label}…"),
            error: false,
        });
        let _ = terminal.draw(|frame| self.draw(frame));
        match work(&self.api) {
            Ok(value) => {
                self.status = None;
                Some(value)
            }
            Err(error) => {
                if is_unauthorized(&error) {
                    self.session_ended = true;
                }
                self.status = Some(Status {
                    text: format!("{error:#}"),
                    error: true,
                });
                None
            }
        }
    }

    fn load(&mut self, terminal: &mut DefaultTerminal) {
        match self.tab {
            Tab::Overview => {
                if let Some(stats) = self.busy(terminal, "Loading usage", |api| {
                    api.call::<Stats>("/admin/stats", &Empty {})
                }) {
                    self.stats = Some(stats);
                }
            }
            Tab::Users => {
                let body = json!({ "query": self.users.query, "page": self.users.page, "filter": USER_FILTERS[self.users.filter] });
                if let Some(page) = self.busy(terminal, "Loading users", |api| {
                    api.call::<UserPage>("/admin/users/list", &body)
                }) {
                    self.users.fill(page.users, page.matching, page.page_size);
                }
            }
            Tab::Workspaces => {
                let body = json!({ "query": self.workspaces.query, "page": self.workspaces.page, "filter": self.workspace_filters()[self.workspaces.filter] });
                if let Some(page) = self.busy(terminal, "Loading workspaces", |api| {
                    api.call::<WorkspacePage>("/admin/workspaces/list", &body)
                }) {
                    self.workspaces
                        .fill(page.workspaces, page.matching, page.page_size);
                }
            }
            Tab::Activity => {
                if let Some(rows) = self.busy(terminal, "Loading activity", |api| {
                    api.call::<Vec<Activity>>("/admin/activity", &Empty {})
                }) {
                    self.activity = rows;
                    self.activity_loaded = true;
                    self.activity_table.select(if self.activity.is_empty() {
                        None
                    } else {
                        Some(0)
                    });
                }
            }
        }
    }

    fn switch(&mut self, tab: Tab, terminal: &mut DefaultTerminal) {
        self.tab = tab;
        self.status = None;
        let loaded = match tab {
            Tab::Overview => self.stats.is_some(),
            Tab::Users => self.users.loaded,
            Tab::Workspaces => self.workspaces.loaded,
            Tab::Activity => self.activity_loaded,
        };
        if !loaded {
            self.load(terminal);
        }
    }

    fn open_detail(&mut self, terminal: &mut DefaultTerminal) {
        let detail = match self.tab {
            Tab::Users => {
                let Some(id) = self.users.selected().map(|row| row.id.clone()) else {
                    return;
                };
                self.fetch_user(terminal, &id)
            }
            Tab::Workspaces => {
                let Some(id) = self.workspaces.selected().map(|row| row.id.clone()) else {
                    return;
                };
                self.fetch_workspace(terminal, &id)
            }
            _ => None,
        };
        if let Some(detail) = detail {
            self.mode = Mode::Detail(detail);
        }
    }

    fn fetch_user(&mut self, terminal: &mut DefaultTerminal, id: &str) -> Option<Detail> {
        self.busy(terminal, "Loading user", |api| {
            api.call::<UserDetail>("/admin/users/get", &json!({ "id": id }))
        })
        .map(|detail| Detail::User(Box::new(detail)))
    }

    fn fetch_workspace(&mut self, terminal: &mut DefaultTerminal, id: &str) -> Option<Detail> {
        self.busy(terminal, "Loading workspace", |api| {
            api.call::<WorkspaceDetail>("/admin/workspaces/get", &json!({ "id": id }))
        })
        .map(|detail| Detail::Workspace(Box::new(detail)))
    }

    // What b, u, o and s act on: the open detail, or the selected row.
    fn pending_for(&self, key: char, detail: Option<&Detail>) -> Option<Pending> {
        let user = match detail {
            Some(Detail::User(user)) => Some((
                user.id.clone(),
                user.email.clone(),
                user.banned_at.is_some(),
                user.is_admin,
            )),
            None if self.tab == Tab::Users => self.users.selected().map(|row| {
                (
                    row.id.clone(),
                    row.email.clone(),
                    row.banned_at.is_some(),
                    row.is_admin,
                )
            }),
            _ => None,
        };
        if let Some((id, label, banned, admin)) = user {
            return match key {
                'b' if !banned && !admin => Some(Pending::Ban { id, label }),
                'u' if banned => Some(Pending::Unban { id, label }),
                'o' => Some(Pending::SignOut { id, label }),
                _ => None,
            };
        }
        let workspace = match detail {
            Some(Detail::Workspace(workspace)) => Some((
                workspace.id.clone(),
                workspace.name.clone(),
                workspace.suspended_at.is_some(),
            )),
            None if self.tab == Tab::Workspaces => self
                .workspaces
                .selected()
                .map(|row| (row.id.clone(), row.name.clone(), row.suspended_at.is_some())),
            _ => None,
        };
        let (id, label, suspended) = workspace?;
        match key {
            's' if !suspended => Some(Pending::Suspend { id, label }),
            'u' if suspended => Some(Pending::Unsuspend { id, label }),
            _ => None,
        }
    }

    fn start(&mut self, pending: Pending, back: Option<Detail>) {
        self.mode = if pending.needs_reason() {
            Mode::Reason {
                pending,
                input: String::new(),
                back,
            }
        } else {
            Mode::Confirm { pending, back }
        };
    }

    fn perform(
        &mut self,
        terminal: &mut DefaultTerminal,
        pending: Pending,
        reason: String,
        back: Option<Detail>,
    ) {
        self.mode = Mode::Normal;
        let title = pending.title();
        if self
            .busy(terminal, &title, |api| pending.run(api, &reason))
            .is_none()
        {
            return;
        }
        self.stats = None;
        self.activity_loaded = false;
        self.load(terminal);
        if let Some(back) = back {
            let refreshed = match back {
                Detail::User(user) => self.fetch_user(terminal, &user.id),
                Detail::Workspace(workspace) => self.fetch_workspace(terminal, &workspace.id),
            };
            if let Some(detail) = refreshed {
                self.mode = Mode::Detail(detail);
            }
        }
        self.status = Some(Status {
            text: pending.done(),
            error: false,
        });
    }

    fn on_key(&mut self, key: KeyEvent, terminal: &mut DefaultTerminal) {
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
            self.quit = true;
            return;
        }
        match std::mem::replace(&mut self.mode, Mode::Normal) {
            Mode::Normal => self.on_normal_key(key, terminal),
            Mode::Help => {}
            Mode::Search(mut query) => match key.code {
                KeyCode::Enter => {
                    match self.tab {
                        Tab::Users => {
                            self.users.query = query;
                            self.users.page = 0;
                        }
                        Tab::Workspaces => {
                            self.workspaces.query = query;
                            self.workspaces.page = 0;
                        }
                        _ => {}
                    }
                    self.load(terminal);
                }
                KeyCode::Esc => {}
                KeyCode::Backspace => {
                    query.pop();
                    self.mode = Mode::Search(query);
                }
                KeyCode::Char(ch) => {
                    query.push(ch);
                    self.mode = Mode::Search(query);
                }
                _ => self.mode = Mode::Search(query),
            },
            Mode::Detail(detail) => match key.code {
                KeyCode::Esc | KeyCode::Char('q') | KeyCode::Enter => {}
                KeyCode::Char(ch @ ('b' | 'u' | 'o' | 's')) => {
                    match self.pending_for(ch, Some(&detail)) {
                        Some(pending) => self.start(pending, Some(detail)),
                        None => self.mode = Mode::Detail(detail),
                    }
                }
                _ => self.mode = Mode::Detail(detail),
            },
            Mode::Reason {
                pending,
                mut input,
                back,
            } => match key.code {
                KeyCode::Esc => self.mode = back.map(Mode::Detail).unwrap_or(Mode::Normal),
                KeyCode::Enter if input.trim().chars().count() >= 3 => {
                    self.perform(terminal, pending, input.trim().to_string(), back)
                }
                KeyCode::Backspace => {
                    input.pop();
                    self.mode = Mode::Reason {
                        pending,
                        input,
                        back,
                    };
                }
                KeyCode::Char(ch) if input.chars().count() < 500 => {
                    input.push(ch);
                    self.mode = Mode::Reason {
                        pending,
                        input,
                        back,
                    };
                }
                _ => {
                    self.mode = Mode::Reason {
                        pending,
                        input,
                        back,
                    }
                }
            },
            Mode::Confirm { pending, back } => match key.code {
                KeyCode::Char('y') | KeyCode::Enter => {
                    self.perform(terminal, pending, String::new(), back)
                }
                KeyCode::Char('n') | KeyCode::Esc => {
                    self.mode = back.map(Mode::Detail).unwrap_or(Mode::Normal)
                }
                _ => self.mode = Mode::Confirm { pending, back },
            },
        }
    }

    fn on_normal_key(&mut self, key: KeyEvent, terminal: &mut DefaultTerminal) {
        match key.code {
            KeyCode::Char('q') => self.quit = true,
            KeyCode::Char('?') => self.mode = Mode::Help,
            KeyCode::Char(ch @ '1'..='4') => {
                self.switch(TABS[(ch as usize) - ('1' as usize)], terminal)
            }
            KeyCode::Tab => self.switch(TABS[(self.tab.index() + 1) % TABS.len()], terminal),
            KeyCode::BackTab => self.switch(
                TABS[(self.tab.index() + TABS.len() - 1) % TABS.len()],
                terminal,
            ),
            KeyCode::Char('r') => self.load(terminal),
            KeyCode::Down | KeyCode::Char('j') => self.step(1),
            KeyCode::Up | KeyCode::Char('k') => self.step(-1),
            KeyCode::PageDown => self.step(10),
            KeyCode::PageUp => self.step(-10),
            KeyCode::Right | KeyCode::Char('n') => self.turn_page(1, terminal),
            KeyCode::Left | KeyCode::Char('p') => self.turn_page(-1, terminal),
            KeyCode::Char('/') if matches!(self.tab, Tab::Users | Tab::Workspaces) => {
                let query = if self.tab == Tab::Users {
                    self.users.query.clone()
                } else {
                    self.workspaces.query.clone()
                };
                self.mode = Mode::Search(query);
            }
            KeyCode::Char('f') => {
                match self.tab {
                    Tab::Users => {
                        self.users.filter = (self.users.filter + 1) % USER_FILTERS.len();
                        self.users.page = 0;
                    }
                    Tab::Workspaces => {
                        self.workspaces.filter =
                            (self.workspaces.filter + 1) % self.workspace_filters().len();
                        self.workspaces.page = 0;
                    }
                    _ => return,
                }
                self.load(terminal);
            }
            KeyCode::Enter => self.open_detail(terminal),
            KeyCode::Char(ch @ ('b' | 'u' | 'o' | 's')) => {
                if let Some(pending) = self.pending_for(ch, None) {
                    self.start(pending, None);
                }
            }
            _ => {}
        }
    }

    fn step(&mut self, by: isize) {
        match self.tab {
            Tab::Users => self.users.step(by),
            Tab::Workspaces => self.workspaces.step(by),
            Tab::Activity if !self.activity.is_empty() => {
                let current = self.activity_table.selected().unwrap_or(0) as isize;
                let next = (current + by).clamp(0, self.activity.len() as isize - 1);
                self.activity_table.select(Some(next as usize));
            }
            _ => {}
        }
    }

    fn turn_page(&mut self, by: i64, terminal: &mut DefaultTerminal) {
        let (current, pages) = match self.tab {
            Tab::Users => (self.users.page, self.users.pages()),
            Tab::Workspaces => (self.workspaces.page, self.workspaces.pages()),
            _ => return,
        };
        let next = (current as i64 + by).clamp(0, pages as i64 - 1) as u64;
        if next == current {
            return;
        }
        match self.tab {
            Tab::Users => self.users.page = next,
            _ => self.workspaces.page = next,
        }
        self.load(terminal);
    }

    // Drawing.

    fn draw(&mut self, frame: &mut Frame) {
        let [header, body, footer] = Layout::vertical([
            Constraint::Length(1),
            Constraint::Fill(1),
            Constraint::Length(1),
        ])
        .areas(frame.area());
        self.draw_header(frame, header);
        match self.tab {
            Tab::Overview => self.draw_overview(frame, body),
            Tab::Users => self.draw_users(frame, body),
            Tab::Workspaces => self.draw_workspaces(frame, body),
            Tab::Activity => self.draw_activity(frame, body),
        }
        self.draw_footer(frame, footer);
        match &self.mode {
            Mode::Detail(Detail::User(user)) => draw_user_detail(frame, user),
            Mode::Detail(Detail::Workspace(workspace)) => draw_workspace_detail(frame, workspace),
            Mode::Reason { pending, input, .. } => draw_reason(frame, pending, input),
            Mode::Confirm { pending, .. } => draw_confirm(frame, pending),
            Mode::Help => draw_help(frame),
            Mode::Normal | Mode::Search(_) => {}
        }
    }

    fn draw_header(&self, frame: &mut Frame, area: Rect) {
        let who = if self.expires_at.is_empty() {
            self.email.clone()
        } else {
            format!("{} · until {}", self.email, date_time(&self.expires_at))
        };
        let [title, tabs, account] = Layout::horizontal([
            Constraint::Length(17),
            Constraint::Fill(1),
            Constraint::Length(who.chars().count() as u16 + 1),
        ])
        .areas(area);
        frame.render_widget(Line::from(" HelloBox admin").bold().fg(ACCENT), title);
        frame.render_widget(
            Tabs::new(["1 Overview", "2 Users", "3 Workspaces", "4 Activity"])
                .select(self.tab.index())
                .style(DIM)
                .highlight_style(Style::new().fg(Color::White).add_modifier(Modifier::BOLD))
                .divider(" "),
            tabs,
        );
        frame.render_widget(Line::from(who).style(DIM).right_aligned(), account);
    }

    fn draw_footer(&self, frame: &mut Frame, area: Rect) {
        if let Mode::Search(query) = &self.mode {
            frame.render_widget(
                Line::from(vec![
                    " Search: ".bold(),
                    query.as_str().into(),
                    "▏".fg(ACCENT),
                    "  Enter to search · Esc to cancel".fg(Color::DarkGray),
                ]),
                area,
            );
            return;
        }
        if let Some(status) = &self.status {
            let style = if status.error {
                Style::new().fg(Color::Red)
            } else {
                Style::new().fg(Color::Green)
            };
            frame.render_widget(Line::from(format!(" {}", status.text)).style(style), area);
            return;
        }
        let hints = match self.tab {
            Tab::Overview => "r refresh · Tab switch · ? help · q quit",
            Tab::Users => {
                "↑↓ select · Enter open · / search · f filter · ←→ page · b ban · u unban · o sign out · q quit"
            }
            Tab::Workspaces => {
                "↑↓ select · Enter open · / search · f filter · ←→ page · s suspend · u lift · q quit"
            }
            Tab::Activity => "↑↓ scroll · r refresh · q quit",
        };
        frame.render_widget(Line::from(format!(" {hints}")).style(DIM), area);
    }

    fn draw_overview(&self, frame: &mut Frame, area: Rect) {
        let Some(stats) = &self.stats else {
            frame.render_widget(
                Paragraph::new("Loading usage…")
                    .style(DIM)
                    .block(panel("Overview")),
                area,
            );
            return;
        };
        let users = &stats.users;
        let spaces = &stats.workspaces;
        let [cards, middle, trends, mail] = Layout::vertical([
            Constraint::Length(4),
            Constraint::Length(9),
            Constraint::Length(8),
            Constraint::Fill(1),
        ])
        .areas(area);

        let card_areas: [Rect; 4] = Layout::horizontal([Constraint::Fill(1); 4]).areas(cards);
        card(
            frame,
            card_areas[0],
            "Users",
            number(users.total),
            format!("+{} this week · +{} in 30 days", users.new7d, users.new30d),
        );
        card(
            frame,
            card_areas[1],
            "Active, 7 days",
            number(users.active7d),
            format!(
                "{} of users · {} in 30 days",
                percent(users.active7d, users.total),
                number(users.active30d)
            ),
        );
        card(
            frame,
            card_areas[2],
            "Workspaces",
            number(spaces.total),
            match spaces.paying {
                Some(paying) => format!("{} paying ({})", number(paying), percent(paying, spaces.total)),
                None => format!("+{} in 30 days", number(spaces.new30d)),
            },
        );
        match spaces.estimated_mrr {
            Some(mrr) => card(
                frame,
                card_areas[3],
                "Estimated MRR",
                money(mrr),
                format!(
                    "{} past due · {} suspended",
                    spaces.past_due.unwrap_or(0),
                    spaces.suspended
                ),
            ),
            None => card(
                frame,
                card_areas[3],
                "Suspended",
                number(spaces.suspended),
                format!("{} members", number(spaces.members)),
            ),
        }

        let [accounts, plans] =
            Layout::horizontal([Constraint::Fill(1), Constraint::Fill(1)]).areas(middle);
        let block = panel("Accounts");
        let inner = block.inner(accounts);
        frame.render_widget(block, accounts);
        let gauges = [
            ("Verified email", users.verified),
            ("Two-factor on", users.two_factor),
            ("Onboarded", users.onboarded),
            ("Active, 30 days", users.active30d),
            ("Active, 7 days", users.active7d),
            ("Banned", users.banned),
        ];
        let rows = Layout::vertical(vec![Constraint::Length(1); gauges.len()]).split(inner);
        for ((label, value), row) in gauges.iter().zip(rows.iter()) {
            frame.render_widget(
                LineGauge::default()
                    .ratio(ratio(*value, users.total))
                    .label(format!(
                        "{label:<16}{:>7}  {:>7}",
                        number(*value),
                        percent(*value, users.total)
                    ))
                    .filled_style(Style::new().fg(if *label == "Banned" {
                        Color::Red
                    } else {
                        ACCENT
                    }))
                    .unfilled_style(Style::new().fg(Color::DarkGray)),
                *row,
            );
        }

        // Workspaces by plan on a server with billing; connected or not on one without.
        let (plans_title, plan_rows) = match &spaces.by_plan {
            Some(by_plan) => (
                "Plans",
                vec![
                    ("Solo", by_plan.solo, Color::Gray),
                    ("Team", by_plan.team, ACCENT),
                    ("Business", by_plan.business, Color::Magenta),
                ],
            ),
            None => (
                "Workspaces",
                vec![
                    ("Connected", spaces.connected_to_resend, ACCENT),
                    ("Not yet", spaces.total.saturating_sub(spaces.connected_to_resend), Color::Gray),
                ],
            ),
        };
        let bars: Vec<Bar> = plan_rows
            .iter()
            .map(|(label, value, color)| {
                Bar::default()
                    .value(*value)
                    .label(Line::from(format!("{label:<9}")))
                    .text_value(format!(
                        "{} · {}",
                        number(*value),
                        percent(*value, spaces.total)
                    ))
                    .style(Style::new().fg(*color))
                    .value_style(Style::new().fg(Color::Black).bg(*color))
            })
            .collect();
        frame.render_widget(
            BarChart::default()
                .block(panel(&format!(
                    "{plans_title} · {} connected to Resend ({})",
                    number(spaces.connected_to_resend),
                    percent(spaces.connected_to_resend, spaces.total)
                )))
                .direction(Direction::Horizontal)
                .bar_width(1)
                .bar_gap(1)
                .data(BarGroup::default().bars(&bars)),
            plans,
        );

        let [signups, new_spaces] =
            Layout::horizontal([Constraint::Fill(1), Constraint::Fill(1)]).areas(trends);
        let user_days: Vec<u64> = stats.signups.iter().map(|day| day.users).collect();
        let space_days: Vec<u64> = stats.signups.iter().map(|day| day.workspaces).collect();
        let first = stats
            .signups
            .first()
            .map(|day| day.day.as_str())
            .unwrap_or("");
        frame.render_widget(
            Sparkline::default()
                .block(panel(&format!(
                    "Sign-ups since {first} · {}",
                    number(user_days.iter().sum())
                )))
                .data(&user_days)
                .style(Style::new().fg(ACCENT)),
            signups,
        );
        frame.render_widget(
            Sparkline::default()
                .block(panel(&format!(
                    "New workspaces since {first} · {}",
                    number(space_days.iter().sum())
                )))
                .data(&space_days)
                .style(Style::new().fg(Color::Magenta)),
            new_spaces,
        );

        let m = &stats.mail;
        let left = vec![
            stat_line("Messages", number(m.messages)),
            stat_line("Received, 30 days", number(m.inbound30d)),
            stat_line("Sent, 30 days", number(m.outbound30d)),
            stat_line("Conversations", number(m.threads)),
            stat_line("Storage", bytes(m.storage_bytes)),
        ];
        let middle_col = vec![
            stat_line("Mailboxes", number(m.mailboxes)),
            stat_line("Domains enabled", number(m.domains)),
            stat_line(
                "Memberships",
                format!(
                    "{} ({:.1} per workspace)",
                    number(spaces.members),
                    spaces.members as f64 / spaces.total.max(1) as f64
                ),
            ),
            stat_line("New workspaces, 30d", number(spaces.new30d)),
        ];
        let right = vec![
            stat_line("Contacts", number(m.contacts)),
            stat_line("Campaigns sent", number(stats.campaigns.sent)),
            stat_line("Campaign recipients", number(stats.campaigns.recipients)),
            stat_line("Agent connections", number(stats.agents.active_connections)),
            stat_line(
                "Agent sends, 30 days",
                number(stats.agents.messages_sent30d),
            ),
        ];
        let block = panel("Mail, campaigns and agents");
        let inner = block.inner(mail);
        frame.render_widget(block, mail);
        let columns: [Rect; 3] = Layout::horizontal([Constraint::Fill(1); 3]).areas(inner);
        frame.render_widget(Paragraph::new(left), columns[0]);
        frame.render_widget(Paragraph::new(middle_col), columns[1]);
        frame.render_widget(Paragraph::new(right), columns[2]);
    }

    fn draw_users(&mut self, frame: &mut Frame, area: Rect) {
        let page = &mut self.users;
        let title = list_title(
            "Users",
            page.matching,
            page.page,
            page.pages(),
            USER_FILTERS[page.filter],
            &page.query,
        );
        let rows = page.rows.iter().map(|user| {
            let status = if user.banned_at.is_some() {
                Span::styled("Banned", Style::new().fg(Color::Red))
            } else if user.is_admin {
                Span::styled("Admin", Style::new().fg(ACCENT))
            } else if !user.email_verified {
                Span::styled("Unverified", Style::new().fg(Color::Yellow))
            } else {
                Span::styled("Active", Style::new().fg(Color::Green))
            };
            Row::new(vec![
                Line::from(user.email.clone()),
                Line::from(user.name.clone()),
                Line::from(user.workspaces.to_string()),
                Line::from(yes_no(user.email_verified)),
                Line::from(yes_no(user.two_factor_enabled.unwrap_or(false))),
                Line::from(ago(user.last_active_at.as_deref())),
                Line::from(date(&user.created_at)),
                Line::from(status),
            ])
        });
        let table = Table::new(
            rows,
            [
                Constraint::Fill(3),
                Constraint::Fill(2),
                Constraint::Length(10),
                Constraint::Length(8),
                Constraint::Length(4),
                Constraint::Length(11),
                Constraint::Length(10),
                Constraint::Length(10),
            ],
        )
        .header(header_row([
            "Email",
            "Name",
            "Workspaces",
            "Verified",
            "2FA",
            "Last active",
            "Joined",
            "Status",
        ]))
        .block(panel(&title))
        .row_highlight_style(Style::new().add_modifier(Modifier::REVERSED))
        .highlight_symbol("› ");
        frame.render_stateful_widget(table, area, &mut page.table);
        if page.loaded && page.rows.is_empty() {
            empty(frame, area, "No users match");
        }
    }

    fn draw_workspaces(&mut self, frame: &mut Frame, area: Rect) {
        let billing = self.has("billing");
        let filter = self.workspace_filters()[self.workspaces.filter];
        let page = &mut self.workspaces;
        let title = list_title(
            "Workspaces",
            page.matching,
            page.page,
            page.pages(),
            filter,
            &page.query,
        );
        let rows = page.rows.iter().map(|space| {
            let status = if space.suspended_at.is_some() {
                Span::styled("Suspended", Style::new().fg(Color::Red))
            } else if matches!(
                space.subscription_status.as_deref(),
                Some("past_due" | "on_hold")
            ) {
                Span::styled("Past due", Style::new().fg(Color::Yellow))
            } else {
                Span::styled("Active", Style::new().fg(Color::Green))
            };
            let mut cells = vec![
                Line::from(space.name.clone()),
                Line::from(space.owner.clone().unwrap_or_else(|| "–".into())),
            ];
            if billing {
                cells.push(Line::from(
                    space.plan.as_deref().map(plan_span).unwrap_or_else(|| Span::raw("–")),
                ));
            }
            cells.extend([
                Line::from(space.members.to_string()),
                Line::from(space.mailboxes.to_string()),
                Line::from(bytes(space.storage_bytes_used as f64)),
                Line::from(date(&space.created_at)),
                Line::from(status),
            ]);
            Row::new(cells)
        });
        let mut widths = vec![Constraint::Fill(2), Constraint::Fill(3)];
        let mut headers: Vec<&'static str> = vec!["Name", "Owner"];
        if billing {
            widths.push(Constraint::Length(9));
            headers.push("Plan");
        }
        widths.extend([
            Constraint::Length(8),
            Constraint::Length(10),
            Constraint::Length(10),
            Constraint::Length(10),
            Constraint::Length(10),
        ]);
        headers.extend(["Members", "Mailboxes", "Storage", "Created", "Status"]);
        let table = Table::new(rows, widths)
        .header(header_row(headers))
        .block(panel(&title))
        .row_highlight_style(Style::new().add_modifier(Modifier::REVERSED))
        .highlight_symbol("› ");
        frame.render_stateful_widget(table, area, &mut page.table);
        if page.loaded && page.rows.is_empty() {
            empty(frame, area, "No workspaces match");
        }
    }

    fn draw_activity(&mut self, frame: &mut Frame, area: Rect) {
        let rows = self.activity.iter().map(|entry| {
            let color = match entry.action.as_str() {
                "user.banned" | "workspace.suspended" | "user.signed_out" => Color::Red,
                "user.unbanned" | "workspace.unsuspended" => Color::Green,
                _ => Color::Reset,
            };
            Row::new(vec![
                Line::from(date_time(&entry.created_at)),
                Line::from(entry.admin_email.clone()),
                Line::from(Span::styled(entry.action.clone(), Style::new().fg(color))),
                Line::from(
                    entry
                        .target_label
                        .clone()
                        .unwrap_or_else(|| format!("{} {}", entry.target_type, entry.target_id)),
                ),
                Line::from(entry.reason.clone().unwrap_or_default()),
            ])
        });
        let table = Table::new(
            rows,
            [
                Constraint::Length(20),
                Constraint::Fill(2),
                Constraint::Length(22),
                Constraint::Fill(2),
                Constraint::Fill(3),
            ],
        )
        .header(header_row(["When", "Admin", "Action", "Target", "Reason"]))
        .block(panel("Admin activity · latest 200"))
        .row_highlight_style(Style::new().add_modifier(Modifier::REVERSED));
        frame.render_stateful_widget(table, area, &mut self.activity_table);
        if self.activity_loaded && self.activity.is_empty() {
            empty(frame, area, "No admin activity yet");
        }
    }
}

fn panel(title: &str) -> Block<'static> {
    Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(DIM)
        .title(format!(" {title} "))
        .title_style(Style::new().fg(Color::White))
}

fn card(frame: &mut Frame, area: Rect, title: &str, value: String, note: String) {
    let text = Text::from(vec![
        Line::from(value).bold().fg(ACCENT),
        Line::from(note).style(DIM),
    ]);
    frame.render_widget(Paragraph::new(text).block(panel(title)), area);
}

fn stat_line(label: &str, value: String) -> Line<'static> {
    Line::from(vec![
        Span::styled(format!("{label:<22}"), DIM),
        Span::raw(value),
    ])
}

fn header_row(titles: impl IntoIterator<Item = &'static str>) -> Row<'static> {
    Row::new(titles)
        .style(
            Style::new()
                .fg(Color::DarkGray)
                .add_modifier(Modifier::BOLD),
        )
        .bottom_margin(0)
}

fn list_title(
    name: &str,
    matching: u64,
    page: u64,
    pages: u64,
    filter: &str,
    query: &str,
) -> String {
    let mut title = format!("{name} · {} · page {}/{pages}", number(matching), page + 1);
    if filter != "all" {
        title.push_str(&format!(" · {filter}"));
    }
    if !query.is_empty() {
        title.push_str(&format!(" · “{query}”"));
    }
    title
}

fn yes_no(value: bool) -> Span<'static> {
    if value {
        Span::styled("yes", Style::new().fg(Color::Green))
    } else {
        Span::styled("no", DIM)
    }
}

fn plan_span(plan: &str) -> Span<'static> {
    let color = match plan {
        "team" => ACCENT,
        "business" => Color::Magenta,
        _ => Color::Gray,
    };
    let mut name = plan.to_string();
    if let Some(first) = name.get_mut(0..1) {
        first.make_ascii_uppercase();
    }
    Span::styled(name, Style::new().fg(color))
}

fn empty(frame: &mut Frame, area: Rect, message: &str) {
    let inner = centered(area, message.len() as u16 + 2, 1);
    frame.render_widget(Line::from(message.to_string()).style(DIM).centered(), inner);
}

fn centered(area: Rect, width: u16, height: u16) -> Rect {
    let [row] = Layout::vertical([Constraint::Length(height.min(area.height))])
        .flex(Flex::Center)
        .areas(area);
    let [cell] = Layout::horizontal([Constraint::Length(width.min(area.width))])
        .flex(Flex::Center)
        .areas(row);
    cell
}

fn popup(frame: &mut Frame, title: &str, lines: Vec<Line<'static>>, width: u16) {
    let height = lines.len() as u16 + 2;
    let area = centered(frame.area(), width, height);
    frame.render_widget(Clear, area);
    frame.render_widget(
        Paragraph::new(lines).wrap(Wrap { trim: false }).block(
            Block::bordered()
                .border_type(BorderType::Rounded)
                .border_style(Style::new().fg(ACCENT))
                .title(format!(" {title} ")),
        ),
        area,
    );
}

fn field(label: &str, value: impl Into<String>) -> Line<'static> {
    Line::from(vec![
        Span::styled(format!("{label:<18}"), DIM),
        Span::raw(value.into()),
    ])
}

fn draw_user_detail(frame: &mut Frame, user: &UserDetail) {
    let mut lines = vec![
        field("Name", user.name.clone()),
        field("Email", user.email.clone()),
        field("Joined", date_time(&user.created_at)),
        field("Last active", ago(user.last_active_at.as_deref())),
        field(
            "Verified email",
            if user.email_verified { "yes" } else { "no" },
        ),
        field(
            "Two-factor",
            if user.two_factor_enabled.unwrap_or(false) {
                "on"
            } else {
                "off"
            },
        ),
        field(
            "Onboarded",
            user.onboarded_at
                .as_deref()
                .map(date)
                .unwrap_or_else(|| "no".into()),
        ),
        field("Active sessions", user.active_sessions.to_string()),
        field("Agent connections", user.agent_connections.to_string()),
    ];
    if user.is_admin {
        lines.push(field("Role", "Platform admin"));
    }
    if let Some(at) = &user.banned_at {
        lines.push(Line::from(Span::styled(
            format!(
                "Banned {} · {}",
                date(at),
                user.ban_reason.clone().unwrap_or_default()
            ),
            Style::new().fg(Color::Red),
        )));
    }
    lines.push(Line::default());
    lines.push(Line::from(format!("Workspaces ({})", user.workspaces.len())).bold());
    for space in &user.workspaces {
        let mut spans = vec![
            Span::raw(format!("  {} ", space.name)),
            Span::styled(
                match &space.plan {
                    Some(plan) => format!("{plan} · {}", space.role),
                    None => space.role.clone(),
                },
                DIM,
            ),
        ];
        if space.suspended_at.is_some() {
            spans.push(Span::styled(" · suspended", Style::new().fg(Color::Red)));
        }
        lines.push(Line::from(spans));
    }
    lines.push(Line::default());
    let actions = if user.is_admin {
        "o sign out everywhere · Esc close"
    } else if user.banned_at.is_some() {
        "u unban · o sign out everywhere · Esc close"
    } else {
        "b ban · o sign out everywhere · Esc close"
    };
    lines.push(Line::from(actions).style(DIM));
    popup(frame, &user.email, lines, 72);
}

fn draw_workspace_detail(frame: &mut Frame, space: &WorkspaceDetail) {
    let billing = match (&space.subscription_status, &space.billing_interval) {
        (Some(status), Some(interval)) => format!("{status}, {interval}"),
        (Some(status), None) => status.clone(),
        _ => "no subscription".into(),
    };
    // Plan, billing and renewal only exist on a server with billing.
    let mut lines = vec![];
    if let Some(plan) = &space.plan {
        lines.push(Line::from(vec![
            Span::styled(format!("{:<18}", "Plan"), DIM),
            plan_span(plan),
        ]));
        lines.push(field("Billing", billing));
        lines.push(field(
            "Renews",
            space
                .current_period_end
                .as_deref()
                .map(date)
                .unwrap_or_else(|| "–".into()),
        ));
    }
    lines.extend(vec![
        field("Created", date_time(&space.created_at)),
        field("Storage", bytes(space.storage_bytes_used as f64)),
        field("Conversations", number(space.usage.threads)),
        field("Messages, 30 days", number(space.usage.messages30d)),
        field("Contacts", number(space.usage.contacts)),
        field("Campaigns sent", number(space.usage.campaigns_sent)),
    ]);
    if let Some(at) = &space.suspended_at {
        lines.push(Line::from(Span::styled(
            format!(
                "Suspended {} · {}",
                date(at),
                space.suspend_reason.clone().unwrap_or_default()
            ),
            Style::new().fg(Color::Red),
        )));
    }
    lines.push(Line::default());
    lines.push(Line::from(format!("Members ({})", space.members.len())).bold());
    for person in space.members.iter().take(12) {
        let mut spans = vec![
            Span::raw(format!("  {} ", person.email)),
            Span::styled(person.role.clone(), DIM),
        ];
        if person.banned_at.is_some() {
            spans.push(Span::styled(" · banned", Style::new().fg(Color::Red)));
        }
        lines.push(Line::from(spans));
    }
    if space.members.len() > 12 {
        lines.push(Line::from(format!("  and {} more", space.members.len() - 12)).style(DIM));
    }
    if !space.domains.is_empty() {
        lines.push(Line::default());
        lines.push(Line::from(format!("Domains ({})", space.domains.len())).bold());
        for domain in space.domains.iter().take(6) {
            let state = match (domain.enabled, domain.sending_enabled) {
                (true, true) => "receiving and sending",
                (true, false) => "receiving",
                _ => "off",
            };
            lines.push(Line::from(vec![
                Span::raw(format!("  {} ", domain.name)),
                Span::styled(state, DIM),
            ]));
        }
    }
    lines.push(Line::default());
    let actions = if space.suspended_at.is_some() {
        "u lift the suspension · Esc close"
    } else {
        "s suspend · Esc close"
    };
    lines.push(Line::from(actions).style(DIM));
    popup(frame, &space.name, lines, 72);
}

fn draw_reason(frame: &mut Frame, pending: &Pending, input: &str) {
    let ready = input.trim().chars().count() >= 3;
    let lines = vec![
        Line::from(pending.explanation()),
        Line::default(),
        Line::from("Reason, for the admin log:").style(DIM),
        Line::from(vec![
            Span::raw(input.to_string()),
            Span::styled("▏", Style::new().fg(ACCENT)),
        ]),
        Line::default(),
        Line::from(if ready {
            "Enter to confirm · Esc to cancel"
        } else {
            "Type at least 3 characters · Esc to cancel"
        })
        .style(DIM),
    ];
    popup(frame, &pending.title(), lines, 64);
}

fn draw_confirm(frame: &mut Frame, pending: &Pending) {
    let lines = vec![
        Line::from(pending.explanation()),
        Line::default(),
        Line::from("y to confirm · n to cancel").style(DIM),
    ];
    popup(frame, &format!("{}?", pending.title()), lines, 60);
}

fn draw_help(frame: &mut Frame) {
    let keys = [
        (
            "1-4, Tab",
            "Switch between Overview, Users, Workspaces and Activity",
        ),
        ("r", "Refresh"),
        ("↑ ↓, j k", "Move the selection"),
        ("← →, p n", "Previous and next page"),
        ("/", "Search users or workspaces"),
        ("f", "Cycle the filter"),
        ("Enter", "Open details"),
        ("b / u", "Ban or unban a user"),
        ("o", "Sign a user out everywhere"),
        ("s / u", "Suspend a workspace, or lift it"),
        ("q, Ctrl-C", "Quit"),
    ];
    let mut lines: Vec<Line> = keys
        .iter()
        .map(|(key, what)| {
            Line::from(vec![
                Span::styled(format!("{key:<12}"), Style::new().fg(ACCENT)),
                Span::raw(*what),
            ])
        })
        .collect();
    lines.push(Line::default());
    lines.push(Line::from("Press any key to close").style(DIM));
    popup(frame, "Keys", lines, 70);
}

#[cfg(test)]
mod tests {
    use ratatui::{Terminal, backend::TestBackend};
    use url::Url;

    use super::*;

    fn app() -> App {
        let api = Api::new(&Url::parse("http://127.0.0.1:1/").unwrap(), None).unwrap();
        App::new(
            api,
            "ada@example.com".into(),
            "2026-11-08T08:00:00.000Z".into(),
            None,
        )
    }

    // What an open server answers: no plans, no revenue.
    fn open_app() -> App {
        let mut app = app();
        app.sections = Some(
            ["overview", "users", "workspaces", "activity"]
                .map(String::from)
                .to_vec(),
        );
        app
    }

    fn open_stats() -> Stats {
        serde_json::from_value(json!({
            "users": { "total": 200, "verified": 150, "twoFactor": 40, "onboarded": 120, "banned": 2, "new7d": 12, "new30d": 50, "active7d": 80, "active30d": 140 },
            "workspaces": { "total": 120, "suspended": 1, "new30d": 20, "connectedToResend": 100, "members": 210 },
            "mail": { "messages": 123456, "inbound30d": 9000, "outbound30d": 3000, "threads": 50000, "mailboxes": 300, "domains": 110, "contacts": 40000, "storageBytes": 5368709120.0 },
            "campaigns": { "sent": 14, "recipients": 22000 },
            "agents": { "activeConnections": 7, "messagesSent30d": 31 },
            "signups": [{ "day": "2026-10-09", "users": 1, "workspaces": 1 }],
            "generatedAt": "2026-11-07T20:00:00.000Z"
        }))
        .unwrap()
    }

    fn screen(app: &mut App) -> String {
        let mut terminal = Terminal::new(TestBackend::new(140, 45)).unwrap();
        terminal.draw(|frame| app.draw(frame)).unwrap();
        let buffer = terminal.backend().buffer();
        (0..buffer.area.height)
            .map(|y| {
                (0..buffer.area.width)
                    .map(|x| buffer[(x, y)].symbol())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn stats() -> Stats {
        serde_json::from_value(json!({
            "users": { "total": 200, "verified": 150, "twoFactor": 40, "onboarded": 120, "banned": 2, "new7d": 12, "new30d": 50, "active7d": 80, "active30d": 140 },
            "workspaces": { "total": 120, "byPlan": { "solo": 90, "team": 25, "business": 5 }, "paying": 30, "suspended": 1, "pastDue": 2, "new30d": 20, "connectedToResend": 100, "members": 210, "estimatedMrr": 708.33 },
            "mail": { "messages": 123456, "inbound30d": 9000, "outbound30d": 3000, "threads": 50000, "mailboxes": 300, "domains": 110, "contacts": 40000, "storageBytes": 5368709120.0 },
            "campaigns": { "sent": 14, "recipients": 22000 },
            "agents": { "activeConnections": 7, "messagesSent30d": 31 },
            "signups": [{ "day": "2026-10-09", "users": 1, "workspaces": 1 }, { "day": "2026-10-10", "users": 4, "workspaces": 2 }],
            "generatedAt": "2026-11-07T20:00:00.000Z"
        }))
        .unwrap()
    }

    #[test]
    fn overview_shows_usage_with_percentages() {
        let mut app = app();
        app.stats = Some(stats());
        let text = screen(&mut app);
        assert!(text.contains("HelloBox admin"));
        assert!(text.contains("Estimated MRR"));
        assert!(text.contains("$708"));
        assert!(text.contains("40.0%"), "active 7 days as a share of users");
        assert!(text.contains("25.0%"), "paying share of workspaces");
        assert!(text.contains("123,456"));
        assert!(text.contains("5.0 GB"));
    }

    #[test]
    fn an_open_server_shows_no_plans_or_revenue() {
        let mut app = open_app();
        app.stats = Some(open_stats());
        let text = screen(&mut app);
        assert!(text.contains("HelloBox admin"));
        assert!(!text.contains("Estimated MRR"));
        assert!(!text.contains("paying"));
        assert!(!text.contains("Business"));
        assert!(text.contains("Suspended"));
        assert!(text.contains("123,456"));
    }

    #[test]
    fn the_paying_filter_needs_billing() {
        assert_eq!(app().workspace_filters(), ["all", "paying", "suspended"]);
        assert_eq!(open_app().workspace_filters(), ["all", "suspended"]);
    }

    #[test]
    fn open_workspace_rows_have_no_plan_column() {
        let mut app = open_app();
        app.tab = Tab::Workspaces;
        let rows: Vec<WorkspaceRow> = serde_json::from_value(json!([
            { "id": "1", "name": "Northwind", "subscriptionStatus": null, "storageBytesUsed": 1024, "suspendedAt": null, "createdAt": "2026-11-01T10:00:00.000Z", "owner": "amara@northwind.test", "members": 2, "mailboxes": 3 }
        ]))
        .unwrap();
        app.workspaces.fill(rows, 1, 50);
        let text = screen(&mut app);
        assert!(text.contains("Northwind"));
        assert!(!text.contains("Plan"));
    }

    #[test]
    fn users_tab_lists_people_and_their_status() {
        let mut app = app();
        app.tab = Tab::Users;
        let rows: Vec<UserRow> = serde_json::from_value(json!([
            { "id": "1", "name": "Bob", "email": "bob@example.com", "emailVerified": true, "twoFactorEnabled": false, "bannedAt": "2026-11-07T10:00:00.000Z", "createdAt": "2026-11-01T10:00:00.000Z", "workspaces": 1, "lastActiveAt": null, "isAdmin": false },
            { "id": "2", "name": "Ada", "email": "ada@example.com", "emailVerified": true, "twoFactorEnabled": true, "bannedAt": null, "createdAt": "2026-10-01T10:00:00.000Z", "workspaces": 2, "lastActiveAt": null, "isAdmin": true }
        ]))
        .unwrap();
        app.users.fill(rows, 2, 50);
        let text = screen(&mut app);
        assert!(text.contains("bob@example.com"));
        assert!(text.contains("Banned"));
        assert!(text.contains("Admin"));
        assert!(text.contains("page 1/1"));
    }

    #[test]
    fn admins_cant_be_banned_from_the_list() {
        let mut app = app();
        app.tab = Tab::Users;
        let rows: Vec<UserRow> = serde_json::from_value(json!([
            { "id": "2", "name": "Ada", "email": "ada@example.com", "emailVerified": true, "twoFactorEnabled": true, "bannedAt": null, "createdAt": "2026-10-01T10:00:00.000Z", "workspaces": 2, "lastActiveAt": null, "isAdmin": true }
        ]))
        .unwrap();
        app.users.fill(rows, 1, 50);
        assert!(app.pending_for('b', None).is_none());
        assert!(matches!(
            app.pending_for('o', None),
            Some(Pending::SignOut { .. })
        ));
    }

    #[test]
    fn ban_asks_for_a_reason() {
        let mut app = app();
        app.start(
            Pending::Ban {
                id: "1".into(),
                label: "bob@example.com".into(),
            },
            None,
        );
        let text = screen(&mut app);
        assert!(text.contains("Ban bob@example.com"));
        assert!(text.contains("Reason, for the admin log"));
    }
}
