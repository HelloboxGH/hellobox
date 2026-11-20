import { describe, expect, test } from "bun:test";
import { guessColumnRole, parseCsv, splitFullName } from "./csv";
import {
  addUnsubscribeFooter,
  compileBroadcast,
  compileBroadcastSubject,
  hasBodySlot,
  insertTemplate,
  isFieldKey,
  RESEND_UNSUBSCRIBE_TAG,
  renderSubject,
  renderTemplate,
  TemplateError,
  templateVariables,
  toFieldKey,
} from "./template";

const ada = {
  email: "ada@example.com",
  first_name: "Ada",
  last_name: "Lovelace",
  fields: { company: "Analytical Engines", plan: "pro" },
};

describe("renderTemplate", () => {
  test("prints contact fields, custom fields and values", () => {
    const html = renderTemplate(
      "<p>Hi {{ contact.first_name }} {{contact.last_name}} ({{ contact.email }}) at {{ contact.company }}: {{ headline }}</p>",
      { contact: ada, values: { headline: "Big news" } },
    );
    expect(html).toBe("<p>Hi Ada Lovelace (ada@example.com) at Analytical Engines: Big news</p>");
  });

  test("escapes printed values by default", () => {
    const html = renderTemplate("<p title=\"{{ x }}\">{{ contact.first_name }}</p>", {
      contact: { ...ada, first_name: "<script>alert('x')</script>" },
      values: { x: '" onmouseover="steal()' },
    });
    expect(html).toBe(
      "<p title=\"&quot; onmouseover=&quot;steal()\">&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;</p>",
    );
  });

  test("safe prints a value as HTML", () => {
    expect(renderTemplate("{{ body | safe }}", { values: { body: "<b>Hi</b>" } })).toBe("<b>Hi</b>");
  });

  test("default, upper, lower, capitalize and trim", () => {
    expect(renderTemplate('{{ contact.first_name | default("there") }}', { contact: { email: "a@b.c" } })).toBe("there");
    expect(renderTemplate('{{ contact.first_name | default("there") }}', { contact: ada })).toBe("Ada");
    expect(renderTemplate("{{ contact.first_name | upper }}", { contact: ada })).toBe("ADA");
    expect(renderTemplate("{{ x | trim | capitalize }}", { values: { x: "  hello " } })).toBe("Hello");
    expect(renderTemplate("{{ x | lower }}", { values: { x: "HeLLo" } })).toBe("hello");
    expect(renderTemplate("{{ x | default('<none>') }}")).toBe("&lt;none&gt;");
  });

  test("missing values print nothing", () => {
    expect(renderTemplate("[{{ nothing }}][{{ contact.unknown }}]", { contact: ada })).toBe("[][]");
  });

  test("conditionals", () => {
    const source =
      '{% if contact.plan == "pro" %}Pro{% elif contact.plan == "team" %}Team{% else %}Free{% endif %}';
    expect(renderTemplate(source, { contact: ada })).toBe("Pro");
    expect(renderTemplate(source, { contact: { ...ada, fields: { plan: "team" } } })).toBe("Team");
    expect(renderTemplate(source, { contact: { email: "x@y.z" } })).toBe("Free");
    expect(renderTemplate("{% if not promo %}none{% endif %}")).toBe("none");
    expect(renderTemplate("{% if a and (b or c) %}yes{% else %}no{% endif %}", { values: { a: "1", c: "1" } })).toBe("yes");
    expect(renderTemplate("{% if a and b or c %}yes{% else %}no{% endif %}", { values: { c: "1" } })).toBe("yes");
    expect(renderTemplate('{% if x != "" %}set{% endif %}', { values: { x: " " } })).toBe("");
  });

  test("nested conditionals", () => {
    const source = "{% if a %}A{% if b %}B{% endif %}{% else %}-{% endif %}";
    expect(renderTemplate(source, { values: { a: "1", b: "1" } })).toBe("AB");
    expect(renderTemplate(source, { values: { a: "1" } })).toBe("A");
    expect(renderTemplate(source)).toBe("-");
  });

  test("comments and raw blocks", () => {
    expect(renderTemplate("a{# hidden {{ x }} #}b")).toBe("ab");
    expect(renderTemplate("{% raw %}{{ contact.email }}{% endraw %}", { contact: ada })).toBe("{{ contact.email }}");
  });

  test("plain braces in CSS are left alone", () => {
    const css = "<style>p { color: red; }</style>";
    expect(renderTemplate(css)).toBe(css);
  });

  test("rejects anything that isn't part of the language", () => {
    const bad = [
      "{{ x",
      "{% if x %}open",
      "{% endif %}",
      "{% for x in y %}{% endfor %}",
      "{{ x | evil }}",
      "{{ constructor.prototype }}",
      "{{ x.__proto__ }}",
      "{{ x() }}",
      "{{ }}",
      "{% if %}x{% endif %}",
      "{% if x %}a{% else y %}b{% endif %}",
      "{{ x | default(y) }}",
      "{{{ RESEND_UNSUBSCRIBE_URL }}}",
    ];
    for (const source of bad) expect(() => renderTemplate(source)).toThrow(TemplateError);
  });

  test("errors name the line", () => {
    expect(() => renderTemplate("one\ntwo\n{{ x | nope }}")).toThrow("Line 3:");
  });

  test("reports what a template uses", () => {
    expect(
      templateVariables(
        "{{ contact.first_name }}{% if promo %}{{ code }}{% endif %}{{ unsubscribe_url }}{% if contact.plan %}{% endif %}",
      ),
    ).toEqual({ values: ["promo", "code"], contactFields: ["first_name", "plan"], usesUnsubscribe: true });
  });
});

describe("insertTemplate", () => {
  const written = "<p>Thanks for the call & the notes.</p>";

  test("puts what's written where the template says {{ body }}, unescaped", () => {
    const source = "<h1>Hi {{ contact.first_name }}</h1>{{ body }}<footer>Ada Co</footer>";
    expect(hasBodySlot(source)).toBe(true);
    expect(insertTemplate(source, { contact: ada, body: written })).toBe(
      `<h1>Hi Ada</h1>${written}<footer>Ada Co</footer>`,
    );
  });

  test("puts what's written below a template without a slot", () => {
    expect(hasBodySlot("<h1>Hello</h1>")).toBe(false);
    expect(insertTemplate("<h1>Hello</h1>", { body: written })).toBe(`<h1>Hello</h1>${written}`);
    expect(insertTemplate("<html><body><h1>Hello</h1></body></html>", { body: written })).toBe(
      `<html><body><h1>Hello</h1>${written}</body></html>`,
    );
  });

  test("leaves an empty email's template as it is", () => {
    expect(insertTemplate("<h1>Hello</h1>{% if body %}<hr>{% endif %}{{ body }}", { body: "" })).toBe("<h1>Hello</h1>");
  });

  test("keeps body an ordinary value where there's no email text, as in campaigns", () => {
    expect(renderTemplate("{{ body }}", { values: { body: "<b>x</b>" } })).toBe("&lt;b&gt;x&lt;/b&gt;");
    expect(compileBroadcast("{{ body }}", { body: "Hi" })).toBe("Hi");
  });
});

describe("compileBroadcast", () => {
  test("turns contact fields into Resend merge tags", () => {
    expect(compileBroadcast('Hi {{ contact.first_name | default("there") }} at {{ contact.company }}')).toBe(
      "Hi {{{contact.first_name|there}}} at {{{contact.company}}}",
    );
  });

  test("fills in values and escapes them, braces included", () => {
    expect(compileBroadcast("{{ x }}", { x: "<b>{{{contact.email}}}</b>" })).toBe(
      "&lt;b&gt;&#123;&#123;&#123;contact.email&#125;&#125;&#125;&lt;/b&gt;",
    );
    expect(compileBroadcast("{{ x | safe }}", { x: "<b>{{{RESEND_UNSUBSCRIBE_URL}}}</b>" })).toBe(
      "<b>&#123;&#123;&#123;RESEND_UNSUBSCRIBE_URL&#125;&#125;&#125;</b>",
    );
  });

  test("keeps fallbacks from breaking out of the merge tag", () => {
    expect(compileBroadcast('{{ contact.first_name | default("a}}}|<b>") }}')).toBe(
      "{{{contact.first_name|a&lt;b&gt;}}}",
    );
  });

  test("uses Resend's unsubscribe link", () => {
    expect(compileBroadcast('<a href="{{ unsubscribe_url }}">Leave</a>')).toBe(
      `<a href="${RESEND_UNSUBSCRIBE_TAG}">Leave</a>`,
    );
  });

  test("conditions on values work, conditions on contacts can't", () => {
    expect(compileBroadcast("{% if promo %}{{ promo }}{% endif %}", { promo: "SAVE" })).toBe("SAVE");
    expect(() => compileBroadcast("{% if contact.plan %}x{% endif %}")).toThrow(TemplateError);
    expect(() => compileBroadcast("{{ contact.first_name | upper }}")).toThrow(TemplateError);
  });
});

describe("unsubscribe footer", () => {
  test("is always added before </body>", () => {
    const html = addUnsubscribeFooter("<html><body><p>Hi</p></BODY></html>", RESEND_UNSUBSCRIBE_TAG, "Acme <news@acme.com>");
    expect(html).toContain(`href="${RESEND_UNSUBSCRIBE_TAG}"`);
    expect(html).toContain("Acme &lt;news@acme.com&gt;");
    expect(html.indexOf("Unsubscribe")).toBeLessThan(html.indexOf("</BODY>"));
  });

  test("is added even when the template has its own link", () => {
    const body = compileBroadcast('<a href="{{ unsubscribe_url }}">Leave</a>');
    const html = addUnsubscribeFooter(body, RESEND_UNSUBSCRIBE_TAG, "Acme");
    expect(html.split(RESEND_UNSUBSCRIBE_TAG)).toHaveLength(3);
  });

  test("appends when there's no body tag", () => {
    expect(addUnsubscribeFooter("<p>Hi</p>", "https://u", "Acme")).toStartWith("<p>Hi</p><div");
  });
});

describe("subjects", () => {
  test("are plain text", () => {
    expect(renderSubject("News for {{ contact.first_name }} & {{ x }}", { contact: ada, values: { x: "<you>" } })).toBe(
      "News for Ada & <you>",
    );
  });

  test("campaign subjects only take values", () => {
    expect(compileBroadcastSubject("{{ issue }} news", { issue: "May" })).toBe("May news");
    expect(() => compileBroadcastSubject("Hi {{ contact.first_name }}")).toThrow(TemplateError);
  });
});

describe("field keys", () => {
  test("are made from column headers", () => {
    expect(toFieldKey("Company Name")).toBe("company_name");
    expect(toFieldKey("  2nd phone #")).toBe("nd_phone");
    expect(isFieldKey("company_name")).toBe(true);
    expect(isFieldKey("email")).toBe(false);
    expect(isFieldKey("Company")).toBe(false);
    expect(isFieldKey("")).toBe(false);
  });
});

describe("csv", () => {
  test("parses quotes, escaped quotes and line breaks", () => {
    expect(parseCsv('email,name\r\na@b.c,"Lovelace, Ada"\n"x@y.z","Say ""hi""\nthere"\n\n')).toEqual([
      ["email", "name"],
      ["a@b.c", "Lovelace, Ada"],
      ["x@y.z", 'Say "hi"\nthere'],
    ]);
  });

  test("detects semicolons and strips a BOM", () => {
    expect(parseCsv("﻿email;first\na@b.c;Ada")).toEqual([
      ["email", "first"],
      ["a@b.c", "Ada"],
    ]);
  });

  test("guesses what columns hold", () => {
    expect(guessColumnRole("E-mail Address")).toBe("email");
    expect(guessColumnRole("first_name")).toBe("first_name");
    expect(guessColumnRole("Surname")).toBe("last_name");
    expect(guessColumnRole("Name")).toBe("full_name");
    expect(guessColumnRole("Company")).toBe("field");
    expect(splitFullName(" Ada  King Lovelace ")).toEqual({ first: "Ada", last: "King Lovelace" });
  });
});
