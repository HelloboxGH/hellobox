import { expect, test } from "bun:test";
import type { CustomEvent, CustomSpec } from "@hellobox/providers";
import { handleCustomEvents } from "./custom";

const spec = {
  version: 1,
  name: "Acme",
  send: { method: "POST", url: "https://x.example", headers: {} },
  events: { verify: { type: "token", header: "X-Token", secret: "<HOOK>" }, type: "event", map: { delivered: "delivered" }, id: "id" },
} as CustomSpec;

function steps(withEvents = true) {
  const recorded: CustomEvent[] = [];
  return {
    recorded,
    steps: {
      load: async (id: string) => (id === "c1" ? { token: "key", spec: withEvents ? spec : { ...spec, events: null }, secrets: { HOOK: "shh" } } : null),
      recordEvent: async (_id: string, event: CustomEvent) => {
        recorded.push(event);
      },
    },
  };
}
const body = new TextEncoder().encode('[{"event":"delivered","id":"p-1"}]');

test("records events with our key and the provider's token", async () => {
  const { steps: s, recorded } = steps();
  expect(await handleCustomEvents("c1", { key: "key", headers: { "x-token": "shh" }, body }, s)).toEqual({ status: 200 });
  expect(recorded.map((event) => [event.type, event.messageId])).toEqual([["email.delivered", "p-1"]]);
});

test("refuses a wrong key, a wrong token, an unknown connection, and a spec without events", async () => {
  expect((await handleCustomEvents("c1", { key: "nope", headers: { "x-token": "shh" }, body }, steps().steps)).status).toBe(401);
  expect((await handleCustomEvents("c1", { key: "key", headers: { "x-token": "no" }, body }, steps().steps)).status).toBe(401);
  expect((await handleCustomEvents("c2", { key: "key", headers: {}, body }, steps().steps)).status).toBe(404);
  expect((await handleCustomEvents("c1", { key: "key", headers: {}, body }, steps(false).steps)).status).toBe(404);
});

test("a body that isn't JSON is a 400", async () => {
  const result = await handleCustomEvents("c1", { key: "key", headers: { "x-token": "shh" }, body: new TextEncoder().encode("nope") }, steps().steps);
  expect(result.status).toBe(400);
});
