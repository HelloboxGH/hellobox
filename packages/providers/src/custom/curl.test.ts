import { describe, expect, test } from "bun:test";
import { CurlError, likelyKeys, parseCurl, replaceValue, shellWords, specFromCurl } from "./curl";
import { buildRequest } from "./request";
import { checkSpec } from "./spec";
import { SAMPLE_MESSAGE } from "./template";

describe("shellWords", () => {
  test("quotes, escapes and continuations", () => {
    expect(shellWords(`curl -H 'A: b c' "x \\"y\\"" \\\n  $'line\\none' plain\\ word`)).toEqual([
      "curl",
      "-H",
      "A: b c",
      'x "y"',
      "line\none",
      "plain word",
    ]);
  });

  test("an open quote is an error", () => {
    expect(() => shellWords("curl 'oops")).toThrow(CurlError);
  });
});

describe("parseCurl", () => {
  test("a JSON send, as in most providers' docs", () => {
    const send = parseCurl(`curl --request POST \\
      --url https://api.acme.example/v1/send \\
      --header 'Authorization: Bearer <API_KEY>' \\
      --header 'Content-Type: application/json' \\
      --data '{"from":"a@example.com","to":["b@example.org"],"subject":"Hi"}'`);
    expect(send).toEqual({
      method: "POST",
      url: "https://api.acme.example/v1/send",
      headers: { Authorization: "Bearer <API_KEY>" },
      body: { type: "json", content: { from: "a@example.com", to: ["b@example.org"], subject: "Hi" } },
    });
  });

  test("--json sets Accept, and short forms stick to their values", () => {
    const send = parseCurl(`curl -sS -XPUT -H'X-Key: <KEY>' https://x.example/send --json '{"a":1}'`);
    expect(send.method).toBe("PUT");
    expect(send.headers).toEqual({ "X-Key": "<KEY>", Accept: "application/json" });
    expect(send.body).toEqual({ type: "json", content: { a: 1 } });
  });

  test("-u becomes Basic auth, and -d a form with repeated fields", () => {
    const user = "--user 'api:<API_KEY>'"; // gitleaks:allow (a placeholder, not a key)
    const send = parseCurl(`curl -s ${user} https://api.mailgun.net/v3/<DOMAIN>/messages \\
      -F from='Excited User <mailgun@<DOMAIN>>' -F to=a@example.com -F to=b@example.com -F attachment=@files/a.pdf`);
    expect(send.auth).toEqual({ type: "basic", username: "api", password: "<API_KEY>" });
    expect(send.body).toEqual({
      type: "multipart",
      content: { from: "Excited User <mailgun@<DOMAIN>>", to: ["a@example.com", "b@example.com"], attachment: "{{attachments}}" },
    });
    const form = parseCurl(`curl https://x.example -d to=a@example.com -d to=b@example.com --data-urlencode 'subject=Hi there'`);
    expect(form).toMatchObject({ method: "POST", body: { type: "form", content: { to: ["a@example.com", "b@example.com"], subject: "Hi there" } } });
  });

  test("refuses what it can't do, by name", () => {
    expect(() => parseCurl("curl --cert me.pem https://x.example")).toThrow("--cert isn't supported");
    expect(() => parseCurl("curl -L https://x.example")).toThrow("never follows redirects");
    expect(() => parseCurl("curl http://x.example")).toThrow("https://");
    expect(() => parseCurl("curl https://x.example -d @body.json")).toThrow("reads a file");
    expect(() => parseCurl("curl https://x.example -d a=1 -F b=2")).toThrow("mixes body options");
    expect(() => parseCurl("wget https://x.example")).toThrow("starts with curl");
  });

  test("makes a spec that checks out and builds", async () => {
    const spec = specFromCurl(`curl https://api.acme.example/v1/send -H 'Authorization: Bearer <API_KEY>' --json '{"subject":"{{subject}}"}'`);
    expect(spec.name).toBe("Acme");
    const check = checkSpec(spec);
    expect(check.ok).toBe(true);
    const request = await buildRequest(spec.send, { secrets: { API_KEY: "k" }, message: SAMPLE_MESSAGE });
    expect(JSON.parse(new TextDecoder().decode(request.body))).toEqual({ subject: "Re: Your question" });
  });

  test("Basic auth is encoded with the values in", async () => {
    const send = parseCurl("curl -u 'api:<API_KEY>' https://x.example"); // gitleaks:allow (a placeholder, not a key)
    const request = await buildRequest(send, { secrets: { API_KEY: "secret" }, message: SAMPLE_MESSAGE });
    expect(request.headers.Authorization).toBe(`Basic ${btoa("api:secret")}`);
  });
});

describe("likelyKeys", () => {
  test("flags real-looking keys, not placeholders or addresses", () => {
    const spec = {
      headers: { Authorization: "Bearer re_123456789abcdefghijkl", Other: "Bearer <API_KEY>" },
      url: "https://api.acme.example/v3/accounts/messages/send-a-long-path-name",
      body: { token: "a8f5f167f44f4964e6c998dee827110c", note: "hello" }, // gitleaks:allow (made-up token)
    };
    expect(likelyKeys(spec).map((item) => item.where)).toEqual(["headers.Authorization", "body.token"]);
  });

  test("replaceValue swaps a key for its name", () => {
    expect(replaceValue({ a: ["Bearer re_x"] }, "re_x", "<API_KEY>")).toEqual({ a: ["Bearer <API_KEY>"] });
  });
});
