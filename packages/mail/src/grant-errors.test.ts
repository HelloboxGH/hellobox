import { describe, expect, test } from "bun:test";
import { MailgunError, PostmarkError, RoleAccessError } from "@hellobox/providers";
import { OAuthGrantError, ResendApiError } from "@hellobox/resend";
import { grantErrorProvider, reconnectMessage } from "./connections";

describe("grantErrorProvider", () => {
  test("names the provider whose access ran out", () => {
    expect(grantErrorProvider(new OAuthGrantError("Resend rejected the grant"))).toBe("resend");
    expect(grantErrorProvider(new ResendApiError(401, "Invalid token"))).toBe("resend");
    expect(grantErrorProvider(new ResendApiError(403, "Access token is missing required scopes: full_access"))).toBe("resend");
    expect(grantErrorProvider(new RoleAccessError("AccessDenied"))).toBe("ses");
    expect(grantErrorProvider(new PostmarkError("Bad token", 401, 10))).toBe("postmark");
    expect(grantErrorProvider(new MailgunError("Forbidden", 401))).toBe("mailgun");
  });

  test("leaves every other error alone, so it's retried or shown as it is", () => {
    expect(grantErrorProvider(new ResendApiError(403, "The domain is not verified"))).toBeNull();
    expect(grantErrorProvider(new ResendApiError(429, "Too many requests"))).toBeNull();
    expect(grantErrorProvider(new ResendApiError(500, "Internal error"))).toBeNull();
    expect(grantErrorProvider(new PostmarkError("Server error", 500, null))).toBeNull();
    expect(grantErrorProvider(new Error("ECONNRESET"))).toBeNull();
    expect(grantErrorProvider("nope")).toBeNull();
  });

  test("the message says what to do", () => {
    expect(reconnectMessage("resend")).toBe("Resend access expired or was removed. Reconnect it in Settings to keep going.");
  });
});
