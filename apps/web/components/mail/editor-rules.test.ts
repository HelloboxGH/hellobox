import { describe, expect, test } from "bun:test";
import { cleanEditorHtml, findLink, matchBlock, matchInline, splitLinks } from "./editor-rules";

describe("findLink", () => {
  test("links bare domains, www and full URLs", () => {
    expect(findLink("hellobox.app")).toEqual({ start: 0, text: "hellobox.app", href: "https://hellobox.app" });
    expect(findLink("www.example.co.uk/pricing?x=1")).toEqual({ start: 0, text: "www.example.co.uk/pricing?x=1", href: "https://www.example.co.uk/pricing?x=1" });
    expect(findLink("https://docs.aws.amazon.com/ses/")).toEqual({ start: 0, text: "https://docs.aws.amazon.com/ses/", href: "https://docs.aws.amazon.com/ses/" });
    expect(findLink("http://localhost:3000")?.href).toBe("http://localhost:3000");
  });

  test("leaves sentence punctuation outside the link", () => {
    expect(findLink("hellobox.app.")?.text).toBe("hellobox.app");
    expect(findLink("hellobox.app,")?.text).toBe("hellobox.app");
    expect(findLink("(hellobox.app)")).toEqual({ start: 1, text: "hellobox.app", href: "https://hellobox.app" });
    expect(findLink('"hellobox.app"')?.text).toBe("hellobox.app");
    expect(findLink("en.wikipedia.org/wiki/Mail_(protocol)")?.text).toBe("en.wikipedia.org/wiki/Mail_(protocol)");
  });

  test("links email addresses as mailto", () => {
    expect(findLink("ada@example.com")).toEqual({ start: 0, text: "ada@example.com", href: "mailto:ada@example.com" });
  });

  test("ignores file names, abbreviations and plain words", () => {
    for (const word of ["notes.txt", "invoice.pdf", "e.g.", "i.e.", "hello", "3.14", "v1.2.3", "Mr.", "a.b", "@acme.com"]) {
      expect(findLink(word)).toBeNull();
    }
    expect(findLink("example.com/report.pdf")?.href).toBe("https://example.com/report.pdf");
  });
});

describe("splitLinks", () => {
  test("splits text into plain runs and links", () => {
    expect(splitLinks("See hellobox.app. Or mail ada@example.com!")).toEqual([
      { text: "See " },
      { text: "hellobox.app", href: "https://hellobox.app" },
      { text: ". Or mail " },
      { text: "ada@example.com", href: "mailto:ada@example.com" },
      { text: "!" },
    ]);
    expect(splitLinks("(see hellobox.app)")).toEqual([{ text: "(see " }, { text: "hellobox.app", href: "https://hellobox.app" }, { text: ")" }]);
    expect(splitLinks("nothing here")).toEqual([{ text: "nothing here" }]);
  });
});

describe("matchInline", () => {
  test("bold, italic, code, strike", () => {
    expect(matchInline("say **hi**")).toEqual({ start: 4, tag: "strong", text: "hi" });
    expect(matchInline("say __hi__")).toEqual({ start: 4, tag: "strong", text: "hi" });
    expect(matchInline("say *hi*")).toEqual({ start: 4, tag: "em", text: "hi" });
    expect(matchInline("say _hi there_")).toEqual({ start: 4, tag: "em", text: "hi there" });
    expect(matchInline("run `bun test`")).toEqual({ start: 4, tag: "code", text: "bun test" });
    expect(matchInline("~~old~~")).toEqual({ start: 0, tag: "s", text: "old" });
  });

  test("links", () => {
    expect(matchInline("read [the guide](hellobox.app/guides)")).toEqual({ start: 5, tag: "a", text: "the guide", href: "https://hellobox.app/guides" });
    expect(matchInline("[x](not a link)")).toBeNull();
  });

  test("waits for the closing marker and ignores stray ones", () => {
    expect(matchInline("say **hi*")).toBeNull();
    expect(matchInline("2 * 3 *")).toBeNull();
    expect(matchInline("snake_case_name")).toBeNull();
    expect(matchInline("** nope**")).toBeNull();
    expect(matchInline("\\*escaped*")).toBeNull();
  });
});

describe("matchBlock", () => {
  test("headings, lists, quotes and code", () => {
    expect(matchBlock("#")).toEqual({ command: "formatBlock", value: "h1" });
    expect(matchBlock("###")).toEqual({ command: "formatBlock", value: "h3" });
    expect(matchBlock("-")).toEqual({ command: "insertUnorderedList" });
    expect(matchBlock("1.")).toEqual({ command: "insertOrderedList" });
    expect(matchBlock(">")).toEqual({ command: "formatBlock", value: "blockquote" });
    expect(matchBlock("```")).toEqual({ command: "formatBlock", value: "pre" });
    expect(matchBlock("####")).toBeNull();
    expect(matchBlock("hi")).toBeNull();
  });
});

test("cleanEditorHtml drops caret placeholders", () => {
  expect(cleanEditorHtml("<strong>hi</strong>\u200B there")).toBe("<strong>hi</strong> there");
});
