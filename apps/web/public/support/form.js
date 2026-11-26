// The public support form. Anyone with the link can write. Text is always set as text.
(() => {
  "use strict";

  const key = location.pathname.split("/").filter(Boolean).at(-1) ?? "";
  const API = `/api/support/form/${encodeURIComponent(key)}`;
  const app = document.getElementById("app");
  let turnstileToken = "";
  let widget = null;

  function h(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(props ?? {})) {
      if (value === undefined || value === null || value === false) continue;
      if (name.startsWith("on")) node.addEventListener(name.slice(2), value);
      else if (name === "class") node.className = value;
      else node.setAttribute(name, value === true ? "" : String(value));
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  const show = (...nodes) => app.replaceChildren(...nodes);
  const unavailable = (message) => show(h("div", { class: "panel empty" }, h("h1", null, "Contact us"), h("p", { class: "muted" }, message)));

  // One key per draft, so trying the same message again never stores it twice.
  function draftKey(form) {
    const files = [...form.elements.files.files].map((file) => `${file.name}:${file.size}`).join("|");
    const content = [form.elements.email.value, form.elements.name.value, form.elements.text.value, files].join("\n");
    if (form.dataset.content !== content) {
      form.dataset.content = content;
      form.dataset.key = crypto.randomUUID();
    }
    return form.dataset.key;
  }

  // Loaded only when this HelloBox checks for bots.
  function turnstile(siteKey, container) {
    const script = h("script", { src: "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit", async: true });
    script.addEventListener("load", () => {
      widget = window.turnstile.render(container, {
        sitekey: siteKey,
        callback: (token) => { turnstileToken = token; },
        "expired-callback": () => { turnstileToken = ""; },
      });
    });
    document.head.append(script);
  }

  function render({ name, turnstileSiteKey }) {
    document.title = name;
    const error = h("p", { class: "error", role: "alert", hidden: true });
    const send = h("button", { class: "primary", type: "submit" }, "Send");
    const check = h("div");
    const form = h(
      "form",
      { class: "panel compose" },
      h("div", { class: "two" },
        h("div", null, h("label", { for: "email" }, "Your email"), h("input", { id: "email", name: "email", type: "email", required: true, maxlength: 254, autocomplete: "email" })),
        h("div", null, h("label", { for: "name" }, "Your name"), h("input", { id: "name", name: "name", type: "text", maxlength: 200, autocomplete: "name", placeholder: "Optional" })),
      ),
      h("label", { for: "text" }, "Message"),
      h("textarea", { id: "text", name: "text", required: true, maxlength: 50000, placeholder: "How can we help?" }),
      h("div", { class: "trap", "aria-hidden": "true" },
        h("label", { for: "website" }, "Leave this empty"),
        h("input", { id: "website", name: "website", type: "text", tabindex: "-1", autocomplete: "off" }),
      ),
      h("label", { for: "files" }, "Screenshots"),
      h("input", { id: "files", name: "files", type: "file", multiple: true, accept: "image/png,image/jpeg,image/gif,image/webp" }),
      h("p", { class: "muted small" }, "Optional. Up to 5 images, 10 MB each."),
      check,
      h("div", { class: "row" }, send),
      error,
    );
    if (turnstileSiteKey) turnstile(turnstileSiteKey, check);

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (send.disabled) return;
      const message = {
        email: form.elements.email.value.trim(),
        name: form.elements.name.value.trim() || undefined,
        text: form.elements.text.value,
        idempotencyKey: draftKey(form),
        website: form.elements.website.value || undefined,
        turnstileToken: turnstileToken || undefined,
      };
      const files = [...form.elements.files.files];
      let body = JSON.stringify(message);
      const headers = {};
      if (files.length) {
        body = new FormData();
        body.append("message", JSON.stringify(message));
        for (const file of files) body.append("files", file, file.name);
      } else {
        headers["Content-Type"] = "application/json";
      }
      send.disabled = true;
      send.textContent = "Sending…";
      error.hidden = true;
      try {
        const response = await fetch(API, { method: "POST", body, headers, credentials: "omit", cache: "no-store" });
        const answer = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(answer.error?.message ?? "Something went wrong. Try again.");
        show(h("div", { class: "panel empty" }, h("h1", null, "Thanks, we got it"), h("p", { class: "muted" }, `We'll answer by email at ${message.email}.`)));
      } catch (caught) {
        error.textContent = caught instanceof TypeError ? "Couldn't reach us. Check your connection and try again." : caught.message;
        error.hidden = false;
        // A token works once; a new try needs a new one.
        if (widget !== null && window.turnstile) {
          turnstileToken = "";
          window.turnstile.reset(widget);
        }
      } finally {
        send.disabled = false;
        send.textContent = "Send";
      }
    });

    show(h("div", { class: "bar" }, h("h1", null, name)), form);
  }

  fetch(API, { credentials: "omit", cache: "no-store" })
    .then(async (response) => {
      if (response.status === 404) return unavailable("This form doesn't exist or was turned off.");
      if (!response.ok) throw new Error();
      render(await response.json());
    })
    .catch(() => unavailable("Couldn't load the form. Try again in a moment."));
})();
