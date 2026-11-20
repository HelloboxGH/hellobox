// Shared by the server, which throws it when a provider's access ran out, and the client,
// which offers to reconnect.
export const RECONNECT_REQUIRED = "RECONNECT_REQUIRED";

// Resend reconnects from its row in Settings; the others open their connect dialog.
export const reconnectPath = (provider: unknown) =>
  provider === "ses" || provider === "postmark" || provider === "mailgun"
    ? `/settings?tab=connection&connect=${provider}`
    : "/settings?tab=connection";
