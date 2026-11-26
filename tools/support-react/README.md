# @hellobox/support-react

Show a customer their HelloBox support conversations in your React app: they read your
replies, write, attach files and mark a conversation solved.

```tsx
import { HelloBoxSupport } from "@hellobox/support-react";

<HelloBoxSupport getUrl={() => fetch("/api/support-link", { method: "POST" }).then((r) => r.json()).then((r) => r.url)} />
```

Your server makes the link for whoever is signed in, with your support key:

```ts
const response = await fetch("https://hellobox.app/api/support/v1/sessions", {
  method: "POST",
  headers: { Authorization: `Bearer ${process.env.HELLOBOX_SUPPORT_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ user: { id: user.id, email: user.email, name: user.name } }),
});
const { url } = await response.json();
```

Then add your site under **Sites that can show it** in HelloBox, Settings → Support.

A link works once, for 5 minutes, and the page it opens stays signed in for an hour. It's an
iframe around a HelloBox page with a strict content security policy, no dependency beyond
React, and no analytics.
