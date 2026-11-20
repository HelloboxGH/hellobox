import { describe, expect, test } from "bun:test";
import { mergeDelivery, resendDeliveryDetail, summarizeDelivery, suppressionReason, suppressionWhy } from "./delivery";
import { buildSesUseCase, deliveryType, sesEventDetail } from "./ses";

const at = new Date("2026-11-12T10:00:00Z");

describe("suppression rules", () => {
  test("only permanent bounces and complaints suppress an address", () => {
    expect(suppressionReason("email.bounced")).toBe("bounce");
    expect(suppressionReason("email.complained")).toBe("complaint");
    expect(suppressionReason("email.delivery_delayed")).toBeNull();
    expect(suppressionReason("email.failed")).toBeNull();
    expect(suppressionReason("email.delivered")).toBeNull();
  });

  test("SES maps transient bounces to delayed, so they never suppress", () => {
    expect(deliveryType({ eventType: "Bounce", bounce: { bounceType: "Permanent" } })).toBe("email.bounced");
    expect(deliveryType({ eventType: "Bounce", bounce: { bounceType: "Transient" } })).toBe("email.delivery_delayed");
    expect(deliveryType({ eventType: "Complaint" })).toBe("email.complained");
    expect(deliveryType({ eventType: "Reject" })).toBe("email.failed");
  });

  test("Resend's temporary bounces are delays, not bounces", () => {
    const bounce = (type: string) => resendDeliveryDetail({ type: "email.bounced", data: { to: ["ada@example.com"], bounce: { type, message: "Mailbox full" } } });
    expect(bounce("Permanent").type).toBe("email.bounced");
    expect(bounce("Temporary").type).toBe("email.delivery_delayed");
  });
});

describe("event detail", () => {
  test("SES names the bounced recipients and the server's diagnostic", () => {
    const detail = sesEventDetail({
      eventType: "Bounce",
      bounce: {
        bounceType: "Permanent",
        bounceSubType: "General",
        bouncedRecipients: [{ emailAddress: "Ada@Example.com", diagnosticCode: "smtp; 550 5.1.1 user unknown" }],
      },
    });
    expect(detail).toEqual({ recipients: ["ada@example.com"], reason: "smtp; 550 5.1.1 user unknown" });
  });

  test("SES complaints name who complained and the feedback type", () => {
    expect(sesEventDetail({ eventType: "Complaint", complaint: { complaintFeedbackType: "abuse", complainedRecipients: [{ emailAddress: "bo@example.com" }] } }))
      .toEqual({ recipients: ["bo@example.com"], reason: "abuse" });
  });

  test("Resend suppresses only when the email had one recipient", () => {
    const one = resendDeliveryDetail({ type: "email.complained", data: { to: ["Ada <ada@example.com>"] } });
    expect(one.recipients).toEqual(["ada@example.com"]);
    const several = resendDeliveryDetail({ type: "email.bounced", data: { to: ["a@example.com", "b@example.com"], bounce: { type: "Permanent" } } });
    expect(several.recipients).toEqual([]);
  });
});

describe("mergeDelivery and summarizeDelivery", () => {
  test("keeps each recipient's status and reason", () => {
    let map = mergeDelivery({}, "delivered", ["a@example.com"], undefined, at);
    map = mergeDelivery(map, "bounced", ["B@example.com"], "550 user unknown", at);
    expect(map).toEqual({
      "a@example.com": { status: "delivered", at: at.toISOString() },
      "b@example.com": { status: "bounced", reason: "550 user unknown", at: at.toISOString() },
    });
    expect(summarizeDelivery(map)).toBe("bounced");
  });

  test("a later, milder event never hides a worse one", () => {
    let map = mergeDelivery({}, "bounced", ["a@example.com"], "550", at);
    map = mergeDelivery(map, "delivered", ["a@example.com"], undefined, at);
    expect(map["a@example.com"]?.status).toBe("bounced");
    map = mergeDelivery({}, "delivered", ["a@example.com"], undefined, at);
    map = mergeDelivery(map, "delayed", ["a@example.com"], undefined, at);
    expect(map["a@example.com"]?.status).toBe("delivered");
    map = mergeDelivery(map, "complained", ["a@example.com"], "abuse", at);
    expect(map["a@example.com"]?.status).toBe("complained");
  });

  test("events without recipients are kept for the whole email", () => {
    const map = mergeDelivery({}, "failed", [], "Bad content", at);
    expect(map["*"]).toEqual({ status: "failed", reason: "Bad content", at: at.toISOString() });
    expect(summarizeDelivery({})).toBeNull();
  });
});

describe("suppressionWhy", () => {
  test("says what happened, when, and what the server said", () => {
    expect(suppressionWhy({ email: "a@example.com", reason: "bounce", detail: "550  user\nunknown", createdAt: at }))
      .toBe("a@example.com bounced permanently on Nov 12, 2026 (550 user unknown)");
    expect(suppressionWhy({ email: "b@example.com", reason: "complaint", detail: null, createdAt: at }))
      .toBe("b@example.com was reported as spam on Nov 12, 2026");
  });
});

describe("buildSesUseCase", () => {
  test("names the verified domains and only what HelloBox sets up", () => {
    const text = buildSesUseCase({ mailType: "TRANSACTIONAL", domains: ["acme.com", "acme.io"] });
    expect(text).toContain("from our verified domains acme.com, acme.io");
    expect(text).toContain("publishes delivery, bounce, complaint and reject events to Amazon SNS");
    expect(text).toContain("suppression list");
    expect(text).toContain("one-click List-Unsubscribe header");
    expect(text).toContain("We don't use purchased or rented lists");
    expect(text.length).toBeLessThan(5000);
  });

  test("speaks to newsletters for marketing, and works before any domain is verified", () => {
    const text = buildSesUseCase({ mailType: "MARKETING", domains: [] });
    expect(text).toContain("newsletters and announcements to contacts who signed up");
    expect(text).toContain("from domains we verify in SES with DKIM");
  });
});
