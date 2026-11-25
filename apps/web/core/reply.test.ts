import { expect, test } from "bun:test";
import { replyAddresses } from "./reply";

const inbound = { direction: "inbound", fromAddress: "old@customer.test", replyTo: [], toRecipients: [{ address: "support@acme.test" }] };
const customer = { verified: true, email: "new@customer.test" };

test("a verified customer's newest address gets the reply", () => {
  expect(replyAddresses({ ...inbound, fromCustomer: true }, customer)).toEqual(["new@customer.test"]);
});

test("everyone else is answered where they wrote from", () => {
  expect(replyAddresses({ ...inbound, fromCustomer: true }, { ...customer, verified: false })).toEqual(["old@customer.test"]);
  // Someone else writing into the conversation never gets the customer's address, or the other way round.
  expect(replyAddresses({ ...inbound, fromAddress: "other@x.test" }, customer)).toEqual(["other@x.test"]);
  expect(replyAddresses({ ...inbound, replyTo: ["list@x.test"] }, null)).toEqual(["list@x.test"]);
  expect(replyAddresses({ ...inbound, direction: "outbound" }, customer)).toEqual(["support@acme.test"]);
});
