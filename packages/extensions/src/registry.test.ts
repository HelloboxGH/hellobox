import { afterEach, describe, expect, test } from "bun:test";
import { assertCloudBuild, emitEvent, entitlementsFor, getExtensions, install, resetExtensions, UNLIMITED, WORKSPACE_EVENTS } from "./index";

afterEach(resetExtensions);

describe("registry", () => {
  test("throws when read before it is installed", () => {
    expect(() => getExtensions()).toThrow(/not installed/);
  });

  test("an empty install has no billing and empty lists", () => {
    install({});
    const ext = getExtensions();
    expect(ext.billing).toBeUndefined();
    expect(ext.events).toEqual([]);
    expect(ext.actions).toEqual({});
    expect(ext.jobs).toEqual({});
  });

  test("keeps what was registered", () => {
    const listener = () => {};
    install({ events: [listener] });
    expect(getExtensions().events).toEqual([listener]);
  });

  test("UNLIMITED lets everything through and shows no prompts", () => {
    expect(UNLIMITED.prompts).toBe(false);
    expect(UNLIMITED.plan).toBeNull();
    expect(Object.values(UNLIMITED.limits).every((n) => n === Infinity)).toBe(true);
    expect(Object.values(UNLIMITED.features).every(Boolean)).toBe(true);
  });
});

describe("entitlementsFor", () => {
  test("is unlimited when no billing is registered", async () => {
    install({});
    expect(await entitlementsFor("w1")).toBe(UNLIMITED);
  });

  test("asks the billing slot for the workspace", async () => {
    const seen: string[] = [];
    const small = { ...UNLIMITED, plan: "small", limits: { ...UNLIMITED.limits, domains: 2 } };
    install({
      billing: {
        entitlements: async (id) => {
          seen.push(id);
          return small;
        },
        denied: (_ctx, refusal) => new Error(refusal.message),
      },
    });
    expect(await entitlementsFor("w1")).toBe(small);
    expect(seen).toEqual(["w1"]);
  });

  test("throws before install, like getExtensions", async () => {
    await expect(entitlementsFor("w1")).rejects.toThrow(/not installed/);
  });
});

describe("assertCloudBuild", () => {
  test("fails only when a cloud deploy runs with the stubs", () => {
    expect(() => assertCloudBuild({ HELLOBOX_CLOUD: "1" }, false)).toThrow(/cloud extensions/);
    expect(() => assertCloudBuild({ HELLOBOX_CLOUD: "1" }, true)).not.toThrow();
    expect(() => assertCloudBuild({}, false)).not.toThrow();
  });
});

describe("emitEvent", () => {
  const event = { name: "domain.added", workspaceId: "w1", userId: "u1", target: "acme.com" } as const;

  test("does nothing with no listeners", async () => {
    install({});
    await emitEvent(event);
  });

  test("tells every listener, in order, awaiting each", async () => {
    const seen: string[] = [];
    install({
      events: [
        async (e) => {
          await Promise.resolve();
          seen.push(`first:${e.name}`);
        },
        (e) => {
          seen.push(`second:${e.target}`);
        },
      ],
    });
    await emitEvent(event);
    expect(seen).toEqual(["first:domain.added", "second:acme.com"]);
  });

  test("a listener that throws fails the caller", async () => {
    install({
      events: [
        () => {
          throw new Error("audit write failed");
        },
      ],
    });
    await expect(emitEvent(event)).rejects.toThrow("audit write failed");
  });

  test("throws before install, like every other read", async () => {
    await expect(emitEvent(event)).rejects.toThrow(/not installed/);
  });
});

// Every action string the audit log was written with before events existed. Dropping one
// from WORKSPACE_EVENTS would silently stop that row in cloud.
describe("WORKSPACE_EVENTS", () => {
  const WRITTEN_BEFORE = [
    "agent.connected", "agent.revoked", "bounces.disabled", "bounces.enabled",
    "connection.cloudflare_connected", "connection.cloudflare_disconnected", "connection.disconnected",
    "connection.mailgun_connected", "connection.mailgun_receiving", "connection.mailgun_reconnected",
    "connection.postmark_connected", "connection.postmark_receiving", "connection.postmark_reconnected",
    "connection.ses_production_requested", "connection.ses_receiving", "connection.ses_started",
    "connection.ses_test_recipient_added", "domain.access_requested", "domain.added",
    "domain.claim_dns_verified", "domain.claimed", "domain.claimed_away", "domain.claim_kept",
    "domain.claim_notice", "domain.claim_started", "domain.claim_stopped", "domain.claim_withdrawn",
    "domain.receiving_subdomain", "domain.removed", "domain.restored", "mailbox.deleted",
    "mailbox.made_personal", "mailbox.restored", "mailbox.shared", "member.invited", "member.left",
    "member.mailboxes_updated", "member.removed", "member.role_changed", "sender.blocked",
    "suppression.removed", "workspace.exported", "workspace.logo_changed", "workspace.logo_removed",
    "workspace.renamed", "workspace.transferred",
  ];

  test("has every action string written before", () => {
    const names: readonly string[] = WORKSPACE_EVENTS;
    expect(WRITTEN_BEFORE.filter((name) => !names.includes(name))).toEqual([]);
  });
});
