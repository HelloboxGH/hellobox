// The hosted support page. A customer's app opens it with a one-time link; the session it
// trades the link for lives only in this page's memory. Text is always set as text.
(() => {
  "use strict";

  const API = "/api/support/hosted";
  const POLL_MS = 15_000;
  const inboxId = location.pathname.split("/").filter(Boolean).at(-1) ?? "";
  const app = document.getElementById("app");
  const state = { session: null, inbox: "Support", view: "list", conversationId: null, timer: null, busy: false };

  // Keeps the token out of history, bookmarks and anything that reads the address.
  const token = decodeURIComponent(location.hash.slice(1));
  history.replaceState(null, "", location.pathname);

  function h(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props ?? {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else if (key === "class") node.className = value;
      else node.setAttribute(key, value === true ? "" : String(value));
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  const show = (...nodes) => app.replaceChildren(...nodes);
  const STATUS = { open: "Open", in_progress: "In progress", solved: "Solved" };
  const when = (iso) => {
    const date = new Date(iso);
    const today = new Date().toDateString() === date.toDateString();
    return today ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : date.toLocaleDateString([], { month: "short", day: "numeric" });
  };
  const sizeOf = (bytes) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

  class Expired extends Error {}

  async function api(path, init = {}) {
    const headers = { ...(state.session ? { Authorization: `Bearer ${state.session}` } : {}), ...init.headers };
    if (typeof init.body === "string") headers["Content-Type"] = "application/json";
    let response;
    try {
      response = await fetch(`${API}${path}`, { ...init, headers, credentials: "omit", cache: "no-store" });
    } catch {
      throw new Error("Couldn't reach support. Check your connection and try again.");
    }
    const body = await response.json().catch(() => ({}));
    if (response.status === 401) throw new Expired(body.error?.message ?? "This page has expired. Open support again from the app.");
    if (!response.ok) throw new Error(body.error?.message ?? "Something went wrong. Try again.");
    return body;
  }

  function stop(message) {
    clearInterval(state.timer);
    state.session = null;
    show(h("div", { class: "panel empty" }, h("h1", null, "Support"), h("p", { class: "muted" }, message)));
  }

  function failed(error) {
    if (error instanceof Expired) stop(error.message);
    return error instanceof Error ? error.message : "Something went wrong. Try again.";
  }

  // One key per draft, so trying the same message again never stores it twice.
  function draftKey(form) {
    const files = [...(form.elements.files?.files ?? [])].map((file) => `${file.name}:${file.size}`).join("|");
    const content = `${form.elements.subject?.value ?? ""}\n${form.elements.text.value}\n${files}`;
    if (form.dataset.content !== content) {
      form.dataset.content = content;
      form.dataset.key = crypto.randomUUID();
    }
    return form.dataset.key;
  }

  function composer({ conversationId, onSent }) {
    const error = h("p", { class: "error", role: "alert", hidden: true });
    const send = h("button", { class: "primary", type: "submit" }, "Send");
    const form = h(
      "form",
      { class: "panel compose" },
      conversationId ? null : [h("label", { for: "subject" }, "Subject"), h("input", { id: "subject", name: "subject", type: "text", maxlength: 200, placeholder: "Optional" })],
      h("label", { for: "text" }, conversationId ? "Reply" : "Message"),
      h("textarea", { id: "text", name: "text", required: true, maxlength: 50000, placeholder: conversationId ? "Write a reply" : "How can we help?" }),
      h("div", { class: "row" }, h("input", { name: "files", type: "file", multiple: true, class: "grow", "aria-label": "Attach files" }), send),
      h("p", { class: "muted small" }, "Up to 5 files, 10 MB each."),
      error,
    );
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (state.busy) return;
      const text = form.elements.text.value;
      if (!text.trim()) return;
      const message = { text, idempotencyKey: draftKey(form), conversationId: conversationId ?? undefined, subject: form.elements.subject?.value.trim() || undefined };
      const files = [...form.elements.files.files];
      let body = JSON.stringify(message);
      if (files.length) {
        body = new FormData();
        body.append("message", JSON.stringify(message));
        for (const file of files) body.append("files", file, file.name);
      }
      state.busy = true;
      send.disabled = true;
      send.textContent = "Sending…";
      error.hidden = true;
      try {
        const result = await api("/messages", { method: "POST", body });
        form.reset();
        delete form.dataset.content;
        onSent(result.conversationId);
      } catch (caught) {
        error.textContent = failed(caught);
        error.hidden = false;
      } finally {
        state.busy = false;
        send.disabled = false;
        send.textContent = "Send";
      }
    });
    return form;
  }

  async function download(id) {
    try {
      const { url } = await api(`/attachments/${encodeURIComponent(id)}`);
      window.open(url, "_blank", "noopener");
    } catch (caught) {
      alert(failed(caught));
    }
  }

  async function renderList() {
    state.view = "list";
    state.conversationId = null;
    const { conversations } = await api("/conversations");
    if (state.view !== "list") return;
    const items = conversations.map((item) =>
      h("li", null, h("button", { type: "button", onclick: () => open(item.id) },
        h("span", { class: "subject" }, item.subject),
        h("span", { class: `badge ${item.status}` }, STATUS[item.status] ?? item.status),
        h("span", { class: "time" }, when(item.lastMessageAt)),
      )),
    );
    show(
      h("div", { class: "bar" }, h("h1", null, state.inbox), h("button", { class: "primary", type: "button", onclick: renderNew }, "New message")),
      items.length
        ? h("ul", { class: "panel list" }, items)
        : h("div", { class: "panel empty" }, h("p", null, "No conversations yet."), h("p", { class: "muted" }, "Write to us and we'll answer here and by email.")),
    );
  }

  function renderNew() {
    state.view = "new";
    state.conversationId = null;
    show(
      h("div", { class: "bar" }, h("button", { class: "link", type: "button", onclick: () => refresh("list") }, "← Back"), h("h1", null, "New message")),
      composer({ onSent: (id) => open(id) }),
    );
  }

  async function renderConversation(id, keepDraft) {
    const conversation = await api(`/conversations/${encodeURIComponent(id)}`);
    if (state.view !== "conversation" || state.conversationId !== id) return;
    const solved = conversation.status === "solved";
    const messages = conversation.messages.map((message) =>
      h("article", { class: `message ${message.from}` },
        h("header", null, h("strong", null, message.from === "customer" ? "You" : (message.name ?? "Support")), h("span", { class: "time" }, when(message.createdAt))),
        h("p", null, message.text),
        message.attachments.length
          ? h("div", { class: "files" }, message.attachments.map((file) => h("button", { type: "button", onclick: () => download(file.id) }, `${file.filename} · ${sizeOf(file.size)}`)))
          : null,
      ),
    );
    const existing = keepDraft ? app.querySelector("form.compose") : null;
    const status = h("button", { type: "button", onclick: async (event) => {
      event.currentTarget.disabled = true;
      try {
        await api(`/conversations/${encodeURIComponent(id)}/status`, { method: "POST", body: JSON.stringify({ status: solved ? "open" : "solved" }) });
        await renderConversation(id, true);
      } catch (caught) {
        alert(failed(caught));
      }
    } }, solved ? "Reopen" : "Mark as solved");
    show(
      h("div", { class: "bar" },
        h("button", { class: "link", type: "button", onclick: () => refresh("list") }, "← Back"),
        h("h1", null, conversation.subject),
        h("span", { class: `badge ${conversation.status}` }, STATUS[conversation.status] ?? conversation.status),
        status,
      ),
      h("div", { class: "panel" }, messages),
      existing ?? composer({ conversationId: id, onSent: () => renderConversation(id, false) }),
    );
  }

  function open(id) {
    state.view = "conversation";
    state.conversationId = id;
    renderConversation(id, false).catch((caught) => show(h("p", { class: "error" }, failed(caught))));
  }

  async function refresh(view = state.view) {
    try {
      if (view === "list") await renderList();
      else if (view === "conversation" && state.conversationId) await renderConversation(state.conversationId, true);
    } catch (caught) {
      const message = failed(caught);
      if (state.session) show(h("p", { class: "error" }, message));
    }
  }

  // New replies show up while the page is open, and nothing is asked for while it's hidden.
  function poll() {
    clearInterval(state.timer);
    state.timer = setInterval(() => {
      if (document.visibilityState === "visible" && state.session && !state.busy && state.view !== "new") refresh();
    }, POLL_MS);
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.session && state.view !== "new") refresh();
  });

  async function start() {
    if (!token) return stop("Open support from the app to see your conversations.");
    try {
      const started = await api("/session", { method: "POST", body: JSON.stringify({ inboxId, token }) });
      state.session = started.session;
      state.inbox = started.inbox;
      document.title = started.inbox;
      // The session ends with the hour; the page says so instead of failing quietly.
      setTimeout(() => stop("This page has expired. Open support again from the app."), new Date(started.expiresAt).getTime() - Date.now());
      poll();
      await renderList();
    } catch (caught) {
      stop(caught instanceof Error ? caught.message : "This link didn't work. Open support again from the app.");
    }
  }

  // A new link set on an open frame only changes the fragment, so start again with it.
  addEventListener("hashchange", () => {
    if (location.hash.length > 1) location.reload();
  });

  start();
})();
