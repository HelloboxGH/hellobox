import { describe, expect, test } from "bun:test";
import { receivePushedEmail } from "./pushed";

const email = {
  connectionId: "c_1",
  workspaceId: "w_1",
  emailId: "<abc@mail.example>",
  providerEventId: "evt_1",
  raw: new TextEncoder().encode("Subject: Hi\r\n\r\nHello"),
};

function recorder(fail?: "store" | "record" | "enqueue") {
  const calls: string[] = [];
  const step = (name: "store" | "record" | "enqueue", detail: string) => {
    calls.push(`${name}:${detail}`);
    if (fail === name) throw new Error(`${name} failed`);
  };
  return {
    calls,
    steps: {
      store: async (key: string) => step("store", key),
      record: async (input: { emailId: string }) => step("record", input.emailId),
      enqueue: async (_connectionId: string, emailId: string) => step("enqueue", emailId),
    },
  };
}

describe("receivePushedEmail", () => {
  test("stores the raw email before saving the event and queueing ingest", async () => {
    const { calls, steps } = recorder();
    const result = await receivePushedEmail(email, steps);
    expect(result.emailId).toBe("_abc_mail.example_");
    expect(calls).toEqual([
      "store:workspaces/w_1/inbound/c_1/_abc_mail.example_.eml",
      "record:_abc_mail.example_",
      "enqueue:_abc_mail.example_",
    ]);
  });

  test("a storage failure stops everything and reaches the webhook", async () => {
    const { calls, steps } = recorder("store");
    await expect(receivePushedEmail(email, steps)).rejects.toThrow("store failed");
    expect(calls).toEqual(["store:workspaces/w_1/inbound/c_1/_abc_mail.example_.eml"]);
  });

  test("a queue failure reaches the webhook too, after the email is safe", async () => {
    const { calls, steps } = recorder("enqueue");
    await expect(receivePushedEmail(email, steps)).rejects.toThrow("enqueue failed");
    expect(calls).toHaveLength(3);
  });
});
