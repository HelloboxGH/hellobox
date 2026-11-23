import { describe, expect, test } from "bun:test";
import { parseGmailLabels, placementFor, readMbox } from "./mbox";

function streamOf(text: string, chunk = 7) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      // Small chunks, so lines are split across reads.
      for (let i = 0; i < bytes.length; i += chunk) controller.enqueue(bytes.slice(i, i + chunk));
      controller.close();
    },
  });
}

async function emails(text: string) {
  const out: string[] = [];
  for await (const entry of readMbox(streamOf(text))) {
    if (entry.kind === "email") out.push(new TextDecoder().decode(entry.raw));
  }
  return out;
}

describe("readMbox", () => {
  test("splits a Gmail export and unescapes >From", async () => {
    const mbox = [
      "From 1785000000000000001@xxx Wed Oct 18 08:51:23 +0000 2023",
      "X-Gmail-Labels: Inbox,Starred",
      "Subject: one",
      "",
      "Hello",
      ">From the archives",
      "",
      "From 1785000000000000002@xxx Thu Oct 19 08:51:23 +0000 2023",
      "Subject: two",
      "",
      "From here on it's body text, not a separator",
      "",
    ].join("\n");
    const result = await emails(mbox);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe("X-Gmail-Labels: Inbox,Starred\nSubject: one\n\nHello\nFrom the archives");
    expect(result[1]).toContain("From here on it's body text");
  });

  test("reads a file with no separator as one email", async () => {
    expect(await emails("Subject: just one\r\n\r\nBody\r\n")).toEqual(["Subject: just one\r\n\r\nBody\r"]);
  });

  test("reports how far it got", async () => {
    const text = "From a@b Mon Jan  1 00:00:00 2024\nSubject: x\n\nbody\n";
    let last = 0;
    for await (const entry of readMbox(streamOf(text))) last = entry.offset;
    expect(last).toBe(new TextEncoder().encode(text).length);
  });
});

describe("Gmail labels", () => {
  test("parses quoted labels", () => {
    expect(parseGmailLabels('Inbox,"Work, clients",Starred')).toEqual(["Inbox", "Work, clients", "Starred"]);
  });

  test("maps labels to where the email goes", () => {
    const placed = placementFor("Archived,Sent,Unread,Category Promotions,Projects/2024", false);
    expect(placed).toMatchObject({ folder: "archive", sent: true, unread: true, category: "newsletters", labels: ["Projects/2024"] });
    expect(placementFor("Spam", false).folder).toBe("spam");
    expect(placementFor("Inbox,Trash", false).folder).toBe("trash");
    expect(placementFor("Drafts", false).skip).toBe(true);
  });

  test("without labels, mail from the mailbox's own address counts as sent", () => {
    expect(placementFor(undefined, true)).toMatchObject({ sent: true, folder: "archive", unread: false });
    expect(placementFor(undefined, false).sent).toBe(false);
  });
});
