import sanitize from "sanitize-html";

const ALLOWED_TAGS = [
  ...sanitize.defaults.allowedTags,
  "img", "center", "font", "u", "s", "del", "ins", "hr",
  "html", "head", "body", "style",
];

// Runs at ingest. The reading pane adds a sandboxed iframe and CSP on top of this.
export function sanitizeEmailHtml(html: string) {
  return sanitize(html, {
    allowedTags: ALLOWED_TAGS,
    allowVulnerableTags: true,
    disallowedTagsMode: "discard",
    allowedAttributes: {
      "*": [
        "style", "class", "align", "valign", "width", "height", "bgcolor",
        "color", "dir", "lang", "title", "border", "cellpadding", "cellspacing",
        "colspan", "rowspan",
      ],
      a: ["href", "name", "target", "rel"],
      img: ["src", "alt"],
      font: ["face", "size", "color"],
    },
    allowedSchemes: ["http", "https", "mailto", "tel", "cid"],
    allowedSchemesByTag: { img: ["http", "https", "cid"] },
    allowProtocolRelative: false,
    transformTags: {
      a: sanitize.simpleTransform("a", {
        target: "_blank",
        rel: "noopener noreferrer nofollow",
      }),
    },
    exclusiveFilter: (frame) =>
      frame.tag === "style" && /@import|expression\(|javascript:/i.test(frame.text),
  });
}

export function replaceCidImages(
  html: string,
  urlFor: (contentId: string) => string | undefined,
) {
  return html.replace(/(["'])cid:([^"']+)\1/gi, (match, quote, contentId) => {
    const url = urlFor(contentId);
    return url ? `${quote}${url}${quote}` : match;
  });
}

export const hasRemoteImages = (html: string) =>
  /<img[^>]+src=["']?https?:/i.test(html) ||
  /url\(\s*["']?https?:/i.test(html);
