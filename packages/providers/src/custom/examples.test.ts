import { describe, expect, test } from "bun:test";
import { EXAMPLE_SPECS, FORM_EXAMPLE, JSON_EXAMPLE, MULTIPART_EXAMPLE, RAW_EXAMPLE } from "./examples";
import { customSpecPrompt, specFromAnswer } from "./prompt";
import { buildRequest } from "./request";
import { checkSpec, secretNames } from "./spec";
import { SAMPLE_MESSAGE } from "./template";

const message = { ...SAMPLE_MESSAGE, cc: ["Linus <linus@example.net>"] };
const build = async (spec: (typeof EXAMPLE_SPECS)[number]) => {
  const secrets = Object.fromEntries(secretNames(spec).map((name) => [name, `${name.toLowerCase()}-value`]));
  const request = await buildRequest(spec.send, { secrets, message });
  return { request, text: new TextDecoder().decode(request.body) };
};

describe("example specs", () => {
  test("all check out", () => {
    for (const spec of EXAMPLE_SPECS) expect(checkSpec(spec)).toMatchObject({ ok: true });
  });

  test("JSON: nested recipients, both bodies, attachments renamed", async () => {
    const { request, text } = await build(JSON_EXAMPLE);
    expect(request.headers.Authorization).toBe("Bearer api_key-value");
    const body = JSON.parse(text);
    expect(body.personalizations).toEqual([{ to: [{ email: "grace@example.org", name: "Grace Hopper" }], cc: [{ email: "linus@example.net", name: "Linus" }] }]);
    expect(body.from).toEqual({ email: "ada@example.com", name: "Ada Lovelace" });
    expect(body.content).toEqual([
      { type: "text/plain", value: "Thanks for writing." },
      { type: "text/html", value: "<p>Thanks for writing.</p>" },
    ]);
    expect(body.attachments).toEqual([{ content: "aGVsbG8=", filename: "notes.txt", type: "text/plain" }]);
    expect(body.headers["In-Reply-To"]).toBe("<previous@example.org>");
  });

  test("form: Basic sign-in, the domain in the address, empty fields left out", async () => {
    const { request, text } = await build(FORM_EXAMPLE);
    expect(request.url).toBe("https://api.mailgun.net/v3/domain-value/messages");
    expect(request.headers.Authorization).toBe(`Basic ${btoa("api:api_key-value")}`);
    const form = new URLSearchParams(text);
    expect(form.get("to")).toBe("Grace Hopper <grace@example.org>");
    expect(form.get("h:Reply-To")).toBe("support@example.com");
    expect(form.has("bcc")).toBe(false);
  });

  test("multipart: attachments as files", async () => {
    const { request, text } = await build(MULTIPART_EXAMPLE);
    expect(request.headers["Content-Type"]).toMatch(/^multipart\/form-data/);
    expect(text).toContain('name="attachment"; filename="notes.txt"');
  });

  test("raw: the whole message", async () => {
    const body = JSON.parse((await build(RAW_EXAMPLE)).text);
    expect(Buffer.from(body.raw, "base64").toString()).toContain("Subject: Re: Your question");
    expect(body.to).toEqual(["grace@example.org"]);
  });
});

describe("the AI prompt", () => {
  test("has the rules, the examples and the schema", () => {
    const prompt = customSpecPrompt();
    expect(prompt).toContain("Never put a real API key");
    expect(prompt).toContain('"personalizations"');
    expect(prompt).toContain('"$schema"');
    expect(prompt).toContain("Find the email provider this project sends with");
  });

  test("reads the answer, in a code block or not", () => {
    expect(specFromAnswer('Here you go:\n```json\n{"version": 1}\n```\nEnjoy')).toEqual({ version: 1 });
    expect(specFromAnswer('{"a": {"b": 1}}')).toEqual({ a: { b: 1 } });
    expect(() => specFromAnswer("no json")).toThrow();
  });
});
