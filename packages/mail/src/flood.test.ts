import { describe, expect, test } from "bun:test";
import Redis from "ioredis";
import { assessInbound, FLOOD_LIMITS, floodVerdict } from "./flood";
import { countedBytes } from "./quarantine";

const quiet = { sender: 1, senderHour: 1, unknown: 0, quarantinedBytes: 0 };
const stranger = { unknownRecipient: false, knownSender: false };

describe("floodVerdict", () => {
  test("lets ordinary mail through", () => {
    expect(floodVerdict(quiet, stranger)).toEqual({ kind: "normal" });
  });

  test("always quarantines mail to an address with no mailbox", () => {
    expect(floodVerdict(quiet, { unknownRecipient: true, knownSender: false }).kind).toBe("quarantine");
  });

  test("quarantines a new sender's burst, then stops storing it", () => {
    const burst = { ...quiet, sender: FLOOD_LIMITS.senderQuarantine.max + 1, senderHour: FLOOD_LIMITS.senderQuarantine.max + 1 };
    expect(floodVerdict(burst, stranger).kind).toBe("quarantine");
    expect(floodVerdict({ ...burst, senderHour: FLOOD_LIMITS.senderDrop.max + 1 }, stranger).kind).toBe("drop");
  });

  test("never holds back a sender the workspace already knows", () => {
    const burst = { ...quiet, sender: 10_000, senderHour: 10_000, quarantinedBytes: FLOOD_LIMITS.quarantineBytes.max };
    expect(floodVerdict(burst, { unknownRecipient: false, knownSender: true })).toEqual({ kind: "normal" });
  });

  test("drops what doesn't fit once the day's quarantine is full", () => {
    const full = { ...quiet, quarantinedBytes: FLOOD_LIMITS.quarantineBytes.max };
    expect(floodVerdict(full, { unknownRecipient: true, knownSender: false }).kind).toBe("drop");
    expect(floodVerdict(full, stranger).kind).toBe("drop");
  });

  test("stops storing a flood of mail to unknown addresses", () => {
    expect(floodVerdict({ ...quiet, unknown: FLOOD_LIMITS.unknownDrop.max + 1 }, { unknownRecipient: true, knownSender: false }).kind).toBe("drop");
  });
});

test("fails open without Redis, except mail to unknown addresses stays quarantined", async () => {
  const broken = { multi: () => ({ incr() { return this; }, expire() { return this; }, incrby() { return this; }, get() { return this; }, exec: async () => { throw new Error("down"); } }) } as unknown as Redis;
  expect(await assessInbound({ workspaceId: "w", fromAddress: "a@b.test", unknownRecipient: false }, broken)).toEqual({ kind: "normal" });
  expect((await assessInbound({ workspaceId: "w", fromAddress: "a@b.test", unknownRecipient: true }, broken)).kind).toBe("quarantine");
});

test("deleting quarantined mail gives back only what was counted", () => {
  expect(countedBytes([{ size: 100, counted: true }, { size: 50, counted: false }], [{ size: 10, counted: false }])).toBe(100);
});

// Needs Redis, and a database for the "is this sender known" check past the limit.
const redisUrl = process.env.REDIS_URL;
describe.skipIf(!redisUrl || !process.env.DATABASE_URL)("assessInbound against Redis", () => {
  test("quarantines a new domain once it passes the limit", async () => {
    const client = new Redis(redisUrl as string);
    const workspaceId = crypto.randomUUID();
    const verdicts = [];
    for (let n = 0; n <= FLOOD_LIMITS.senderQuarantine.max; n += 1) {
      verdicts.push((await assessInbound({ workspaceId, fromAddress: `x${n}@flood.test`, unknownRecipient: false }, client)).kind);
    }
    // Rotating addresses doesn't help: the whole domain is counted.
    expect(verdicts.slice(0, -1).every((kind) => kind === "normal")).toBe(true);
    expect(verdicts.at(-1)).toBe("quarantine");
    await client.quit();
  });
});
