import { describe, expect, test } from "bun:test";
import { sendViaSmtp, smtpOptions } from "./smtp";

describe("SMTP_URL", () => {
  test("smtp:// defaults to port 587 and requires STARTTLS", () => {
    const o = smtpOptions("smtp://user:pa%40ss%2Fword@smtp.example.com");
    expect(o).toMatchObject({ host: "smtp.example.com", port: 587, secure: false, requireTLS: true });
    expect(o.auth).toEqual({ user: "user", pass: "pa@ss/word" });
  });

  test("smtps:// defaults to port 465 with TLS from the start", () => {
    expect(smtpOptions("smtps://u:p@mail.example.com")).toMatchObject({ port: 465, secure: true, requireTLS: false });
    expect(smtpOptions("smtps://u:p@mail.example.com:2465").port).toBe(2465);
  });

  test("a mailbox on this machine may skip TLS, and needs no login", () => {
    const o = smtpOptions("smtp://localhost:1025");
    expect(o).toMatchObject({ host: "localhost", port: 1025, requireTLS: false });
    expect(o.auth).toBeUndefined();
  });

  test("anything else is refused with a hint", () => {
    expect(() => smtpOptions("not a url")).toThrow("SMTP_URL isn't a valid URL");
    expect(() => smtpOptions("https://example.com")).toThrow("must start with smtp://");
  });
});

test("sendViaSmtp passes the message to the transport", async () => {
  const sent: unknown[] = [];
  await sendViaSmtp(
    { from: "HelloBox <hi@example.com>", to: "a@example.com", replyTo: "r@example.com", subject: "S", html: "<b>h</b>", text: "h" },
    { sendMail: async (m: unknown) => void sent.push(m) } as never,
  );
  expect(sent).toEqual([{ from: "HelloBox <hi@example.com>", to: "a@example.com", replyTo: "r@example.com", subject: "S", html: "<b>h</b>", text: "h" }]);
});
