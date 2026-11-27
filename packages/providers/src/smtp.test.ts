import { describe, expect, test } from "bun:test";
import { parseRawEmail } from "./mime";
import { isSmtpAuthError, SmtpError, smtpError, SmtpProvider, smtpSettingsProblem, type SmtpTarget } from "./smtp";

const target: SmtpTarget = {
  host: "smtp.example.com",
  port: 587,
  username: "ada@example.com",
  password: "app-password",
  domains: ["example.com", "reply.example.com"],
};

type SendOptions = { envelope: { from: string; to: string[] }; raw: Buffer };

function fakeTransport(overrides: { sendMail?: () => Promise<unknown>; verify?: () => Promise<unknown> } = {}) {
  const seen: { options: Record<string, unknown>[]; sent: SendOptions[]; closed: number } = { options: [], sent: [], closed: 0 };
  const transportFor = (options: unknown) => {
    seen.options.push(options as Record<string, unknown>);
    return {
      sendMail: async (mail: SendOptions) => {
        seen.sent.push(mail);
        return overrides.sendMail ? overrides.sendMail() : { messageId: "<server@example.com>" };
      },
      verify: async () => (overrides.verify ? overrides.verify() : true),
      close: () => {
        seen.closed += 1;
      },
    };
  };
  return { seen, transportFor: transportFor as never };
}

const resolveTo = (address: string) => async () => address;

describe("smtpSettingsProblem", () => {
  test("takes a server name on a known port", () => {
    expect(smtpSettingsProblem({ host: "smtp.example.com", port: 587 })).toBeNull();
    expect(smtpSettingsProblem({ host: "mail.fastmail.com", port: 465 })).toBeNull();
  });

  test("refuses addresses, bare names and other ports", () => {
    expect(smtpSettingsProblem({ host: "10.0.0.1", port: 587 })).not.toBeNull();
    expect(smtpSettingsProblem({ host: "localhost", port: 587 })).not.toBeNull();
    expect(smtpSettingsProblem({ host: "smtp.example.com", port: 8080 })).not.toBeNull();
  });
});

describe("SmtpProvider", () => {
  test("lists the domains the customer added, sending only", async () => {
    const provider = new SmtpProvider(target, resolveTo("203.0.113.9"));
    expect(provider.capabilities.receiving).toBe(false);
    expect(await provider.listDomains()).toEqual([
      { id: "example.com", name: "example.com", status: "verified", sending: true, receiving: false },
      { id: "reply.example.com", name: "reply.example.com", status: "verified", sending: true, receiving: false },
    ]);
  });

  test("connects to the checked address, requires TLS and checks the certificate by name", async () => {
    const fake = fakeTransport();
    await new SmtpProvider(target, resolveTo("203.0.113.9"), fake.transportFor).verify();
    const [options] = fake.seen.options;
    expect(options?.host).toBe("203.0.113.9");
    expect(options?.secure).toBe(false);
    expect(options?.requireTLS).toBe(true);
    expect(options?.tls).toMatchObject({ servername: "smtp.example.com", rejectUnauthorized: true });
    expect(fake.seen.closed).toBe(1);
  });

  test("port 465 is TLS from the start", async () => {
    const fake = fakeTransport();
    await new SmtpProvider({ ...target, port: 465 }, resolveTo("203.0.113.9"), fake.transportFor).verify();
    expect(fake.seen.options[0]).toMatchObject({ secure: true, requireTLS: false });
  });

  test("a refused host never gets a connection", async () => {
    const fake = fakeTransport();
    const provider = new SmtpProvider(target, async () => {
      throw new Error("points to a private address");
    }, fake.transportFor);
    await expect(provider.verify()).rejects.toThrow(/private/);
    expect(fake.seen.options).toHaveLength(0);
  });

  test("sends our own message, keeping the Message-ID and threading headers, with Bcc only in the envelope", async () => {
    const fake = fakeTransport();
    const provider = new SmtpProvider(target, resolveTo("203.0.113.9"), fake.transportFor);
    const sent = await provider.send({
      from: "Ada <ada@example.com>",
      to: ["Grace <grace@example.org>"],
      cc: ["linus@example.net"],
      bcc: ["audit@example.com"],
      subject: "Re: Hello",
      html: "<p>Hi</p>",
      text: "Hi",
      headers: { "Message-ID": "<abc@hellobox.app>", "In-Reply-To": "<prev@example.org>", References: "<prev@example.org>" },
    });
    expect(sent.id).toBe("abc@hellobox.app");
    const [mail] = fake.seen.sent;
    expect(mail?.envelope).toEqual({
      from: "ada@example.com",
      to: ["grace@example.org", "linus@example.net", "audit@example.com"],
    });
    const parsed = await parseRawEmail("test", new Uint8Array(mail!.raw));
    expect(parsed.messageId).toBe("<abc@hellobox.app>");
    expect(parsed.headers["in-reply-to"]).toBe("<prev@example.org>");
    expect(JSON.stringify(parsed.headers)).not.toContain("audit@example.com");
    expect(fake.seen.closed).toBe(1);
  });

  test("a refused password is a reconnect, not a retry", async () => {
    const fake = fakeTransport({
      verify: async () => {
        throw Object.assign(new Error("Invalid login"), { code: "EAUTH", response: "535 5.7.8 Authentication failed" });
      },
    });
    const error = await new SmtpProvider(target, resolveTo("203.0.113.9"), fake.transportFor).verify().catch((e: unknown) => e);
    expect(isSmtpAuthError(error)).toBe(true);
    expect((error as Error).message).toContain("535 5.7.8");
  });
});

describe("smtpError", () => {
  test("words the server's answers", () => {
    expect(smtpError({ code: "ETLS" })).toBeInstanceOf(SmtpError);
    expect(smtpError(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNECTION" })).message).toMatch(/Couldn't reach/);
    expect(smtpError({ code: "EENVELOPE", response: "550 Sender not allowed" }).message).toContain("550 Sender not allowed");
  });
});
