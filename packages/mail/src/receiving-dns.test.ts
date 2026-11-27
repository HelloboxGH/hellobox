import { describe, expect, it } from "bun:test";
import type { CloudflareRecord, DnsRecord } from "@hellobox/providers";
import { applyHelloboxMx, type MxDns, planHelloboxMx, removeHelloboxMx } from "./receiving-dns";

const HOST = "mx.hellobox.example";

// A Cloudflare zone holding MX records, recording what was written.
function fake(initial: { content: string; priority: number }[], zone: string | null = "zone1") {
  let next = 0;
  const records: CloudflareRecord[] = initial.map((entry) => ({ id: `r${next++}`, type: "MX", ...entry }));
  const calls: string[] = [];
  const dns: MxDns = {
    async recordsAt(_domain, _type, name) {
      calls.push(`list:${name}`);
      return zone ? { zone, records: [...records] } : null;
    },
    async createRecord(_zone, record: DnsRecord) {
      calls.push(`create:${record.value}:${record.priority}`);
      records.push({ id: `r${next++}`, type: "MX", content: record.value, priority: record.priority });
    },
    async deleteRecord(_zone, id) {
      calls.push(`delete:${id}`);
      records.splice(records.findIndex((record) => record.id === id), 1);
    },
  };
  return { dns, calls, records };
}

describe("applyHelloboxMx", () => {
  it("adds ours when the name has no MX record", async () => {
    const { dns, records } = fake([]);
    expect(await applyHelloboxMx(dns, "acme.example", HOST, false)).toEqual({ status: "added" });
    expect(records.map((record) => record.content)).toEqual([HOST]);
  });

  it("asks before touching other records, and changes nothing", async () => {
    const { dns, calls } = fake([{ content: "aspmx.l.google.com", priority: 1 }]);
    expect(await applyHelloboxMx(dns, "acme.example", HOST, false)).toEqual({
      status: "needs-confirmation",
      existing: [{ value: "aspmx.l.google.com", priority: 1 }],
    });
    expect(calls.every((call) => call.startsWith("list"))).toBe(true);
  });

  it("replaces them once confirmed: ours goes in first, then theirs come out", async () => {
    const { dns, calls, records } = fake([
      { content: "aspmx.l.google.com", priority: 1 },
      { content: "alt1.aspmx.l.google.com.", priority: 5 },
    ]);
    expect(await applyHelloboxMx(dns, "acme.example", HOST, true)).toEqual({ status: "replaced" });
    expect(calls.filter((call) => !call.startsWith("list"))).toEqual([`create:${HOST}:10`, "delete:r0", "delete:r1"]);
    expect(records.map((record) => record.content)).toEqual([HOST]);
  });

  it("does nothing when ours is already there alone", async () => {
    const { dns, calls } = fake([{ content: `${HOST}.`, priority: 10 }]);
    expect(await applyHelloboxMx(dns, "acme.example", HOST, true)).toEqual({ status: "already" });
    expect(calls).toEqual(["list:acme.example"]);
  });

  it("keeps ours and drops the others when both are there", async () => {
    const { dns, records } = fake([
      { content: HOST, priority: 10 },
      { content: "mail.old.example", priority: 20 },
    ]);
    expect(await applyHelloboxMx(dns, "acme.example", HOST, false)).toMatchObject({ status: "needs-confirmation" });
    expect(await applyHelloboxMx(dns, "acme.example", HOST, true)).toEqual({ status: "replaced" });
    expect(records.map((record) => record.content)).toEqual([HOST]);
  });

  it("refuses when the zone isn't there", async () => {
    await expect(applyHelloboxMx(fake([], null).dns, "acme.example", HOST, true)).rejects.toThrow("couldn't find");
  });

  it("reads the exact name, not its parent", async () => {
    const { dns, calls } = fake([]);
    await planHelloboxMx(dns, "reply.acme.example", HOST);
    expect(calls).toEqual(["list:reply.acme.example"]);
  });
});

describe("removeHelloboxMx", () => {
  it("removes only ours", async () => {
    const { dns, records } = fake([
      { content: HOST, priority: 10 },
      { content: "aspmx.l.google.com", priority: 1 },
    ]);
    expect(await removeHelloboxMx(dns, "acme.example", HOST)).toBe(1);
    expect(records.map((record) => record.content)).toEqual(["aspmx.l.google.com"]);
  });
});
