// Templates for campaigns and emails, in a small Jinja-like language. Nothing in a
// template can run code: it only prints values, picks between branches and applies a
// fixed set of filters. Printed values are HTML-escaped unless marked `safe`.
//
//   {{ contact.first_name | default("there") }}   a contact field, with a fallback
//   {{ headline }}                                a value filled in when sending
//   {% if plan == "pro" %}...{% elif x %}...{% else %}...{% endif %}
//   {{ unsubscribe_url }}                         the recipient's unsubscribe link
//   {{ body }}                                    in an email, what was already written
//   {# a comment #}   {% raw %}{{ printed as is }}{% endraw %}
//
// No imports, so the browser can use it for previews.

export const CONTACT_BUILTINS = ["email", "first_name", "last_name"] as const;
export const UNSUBSCRIBE_VARIABLE = "unsubscribe_url";
// Where an email's own text goes when a template is inserted into it. Campaigns have no
// text of their own, so there it stays an ordinary value to fill in.
export const BODY_VARIABLE = "body";
// Resend fills these in per recipient when it sends a broadcast.
export const RESEND_UNSUBSCRIBE_TAG = "{{{RESEND_UNSUBSCRIBE_URL}}}";

const MAX_SOURCE = 1_000_000;
const MAX_DEPTH = 20;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FIELD_KEY = /^[a-z][a-z0-9_]{0,49}$/;

export class TemplateError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`Line ${line}: ${message}`);
    this.name = "TemplateError";
  }
}

// Custom field keys double as Resend contact property keys, which allow letters,
// digits and underscores up to 50 characters.
export const isFieldKey = (key: string) =>
  FIELD_KEY.test(key) && !(CONTACT_BUILTINS as readonly string[]).includes(key);

export function toFieldKey(label: string) {
  const key = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^[^a-z]+/, "")
    .replace(/_+$/, "")
    .slice(0, 50);
  return key;
}

type Path = { kind: "contact"; field: string } | { kind: "value"; name: string } | { kind: "unsubscribe" };
type Operand = { kind: "path"; path: Path } | { kind: "string"; value: string };
type Condition =
  | { kind: "or" | "and"; left: Condition; right: Condition }
  | { kind: "not"; operand: Condition }
  | { kind: "compare"; op: "==" | "!="; left: Operand; right: Operand }
  | { kind: "truthy"; operand: Operand };
type Filter =
  | { name: "default"; arg: string }
  | { name: "upper" | "lower" | "capitalize" | "trim" | "safe" };
type Node =
  | { kind: "text"; text: string }
  | { kind: "output"; path: Path; filters: Filter[]; line: number }
  | { kind: "if"; branches: { condition: Condition; body: Node[] }[]; otherwise: Node[]; line: number };

export interface TemplateContact {
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  fields?: Record<string, string>;
}

export interface TemplateData {
  contact?: TemplateContact | null;
  values?: Record<string, string>;
  unsubscribeUrl?: string;
  // HTML the person already wrote. Printed as is in place of {{ body }}.
  body?: string;
}

// Tokenizer.

type Token =
  | { kind: "text"; text: string; line: number }
  | { kind: "output" | "tag"; body: string; line: number };

function tokenize(source: string): Token[] {
  if (source.length > MAX_SOURCE) throw new TemplateError("The template is too long", 1);
  const tokens: Token[] = [];
  let index = 0;
  let line = 1;
  const advance = (to: number) => {
    for (let i = index; i < to; i++) if (source.charCodeAt(i) === 10) line++;
    index = to;
  };
  while (index < source.length) {
    const open = source.indexOf("{", index);
    const next = open === -1 ? -1 : findOpener(source, open);
    if (next === -1) {
      tokens.push({ kind: "text", text: source.slice(index), line });
      break;
    }
    if (next > index) {
      tokens.push({ kind: "text", text: source.slice(index, next), line });
      advance(next);
    }
    const opener = source.slice(index, index + 2);
    const closer = opener === "{{" ? "}}" : opener === "{%" ? "%}" : "#}";
    const end = opener === "{#" ? source.indexOf(closer, index + 2) : findCloser(source, index + 2, closer);
    if (end === -1) throw new TemplateError(`"${opener}" is never closed with "${closer}"`, line);
    const body = source.slice(index + 2, end);
    if (opener === "{%" && /^\s*raw\s*$/.test(body)) {
      const close = /\{%\s*endraw\s*%\}/g;
      close.lastIndex = end + 2;
      const found = close.exec(source);
      if (!found) throw new TemplateError(`"{% raw %}" is never closed with "{% endraw %}"`, line);
      tokens.push({ kind: "text", text: source.slice(end + 2, found.index), line });
      advance(found.index + found[0].length);
      continue;
    }
    if (opener === "{{") tokens.push({ kind: "output", body, line });
    else if (opener === "{%") tokens.push({ kind: "tag", body, line });
    advance(end + 2);
  }
  return tokens;
}

// Skips over quoted strings, so a fallback like default("}}") doesn't end the tag.
function findCloser(source: string, from: number, closer: string) {
  let quote: string | null = null;
  for (let i = from; i < source.length; i++) {
    const char = source[i];
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (source.startsWith(closer, i)) return i;
  }
  return -1;
}

function findOpener(source: string, from: number) {
  for (let i = from; i < source.length - 1; i++) {
    if (source[i] !== "{") continue;
    const next = source[i + 1];
    if (next === "{" || next === "%" || next === "#") return i;
  }
  return -1;
}

// Expressions.

type Lexeme = { kind: "name" | "string" | "op" | "punct"; value: string };

function lex(body: string, line: number): Lexeme[] {
  const out: Lexeme[] = [];
  let i = 0;
  while (i < body.length) {
    const char = body[i] as string;
    if (/\s/.test(char)) {
      i++;
      continue;
    }
    if (char === '"' || char === "'") {
      let value = "";
      let j = i + 1;
      while (j < body.length && body[j] !== char) {
        if (body[j] === "\\" && j + 1 < body.length) j++;
        value += body[j];
        j++;
      }
      if (j >= body.length) throw new TemplateError("A quoted string is never closed", line);
      out.push({ kind: "string", value });
      i = j + 1;
      continue;
    }
    const two = body.slice(i, i + 2);
    if (two === "==" || two === "!=") {
      out.push({ kind: "op", value: two });
      i += 2;
      continue;
    }
    if ("|().".includes(char)) {
      out.push({ kind: "punct", value: char });
      i++;
      continue;
    }
    const word = /^[A-Za-z0-9_]+/.exec(body.slice(i));
    if (!word) throw new TemplateError(`Unexpected "${char}"`, line);
    out.push({ kind: "name", value: word[0] });
    i += word[0].length;
  }
  return out;
}

class Cursor {
  private index = 0;
  constructor(
    private readonly lexemes: Lexeme[],
    readonly line: number,
  ) {}
  peek() {
    return this.lexemes[this.index];
  }
  take() {
    const lexeme = this.lexemes[this.index++];
    if (!lexeme) throw new TemplateError("The expression ends too early", this.line);
    return lexeme;
  }
  expect(kind: Lexeme["kind"], value?: string) {
    const lexeme = this.take();
    if (lexeme.kind !== kind || (value !== undefined && lexeme.value !== value)) {
      throw new TemplateError(`Expected ${value ? `"${value}"` : `a ${kind}`} but found "${lexeme.value}"`, this.line);
    }
    return lexeme;
  }
  isWord(value: string) {
    const lexeme = this.peek();
    return lexeme?.kind === "name" && lexeme.value === value;
  }
  done() {
    return this.index >= this.lexemes.length;
  }
  assertDone() {
    const rest = this.peek();
    if (rest) throw new TemplateError(`Unexpected "${rest.value}"`, this.line);
  }
}

function parsePath(cursor: Cursor): Path {
  const first = cursor.expect("name").value;
  if (first === "contact") {
    cursor.expect("punct", ".");
    const field = cursor.expect("name").value;
    if (!NAME.test(field)) throw new TemplateError(`"${field}" isn't a valid field name`, cursor.line);
    if (cursor.peek()?.value === ".") throw new TemplateError("Contact fields don't have fields of their own", cursor.line);
    return { kind: "contact", field };
  }
  if (!NAME.test(first)) throw new TemplateError(`"${first}" isn't a valid name`, cursor.line);
  if (cursor.peek()?.value === ".") {
    throw new TemplateError(`Only "contact" has fields. Did you mean "contact.${first}"?`, cursor.line);
  }
  return first === UNSUBSCRIBE_VARIABLE ? { kind: "unsubscribe" } : { kind: "value", name: first };
}

function parseOperand(cursor: Cursor): Operand {
  const lexeme = cursor.peek();
  if (lexeme?.kind === "string") return { kind: "string", value: cursor.take().value };
  return { kind: "path", path: parsePath(cursor) };
}

function parseCondition(cursor: Cursor): Condition {
  let left = parseAnd(cursor);
  while (cursor.isWord("or")) {
    cursor.take();
    left = { kind: "or", left, right: parseAnd(cursor) };
  }
  return left;
}

function parseAnd(cursor: Cursor): Condition {
  let left = parseNot(cursor);
  while (cursor.isWord("and")) {
    cursor.take();
    left = { kind: "and", left, right: parseNot(cursor) };
  }
  return left;
}

function parseNot(cursor: Cursor): Condition {
  if (cursor.isWord("not")) {
    cursor.take();
    return { kind: "not", operand: parseNot(cursor) };
  }
  if (cursor.peek()?.value === "(") {
    cursor.take();
    const inner = parseCondition(cursor);
    cursor.expect("punct", ")");
    return inner;
  }
  const left = parseOperand(cursor);
  const op = cursor.peek();
  if (op?.kind === "op") {
    cursor.take();
    return { kind: "compare", op: op.value as "==" | "!=", left, right: parseOperand(cursor) };
  }
  return { kind: "truthy", operand: left };
}

const SIMPLE_FILTERS = ["upper", "lower", "capitalize", "trim", "safe"] as const;

function parseOutput(body: string, line: number): Node {
  const cursor = new Cursor(lex(body, line), line);
  if (cursor.done()) throw new TemplateError("An empty {{ }} has nothing to print", line);
  const path = parsePath(cursor);
  const filters: Filter[] = [];
  while (!cursor.done()) {
    cursor.expect("punct", "|");
    const name = cursor.expect("name").value;
    if (name === "default") {
      cursor.expect("punct", "(");
      const arg = cursor.expect("string").value;
      cursor.expect("punct", ")");
      filters.push({ name: "default", arg });
    } else if ((SIMPLE_FILTERS as readonly string[]).includes(name)) {
      filters.push({ name: name as (typeof SIMPLE_FILTERS)[number] });
    } else {
      throw new TemplateError(`There's no "${name}" filter. Use default, upper, lower, capitalize, trim or safe`, line);
    }
  }
  if (path.kind === "unsubscribe" && filters.length) {
    throw new TemplateError("The unsubscribe link can't take filters", line);
  }
  return { kind: "output", path, filters, line };
}

// Parser.

export function parseTemplate(source: string): Node[] {
  const tokens = tokenize(source);
  let index = 0;

  const block = (depth: number, closers: string[]): { nodes: Node[]; closer: string | null; closerBody: string; line: number } => {
    if (depth > MAX_DEPTH) throw new TemplateError("Conditions are nested too deeply", tokens[index]?.line ?? 1);
    const nodes: Node[] = [];
    while (index < tokens.length) {
      const token = tokens[index++] as Token;
      if (token.kind === "text") {
        nodes.push({ kind: "text", text: token.text });
        continue;
      }
      if (token.kind === "output") {
        nodes.push(parseOutput(token.body, token.line));
        continue;
      }
      const body = token.body.trim();
      const keyword = /^[a-z]+/.exec(body)?.[0] ?? "";
      if (closers.includes(keyword)) return { nodes, closer: keyword, closerBody: body.slice(keyword.length), line: token.line };
      if (keyword !== "if") {
        throw new TemplateError(
          ["elif", "else", "endif", "endraw"].includes(keyword)
            ? `"{% ${keyword} %}" has no matching "{% if %}"`
            : `"{% ${body} %}" isn't a tag. Use if, elif, else, endif or raw`,
          token.line,
        );
      }
      const branches: { condition: Condition; body: Node[] }[] = [];
      let otherwise: Node[] = [];
      let conditionSource = body.slice(2);
      let conditionLine = token.line;
      for (;;) {
        const cursor = new Cursor(lex(conditionSource, conditionLine), conditionLine);
        if (cursor.done()) throw new TemplateError("This condition is empty", conditionLine);
        const condition = parseCondition(cursor);
        cursor.assertDone();
        const inner = block(depth + 1, ["elif", "else", "endif"]);
        branches.push({ condition, body: inner.nodes });
        if (inner.closer === null) throw new TemplateError(`"{% if %}" is never closed with "{% endif %}"`, token.line);
        if (inner.closer === "elif") {
          conditionSource = inner.closerBody;
          conditionLine = inner.line;
          continue;
        }
        if (inner.closer === "else") {
          if (inner.closerBody.trim()) throw new TemplateError(`"{% else %}" doesn't take a condition. Use "{% elif %}"`, inner.line);
          const rest = block(depth + 1, ["endif"]);
          if (rest.closer === null) throw new TemplateError(`"{% if %}" is never closed with "{% endif %}"`, token.line);
          otherwise = rest.nodes;
        }
        break;
      }
      nodes.push({ kind: "if", branches, otherwise, line: token.line });
    }
    return { nodes, closer: null, closerBody: "", line: tokens[tokens.length - 1]?.line ?? 1 };
  };

  return block(0, []).nodes;
}

// What a template refers to, so the composer can ask for its values.
export function templateVariables(source: string) {
  const values = new Set<string>();
  const contactFields = new Set<string>();
  let usesUnsubscribe = false;
  const visitPath = (path: Path) => {
    if (path.kind === "value") values.add(path.name);
    else if (path.kind === "contact") contactFields.add(path.field);
    else usesUnsubscribe = true;
  };
  const visitOperand = (operand: Operand) => {
    if (operand.kind === "path") visitPath(operand.path);
  };
  const visitCondition = (condition: Condition): void => {
    switch (condition.kind) {
      case "or":
      case "and":
        visitCondition(condition.left);
        visitCondition(condition.right);
        return;
      case "not":
        return visitCondition(condition.operand);
      case "compare":
        visitOperand(condition.left);
        return visitOperand(condition.right);
      case "truthy":
        return visitOperand(condition.operand);
    }
  };
  const visit = (nodes: Node[]) => {
    for (const node of nodes) {
      if (node.kind === "output") visitPath(node.path);
      else if (node.kind === "if") {
        for (const branch of node.branches) {
          visitCondition(branch.condition);
          visit(branch.body);
        }
        visit(node.otherwise);
      }
    }
  };
  visit(parseTemplate(source));
  return { values: [...values], contactFields: [...contactFields], usesUnsubscribe };
}

// Rendering.

export function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Stops a printed value from smuggling in a Resend merge tag.
const escapeBraces = (value: string) => value.replace(/\{/g, "&#123;").replace(/\}/g, "&#125;");

function contactValue(contact: TemplateContact | null | undefined, field: string) {
  if (!contact) return "";
  if (field === "email") return contact.email ?? "";
  if (field === "first_name") return contact.first_name ?? "";
  if (field === "last_name") return contact.last_name ?? "";
  return contact.fields?.[field] ?? "";
}

function applyFilters(value: string, filters: Filter[]) {
  let out = value;
  let safe = false;
  for (const filter of filters) {
    if (filter.name === "default") out = out.trim() ? out : filter.arg;
    else if (filter.name === "upper") out = out.toUpperCase();
    else if (filter.name === "lower") out = out.toLowerCase();
    else if (filter.name === "trim") out = out.trim();
    else if (filter.name === "capitalize") out = out.charAt(0).toUpperCase() + out.slice(1);
    else safe = true;
  }
  return { out, safe };
}

type Mode = "local" | "broadcast";

function render(nodes: Node[], data: TemplateData, mode: Mode): string {
  const values = data.values ?? {};
  const isBody = (path: Path) => path.kind === "value" && path.name === BODY_VARIABLE && data.body !== undefined;
  const resolve = (path: Path, line: number) => {
    if (path.kind === "unsubscribe") return data.unsubscribeUrl ?? "";
    if (path.kind === "value") return isBody(path) ? (data.body ?? "") : (values[path.name] ?? "");
    if (mode === "broadcast") {
      throw new TemplateError(
        `Contact fields like "contact.${path.field}" can't be used in conditions in a campaign, because Resend fills them in for each recipient`,
        line,
      );
    }
    return contactValue(data.contact, path.field);
  };
  const operand = (value: Operand, line: number) => (value.kind === "string" ? value.value : resolve(value.path, line));
  const test = (condition: Condition, line: number): boolean => {
    switch (condition.kind) {
      case "or":
        return test(condition.left, line) || test(condition.right, line);
      case "and":
        return test(condition.left, line) && test(condition.right, line);
      case "not":
        return !test(condition.operand, line);
      case "compare": {
        const equal = operand(condition.left, line).trim() === operand(condition.right, line).trim();
        return condition.op === "==" ? equal : !equal;
      }
      case "truthy":
        return operand(condition.operand, line).trim() !== "";
    }
  };
  const walk = (list: Node[]): string => {
    let out = "";
    for (const node of list) {
      if (node.kind === "text") out += node.text;
      else if (node.kind === "if") {
        const branch = node.branches.find((candidate) => test(candidate.condition, node.line));
        out += walk(branch ? branch.body : node.otherwise);
      } else if (node.path.kind === "unsubscribe") {
        out += mode === "broadcast" ? RESEND_UNSUBSCRIBE_TAG : escapeHtml(data.unsubscribeUrl ?? "");
      } else if (isBody(node.path)) {
        // Already HTML, from the person's own editor, so filters and escaping don't apply.
        out += data.body;
      } else if (node.path.kind === "contact" && mode === "broadcast") {
        out += resendContactTag(node.path.field, node.filters, node.line);
      } else {
        const { out: value, safe } = applyFilters(resolve(node.path, node.line), node.filters);
        const printed = safe ? value : escapeHtml(value);
        out += mode === "broadcast" ? escapeBraces(printed) : printed;
      }
    }
    return out;
  };
  return walk(nodes);
}

// Resend's broadcast merge tags take a fallback after "|", so the fallback can't
// contain the characters that end the tag.
function resendContactTag(field: string, filters: Filter[], line: number) {
  const other = filters.find((filter) => filter.name !== "default");
  if (other) {
    throw new TemplateError(
      `The "${other.name}" filter can't be used on contact fields in a campaign, because Resend fills them in for each recipient`,
      line,
    );
  }
  let arg = "";
  for (const filter of filters) if (filter.name === "default") arg = filter.arg;
  const cleaned = escapeHtml(arg).replace(/[{}|]/g, "");
  return `{{{contact.${field}${cleaned ? `|${cleaned}` : ""}}}}`;
}

// Fills everything in. Used for previews and for one-to-one emails.
export function renderTemplate(source: string, data: TemplateData = {}) {
  return render(parseTemplate(source), data, "local");
}

export function hasBodySlot(source: string) {
  return templateVariables(source).values.includes(BODY_VARIABLE);
}

// Inserts a template into an email without losing what's written: it goes where the
// template says {{ body }}, or below the template when it has no such place.
export function insertTemplate(source: string, data: TemplateData & { body: string }) {
  if (hasBodySlot(source)) return renderTemplate(source, data);
  const html = renderTemplate(source, { ...data, body: undefined });
  if (!data.body) return html;
  const close = html.search(/<\/body>/i);
  return close === -1 ? html + data.body : html.slice(0, close) + data.body + html.slice(close);
}

// Fills in the values chosen when sending and leaves contact fields as Resend merge
// tags, which Resend replaces for each recipient of the broadcast.
export function compileBroadcast(source: string, values: Record<string, string> = {}) {
  return render(parseTemplate(source), { values, unsubscribeUrl: RESEND_UNSUBSCRIBE_TAG }, "broadcast");
}

// Every campaign carries an unsubscribe footer, whatever the template says. Templates
// can place {{ unsubscribe_url }} elsewhere too, but they can't take the footer away.
export function addUnsubscribeFooter(html: string, unsubscribeUrl: string, sender: string) {
  const footer =
    `<div style="margin:32px auto 0;max-width:600px;padding:16px;border-top:1px solid #e5e5e5;` +
    `font:12px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#737373;text-align:center">` +
    `You're receiving this email from ${escapeBraces(escapeHtml(sender))}. ` +
    `<a href="${escapeHtml(unsubscribeUrl)}" style="color:#737373;text-decoration:underline">Unsubscribe</a>` +
    `</div>`;
  const close = html.search(/<\/body>/i);
  return close === -1 ? html + footer : html.slice(0, close) + footer + html.slice(close);
}

const decodeText = (html: string) =>
  html
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

// A subject line is a template too, but it's plain text, so nothing is escaped.
export function renderSubject(source: string, data: TemplateData = {}) {
  return decodeText(renderTemplate(source, data)).replace(/[\r\n]+/g, " ").trim();
}

// Resend doesn't document merge tags in broadcast subjects, so campaign subjects
// only take the values chosen when sending.
export function compileBroadcastSubject(source: string, values: Record<string, string> = {}) {
  const { contactFields, usesUnsubscribe } = templateVariables(source);
  if (contactFields.length || usesUnsubscribe) {
    throw new TemplateError("A campaign's subject can't use contact fields or the unsubscribe link", 1);
  }
  return renderSubject(source, { values });
}

// Sample data for previews when the workspace has no contacts yet.
export const SAMPLE_CONTACT: TemplateContact = {
  email: "ada@example.com",
  first_name: "Ada",
  last_name: "Lovelace",
  fields: {},
};
