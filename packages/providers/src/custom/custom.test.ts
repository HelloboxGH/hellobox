import { describe, expect, test } from "bun:test";
import { CustomAuthError, CustomError, CustomProvider } from "./provider";
import { buildRequest, maskSecrets, readJsonPath, readPath, type CustomRequest, type CustomResponse } from "./request";
import { checkSpec, customSpecJsonSchema, secretNames, type CustomSpec } from "./spec";
import { formatField, renderTemplate, SAMPLE_MESSAGE, TemplateError, type TemplateMessage } from "./template";

const message: TemplateMessage = {
  ...SAMPLE_MESSAGE,
  to: ["Grace Hopper <grace@example.org>", "linus@example.net"],
  cc: [],
};

const spec = (send: Partial<CustomSpec["send"]> = {}, rest: Partial<CustomSpec> = {}): CustomSpec =>
  ({
    version: 1,
    name: "Acme",
    send: {
      method: "POST",
      url: "https://api.acme.example/v1/send",
      headers: { Authorization: "Bearer <API_KEY>" },
      body: { type: "json", content: { from: "{{from}}", to: "{{to | emails}}", subject: "{{subject}}" } },
      ...send,
    },
    ...rest,
  }) as CustomSpec;

describe("checkSpec", () => {
  test("accepts a spec and lists its values", () => {
    const check = checkSpec(JSON.stringify(spec({ url: "https://<REGION>.acme.example/send" })));
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.secrets).toEqual(["REGION", "API_KEY"]);
  });

  test("explains bad JSON and a wrong shape", () => {
    const bad = checkSpec("{ nope");
    expect(bad.ok).toBe(false);
    const shape = checkSpec({ version: 1, name: "x", send: { method: "POST" } });
    expect(shape.ok).toBe(false);
    if (!shape.ok) expect(shape.problems.some((problem) => problem.startsWith("send.url"))).toBe(true);
  });

  test("refuses unknown message fields, and message fields outside the send request", () => {
    const unknown = checkSpec(spec({ body: { type: "json", content: { x: "{{sender}}" } } }));
    expect(unknown.ok).toBe(false);
    const outside = checkSpec(
      spec({}, { domains: { method: "GET", url: "https://x.example/{{subject}}", headers: {}, list: "data", name: "name" } }),
    );
    expect(outside.ok).toBe(false);
  });

  test("asks for capitals in key-like names", () => {
    const check = checkSpec(spec({ headers: { Authorization: "Bearer <api_key>" } }));
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.problems[0]).toContain("<API_KEY>");
  });

  test("exports a JSON Schema", () => {
    expect(customSpecJsonSchema()).toHaveProperty("properties.send");
  });

  test("finds values in keys too", () => {
    expect(secretNames({ "X-<HEADER_NAME>": "a" })).toEqual(["HEADER_NAME"]);
  });
});

describe("formats", () => {
  const value = (field: string, ...format: string[]) => formatField(message, { field, format });

  test("address lists", () => {
    expect(value("to")).toEqual(message.to);
    expect(value("to", "csv")).toBe("Grace Hopper <grace@example.org>, linus@example.net");
    expect(value("to", "emails")).toEqual(["grace@example.org", "linus@example.net"]);
    expect(value("to", "first", "email")).toBe("grace@example.org");
    expect(value("to", "objects", "address", "display")).toEqual([
      { address: "grace@example.org", display: "Grace Hopper" },
      { address: "linus@example.net" },
    ]);
  });

  test("from", () => {
    expect(value("from", "email")).toBe("ada@example.com");
    expect(value("from", "name")).toBe("Ada Lovelace");
    expect(value("from", "object")).toEqual({ email: "ada@example.com", name: "Ada Lovelace" });
  });

  test("headers, attachments, mime and the Message-ID", () => {
    expect(value("headers", "list", "key", "value")).toContainEqual({ key: "In-Reply-To", value: "<previous@example.org>" });
    expect(value("attachments", "objects", "filename=name", "content=data")).toEqual([{ name: "notes.txt", data: "aGVsbG8=" }]);
    expect(value("mime", "base64")).toBe(Buffer.from(message.mime).toString("base64"));
    expect(value("messageId", "bare")).toBe("sample@hellobox.app");
  });

  test("an unknown format is an error, not a guess", () => {
    expect(() => value("to", "upper")).toThrow(TemplateError);
    expect(() => value("attachments", "objects", "size=bytes")).toThrow(TemplateError);
  });
});

describe("renderTemplate", () => {
  const context = { secrets: { API_KEY: "sk_live_1234", REGION: "eu" }, message };

  test("a whole placeholder keeps its type; inside text it's inserted as text", () => {
    expect(renderTemplate({ to: "{{to | emails}}", line: "To: {{to | emails}}" }, context)).toEqual({
      to: ["grace@example.org", "linus@example.net"],
      line: "To: grace@example.org, linus@example.net",
    });
  });

  test("leaves empty values out", () => {
    expect(renderTemplate({ cc: "{{cc}}", list: ["{{cc}}", "x"] }, context)).toEqual({ list: ["x"] });
  });

  test("fills values, and a value is never read again as a placeholder", () => {
    const tricky = { ...context, message: { ...message, subject: "<API_KEY> {{from}}" } };
    expect(renderTemplate("Bearer <API_KEY>", tricky)).toBe("Bearer sk_live_1234");
    expect(renderTemplate("Subject: {{subject}}", tricky)).toBe("Subject: <API_KEY> {{from}}");
  });

  test("a missing value is an error", () => {
    expect(() => renderTemplate("<OTHER>", context)).toThrow(TemplateError);
  });
});

describe("buildRequest", () => {
  const context = { secrets: { API_KEY: "a/b c", REGION: "eu" }, message };
  const text = (request: CustomRequest) => new TextDecoder().decode(request.body);

  test("json, with values encoded in the address", async () => {
    const request = await buildRequest({ ...spec().send, url: "https://<REGION>.acme.example/send?key=<API_KEY>" }, context);
    expect(request.url).toBe("https://eu.acme.example/send?key=a%2Fb%20c");
    expect(request.headers).toEqual({ Authorization: "Bearer a/b c", "Content-Type": "application/json" });
    expect(JSON.parse(text(request))).toEqual({
      from: "Ada Lovelace <ada@example.com>",
      to: ["grace@example.org", "linus@example.net"],
      subject: "Re: Your question",
    });
  });

  test("form repeats list fields", async () => {
    const request = await buildRequest(
      { method: "POST", url: "https://x.example", headers: {}, body: { type: "form", content: { to: "{{to | emails}}", subject: "{{subject}}" } } },
      context,
    );
    expect(request.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(text(request)).toBe("to=grace%40example.org&to=linus%40example.net&subject=Re%3A+Your+question");
  });

  test("multipart turns attachments into files", async () => {
    const request = await buildRequest(
      {
        method: "POST",
        url: "https://x.example",
        headers: { "content-type": "multipart/form-data" },
        body: { type: "multipart", content: { subject: "{{subject}}", attachment: "{{attachments}}" } },
      },
      context,
    );
    expect(request.headers["Content-Type"]).toMatch(/^multipart\/form-data; boundary=/);
    expect(request.headers["content-type"]).toBeUndefined();
    expect(text(request)).toContain('filename="notes.txt"');
    expect(text(request)).toContain("hello");
  });

  test("GET has no body", async () => {
    const request = await buildRequest({ method: "GET", url: "https://x.example", headers: {}, body: { type: "json", content: {} } }, context);
    expect(request.body).toBeUndefined();
  });
});

test("paths", () => {
  const json = { data: { items: [{ id: "a" }, { id: 7 }] } };
  expect(readJsonPath(json, "data.items[1].id")).toBe(7);
  expect(readJsonPath(json, "data.missing.id")).toBeUndefined();
  expect(readPath({ headers: { "x-message-id": "m1" } }, "header:X-Message-Id")).toBe("m1");
});

test("maskSecrets hides values", () => {
  expect(maskSecrets("bad key sk_live_1234", { API_KEY: "sk_live_1234" })).toBe("bad key <API_KEY>");
});

describe("CustomProvider", () => {
  const outgoing = {
    from: "Ada <ada@example.com>",
    to: ["grace@example.org"],
    subject: "Hi",
    html: "<p>Hi</p>",
    headers: { "Message-ID": "<m1@hellobox.app>" },
    attachments: [{ filename: "a.txt", contentType: "text/plain", storageKey: "k1" }],
  };
  const provider = (target: Partial<ConstructorParameters<typeof CustomProvider>[0]>, answer: Partial<CustomResponse>, sent: CustomRequest[] = []) =>
    new CustomProvider(
      { spec: spec(), secrets: { API_KEY: "sk_live_1234" }, domains: [], ...target },
      async (request) => {
        sent.push(request);
        return { status: 200, headers: {}, body: "", ...answer };
      },
      async () => new TextEncoder().encode("hello"),
    );

  test("sends, and reads the id where the spec says", async () => {
    const sent: CustomRequest[] = [];
    const result = await provider({ spec: spec({ response: { id: "data.id" } }) }, { body: '{"data":{"id":"p-1"}}' }, sent).send(outgoing, "key-1");
    expect(result).toEqual({ id: "p-1" });
    expect(sent[0]!.headers.Authorization).toBe("Bearer sk_live_1234");
  });

  test("falls back to our Message-ID", async () => {
    expect(await provider({}, { body: "ok" }).send(outgoing, "key-1")).toEqual({ id: "m1@hellobox.app" });
  });

  test("attachments and the whole message, when the spec uses them", async () => {
    const sent: CustomRequest[] = [];
    const custom = spec({ body: { type: "json", content: { raw: "{{mime | base64}}", files: "{{attachments | objects content}}" } } });
    await provider({ spec: custom }, {}, sent).send(outgoing, "key-1");
    const body = JSON.parse(new TextDecoder().decode(sent[0]!.body)) as { raw: string; files: { content: string }[] };
    expect(body.files).toEqual([{ content: Buffer.from("hello").toString("base64") }]);
    const mime = Buffer.from(body.raw, "base64").toString("utf8");
    expect(mime).toContain("Message-ID: <m1@hellobox.app>");
    expect(mime).toContain("Subject: Hi");
  });

  test("401 is an auth error, other failures say what the provider answered, secrets masked", async () => {
    await expect(provider({}, { status: 401, body: "nope" }).send(outgoing, "k")).rejects.toBeInstanceOf(CustomAuthError);
    const failure = await provider({}, { status: 422, body: "bad sk_live_1234" }).send(outgoing, "k").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CustomError);
    expect((failure as Error).message).toBe("The provider answered 422: bad <API_KEY>");
  });

  test("domains: typed, or listed by the provider", async () => {
    expect(await provider({ domains: ["example.com"] }, {}).listDomains()).toEqual([
      { id: "example.com", name: "example.com", status: "verified", sending: true, receiving: false },
    ]);
    const listed = provider(
      {
        spec: spec({}, {
          domains: { method: "GET", url: "https://x.example/domains", headers: {}, list: "data", name: "domain", verified: { path: "state", equals: "ok" } },
        }),
      },
      { body: JSON.stringify({ data: [{ domain: "Example.com", state: "ok" }, { domain: "new.example", state: "pending" }, { other: 1 }] }) },
    );
    expect(listed.capabilities.refreshDomains).toBe(true);
    expect(await listed.listDomains()).toEqual([
      { id: "example.com", name: "example.com", status: "verified", sending: true, receiving: false },
      { id: "new.example", name: "new.example", status: "pending", sending: false, receiving: false },
    ]);
  });
});

describe("a <NAME> in the host", () => {
  const context = (secrets: Record<string, string>) => ({ secrets: { API_KEY: "k", ...secrets }, message });

  test("finds the host part of an address template", async () => {
    const { templateHost } = await import("./spec");
    expect(templateHost("https://<REGION>.api.acme.com/v1/send?x=1")).toBe("<REGION>.api.acme.com");
    expect(templateHost("https://user:<PASS>@api.acme.com:8443/send")).toBe("api.acme.com");
    expect(templateHost("api.acme.com/send")).toBeNull();
  });

  test("must fill a whole label in the spec", () => {
    expect(checkSpec(spec({ url: "https://<REGION>.acme.example/send" })).ok).toBe(true);
    expect(checkSpec(spec({ url: "https://api-<REGION>.acme.example/send" })).ok).toBe(false);
    expect(checkSpec(spec({ url: "https://{{subject}}.acme.example/send" })).ok).toBe(false);
  });

  test("can't move the request to another domain", async () => {
    const send = spec({ url: "https://<REGION>.acme.example/send" }).send;
    expect((await buildRequest(send, context({ REGION: "eu-1" }))).url).toBe("https://eu-1.acme.example/send");
    for (const REGION of ["evil.com#", "evil.com/", "a.b", "user@evil.com", ""]) {
      await expect(buildRequest(send, context({ REGION }))).rejects.toBeInstanceOf(TemplateError);
    }
  });

  test("anywhere else, any value is fine", async () => {
    const send = spec({ url: "https://api.acme.example/<ACCOUNT>/send" }).send;
    expect((await buildRequest(send, context({ ACCOUNT: "a.b/c" }))).url).toBe("https://api.acme.example/a.b%2Fc/send");
  });
});
