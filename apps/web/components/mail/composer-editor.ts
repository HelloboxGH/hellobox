import { type BlockFormat, cleanEditorHtml, findLink, type InlineMatch, matchBlock, matchInline, splitLinks } from "./editor-rules";

// Applies editor-rules.ts to the composer's contentEditable: links as you type or paste,
// and Markdown as you type. Every function works on the caret's own text node, which is
// where typed characters land.

const ZWSP = "\u200B";
const BLOCKS = new Set(["P", "DIV", "LI", "H1", "H2", "H3", "BLOCKQUOTE", "PRE"]);

/** Inside a link, inline code or a code block, where nothing should be rewritten. */
function shielded(node: Node, root: HTMLElement) {
  for (let current: Node | null = node; current && current !== root; current = current.parentNode) {
    if (current instanceof HTMLElement && ["A", "CODE", "PRE"].includes(current.tagName)) return true;
  }
  return false;
}

/** The text node holding a collapsed caret inside the editor, with the caret's offset. */
function caret(root: HTMLElement) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !selection.isCollapsed) return null;
  const node = selection.anchorNode;
  if (!(node instanceof Text) || !root.contains(node)) return null;
  return { node, offset: selection.anchorOffset, selection };
}

function placeCaret(node: Node, offset: number) {
  const selection = window.getSelection();
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** Swaps text[start, end) of a text node for an element, and puts the caret after it. */
function replaceRange(node: Text, start: number, end: number, element: HTMLElement, caretAfter: number) {
  const rest = node.data.slice(end);
  node.data = node.data.slice(0, start);
  // An empty text node after the element would let the caret slip back inside it, so the
  // caret parks behind a zero-width space, which is stripped before anything is saved.
  const after = document.createTextNode(rest || ZWSP);
  node.after(element, after);
  placeCaret(after, rest ? caretAfter : 1);
}

function link(text: string, href: string) {
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.textContent = text;
  return anchor;
}

/**
 * Turns the word just before the caret into a link when it is one. `typed` is true when a
 * space was just typed (the word ends one character back), false before Enter.
 */
export function linkifyBeforeCaret(root: HTMLElement, typed: boolean) {
  const at = caret(root);
  if (!at || shielded(at.node, root)) return false;
  const end = typed ? at.offset - 1 : at.offset;
  const word = /\S+$/.exec(at.node.data.slice(0, end))?.[0];
  if (!word) return false;
  const found = findLink(word);
  if (!found) return false;
  const start = end - word.length + found.start;
  replaceRange(at.node, start, start + found.text.length, link(found.text, found.href), at.offset - start - found.text.length);
  return true;
}

function inlineElement(match: InlineMatch) {
  if (match.tag === "a") return link(match.text, match.href!);
  const element = document.createElement(match.tag);
  element.textContent = match.text;
  return element;
}

/** Applies inline Markdown that the last typed character closed. */
export function applyInlineMarkdown(root: HTMLElement) {
  const at = caret(root);
  if (!at || shielded(at.node, root)) return false;
  const match = matchInline(at.node.data.slice(0, at.offset));
  if (!match) return false;
  replaceRange(at.node, match.start, at.offset, inlineElement(match), 0);
  return true;
}

function blockOf(node: Node, root: HTMLElement) {
  for (let current: Node | null = node.parentNode; current; current = current.parentNode) {
    if (current === root) return root;
    if (current instanceof HTMLElement && BLOCKS.has(current.tagName)) return current;
  }
  return root;
}

function alreadyFormatted(block: HTMLElement, format: BlockFormat) {
  const inList = Boolean(block.closest("li"));
  if (format.command !== "formatBlock") return inList;
  return inList || block.tagName === format.value.toUpperCase() || Boolean(block.closest("pre"));
}

// Text as typed: without caret placeholders, and with the no-break space a browser stores
// for a space at the end of a line read as a space.
const plain = (text: string) => text.replace(/\u200B/g, "").replace(/\u00A0/g, " ");

/** After a space at the start of a line, turns "# ", "- ", "1. ", "> " or "``` " into that block. */
export function applyBlockMarkdown(root: HTMLElement) {
  const at = caret(root);
  if (!at || shielded(at.node, root)) return false;
  const typed = plain(at.node.data.slice(0, at.offset));
  if (!typed.endsWith(" ")) return false;
  const block = blockOf(at.node, root);
  // The marker has to be everything on the line before the caret.
  const line = document.createRange();
  line.setStart(block, 0);
  line.setEnd(at.node, at.offset);
  if (plain(line.toString()) !== typed) return false;
  const format = matchBlock(typed.slice(0, -1));
  if (!format || alreadyFormatted(block, format)) return false;
  // Format the line while it still has text, then take the marker out. Emptying the line
  // first leaves the browser nothing to format, and the caret goes astray.
  if (format.command === "formatBlock") document.execCommand("formatBlock", false, format.value);
  else document.execCommand(format.command);
  // The browser may put the caret before or after the marker; either way it's in its node.
  const node = caret(root)?.node;
  if (!node || !plain(node.data).startsWith(typed)) return true;
  node.data = ZWSP + node.data.replace(/^​+/, "").slice(typed.length);
  placeCaret(node, 1);
  return true;
}

/** A pasted link: wraps the selected text in it, or pastes it as a link. Returns false to paste normally. */
export function pasteLink(root: HTMLElement, text: string) {
  const trimmed = text.trim();
  const found = findLink(trimmed);
  if (!found || found.start || found.text !== trimmed) return false;
  const selection = window.getSelection();
  const node = selection?.anchorNode;
  if (!node || !root.contains(node) || shielded(node, root)) return false;
  if (selection && !selection.isCollapsed) return document.execCommand("createLink", false, found.href);
  const anchor = link(found.text, found.href);
  return document.execCommand("insertHTML", false, `${anchor.outerHTML}${ZWSP}`);
}

/** Links any link-shaped text that was never turned into one, such as the last word typed. */
function linkifyTree(root: HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!shielded(node, root)) texts.push(node as Text);
  }
  for (const node of texts) {
    const parts = splitLinks(node.data);
    if (!parts.some((part) => part.href)) continue;
    node.replaceWith(...parts.map((part) => (part.href ? link(part.text, part.href) : document.createTextNode(part.text))));
  }
}

/** The editor's HTML as it should be saved or sent. The editor itself is left as it is. */
export function outgoingHtml(element: HTMLElement | null) {
  if (!element) return "";
  const copy = element.cloneNode(true) as HTMLElement;
  linkifyTree(copy);
  return cleanEditorHtml(copy.innerHTML);
}
