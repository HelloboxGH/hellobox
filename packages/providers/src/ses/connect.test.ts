import { describe, expect, test } from "bun:test";
import { parseStackCallback, quickCreateUrl } from "./connect";
import { sesMessageIdHeader } from "./provider";

describe("quickCreateUrl", () => {
  test("fills the template parameters", () => {
    const url = new URL(
      quickCreateUrl({
        region: "eu-west-1",
        templatesBaseUrl: "https://hellobox-templates.s3.eu-north-1.amazonaws.com/templates/",
        connectionId: "11111111-2222-3333-4444-555555555555",
        externalId: "ext",
        connectToken: "tok",
        callbackUrl: "https://hellobox.app/api/aws/connect",
        brokerAccountId: "123456789012",
        route53: true,
      }),
    );
    expect(url.host).toBe("eu-west-1.console.aws.amazon.com");
    const params = new URLSearchParams(url.hash.split("?")[1]);
    expect(params.get("templateURL")).toBe(
      "https://hellobox-templates.s3.eu-north-1.amazonaws.com/templates/connect.yaml",
    );
    expect(params.get("stackName")).toBe("HelloBox-11111111");
    expect(params.get("param_ManageRoute53")).toBe("true");
    expect(params.get("param_HelloboxAccountId")).toBe("123456789012");
  });
});

describe("parseStackCallback", () => {
  const valid = {
    requestType: "Create",
    connectionId: "c1",
    connectToken: "t",
    roleArn: "arn:aws:iam::123456789012:role/hellobox/HelloBox-c1-Role-ABC",
    accountId: "123456789012",
    region: "eu-west-1",
  };

  test("accepts a stack's report", () => {
    expect(parseStackCallback(valid)).toEqual(valid as never);
  });

  test("rejects roles outside the hellobox path", () => {
    expect(parseStackCallback({ ...valid, roleArn: "arn:aws:iam::123456789012:role/Admin" })).toBeNull();
  });

  test("rejects malformed input", () => {
    expect(parseStackCallback({ ...valid, accountId: "nope" })).toBeNull();
    expect(parseStackCallback({ ...valid, requestType: "Other" })).toBeNull();
    expect(parseStackCallback(null)).toBeNull();
  });
});

describe("sesMessageIdHeader", () => {
  test("matches the host SES uses per region", () => {
    expect(sesMessageIdHeader("abc", "us-east-1")).toBe("<abc@email.amazonses.com>");
    expect(sesMessageIdHeader("abc", "eu-west-1")).toBe("<abc@eu-west-1.amazonses.com>");
  });
});
