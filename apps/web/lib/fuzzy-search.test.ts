import { describe, expect, test } from "bun:test";
import { editDistance, fold, fuzzySearch, searchScore } from "./fuzzy-search";

const PROVIDERS = [
  { name: "Amazon SES", aliases: ["AWS", "Simple Email Service"] },
  { name: "Resend" },
  { name: "Postmark" },
  { name: "Mailgun" },
  { name: "Bird", aliases: ["SparkPost", "MessageBird"] },
  { name: "Mailjet" },
  { name: "MailerSend" },
  { name: "Brevo", aliases: ["Sendinblue"] },
  { name: "SendGrid", aliases: ["Twilio"] },
  { name: "SMTP" },
  { name: "Custom provider", keywords: ["any API", "curl"] },
];

const names = (query: string) => fuzzySearch(PROVIDERS, query, (item) => item).map((item) => item.name);

describe("fold", () => {
  test("drops case, accents and punctuation", () => {
    expect(fold("  Mailgün (EU)! ")).toBe("mailgun eu");
  });
});

describe("editDistance", () => {
  test("counts a swap of neighbours as one edit", () => {
    expect(editDistance("sedngrid", "sendgrid")).toBe(1);
    expect(editDistance("postmrk", "postmark")).toBe(1);
    expect(editDistance("abc", "abc")).toBe(0);
  });
});

describe("fuzzySearch", () => {
  test("finds names through typos", () => {
    expect(names("sengrid")[0]).toBe("SendGrid");
    expect(names("postmrk")[0]).toBe("Postmark");
    expect(names("mail gun")[0]).toBe("Mailgun");
    expect(names("rsend")[0]).toBe("Resend");
    expect(names("maljet")[0]).toBe("Mailjet");
  });

  test("finds what's typed so far", () => {
    expect(names("sen")[0]).toBe("SendGrid");
    expect(names("mailer")[0]).toBe("MailerSend");
  });

  test("finds other names", () => {
    expect(names("sendinblue")).toEqual(["Brevo"]);
    expect(names("sparkpost")[0]).toBe("Bird");
    expect(names("aws")[0]).toBe("Amazon SES");
    expect(names("ses")[0]).toBe("Amazon SES");
  });

  test("puts the closest first", () => {
    const mail = names("mail");
    expect(mail.slice(0, 3).sort()).toEqual(["MailerSend", "Mailgun", "Mailjet"]);
  });

  test("doesn't guess on short or unrelated queries", () => {
    expect(names("zz")).toEqual([]);
    expect(names("mandrill")).toEqual([]);
    expect(names("xq")).toEqual([]);
  });

  test("returns everything for an empty query", () => {
    expect(names("  ")).toHaveLength(PROVIDERS.length);
  });

  test("keywords match weakly", () => {
    expect(names("curl")).toEqual(["Custom provider"]);
    expect(searchScore("curl", PROVIDERS.at(-1)!)).toBeLessThan(searchScore("custom", PROVIDERS.at(-1)!));
  });
});
