// hellobox/no-hard-coded-colors: flags Tailwind classes that name a palette color
// (`text-amber-500`, `bg-white`, `border-black/10`) or a hex value (`bg-[#F38020]`). The
// interface takes its colors from theme tokens (`bg-brand`, `text-warning`, …) so themes,
// accents and dark mode keep working. Hex values in other places (email HTML, SVG fills,
// metadata) aren't classes and aren't checked.

const PALETTE =
  "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|black|white";
const UTILITY =
  "bg|text|border(?:-[xytrblse])?|ring|ring-offset|fill|stroke|from|via|to|outline|decoration|shadow|divide|placeholder|caret|accent";

/** Each color class in a string of classes. Variants (`hover:`, `dark:`) and `!` are allowed in front. */
export const COLOR_CLASS = new RegExp(
  `(?<=^|[\\s:!])(?:${UTILITY})-(?:(?:${PALETTE})(?:-\\d{2,3})?|\\[#([0-9a-fA-F]{3,8})\\])(?:\\/[\\w.\\[\\]%]+)?(?=$|\\s)`,
  "g",
);

/** The color classes in `text`, leaving out hex values on the allow list. */
export function colorClasses(text, allow = []) {
  const allowed = new Set(allow.map((hex) => hex.replace(/^#/, "").toLowerCase()));
  return [...text.matchAll(COLOR_CLASS)]
    .filter((match) => !(match[1] && allowed.has(match[1].toLowerCase())))
    .map((match) => match[0]);
}

export const noHardCodedColors = {
  meta: {
    type: "suggestion",
    docs: { description: "Take interface colors from theme tokens, not the Tailwind palette or hex values." },
    schema: [
      {
        type: "object",
        properties: { allow: { type: "array", items: { type: "string" } } },
        additionalProperties: false,
      },
    ],
    messages: {
      color:
        "`{{name}}` is a hard-coded color. Use a theme token (brand, primary, muted, success, warning, info, destructive, star, …) so themes and dark mode work.",
    },
  },
  create(context) {
    const allow = context.options[0]?.allow ?? [];
    const check = (node, text) => {
      if (typeof text !== "string") return;
      for (const name of colorClasses(text, allow)) context.report({ node, messageId: "color", data: { name } });
    };
    return {
      Literal: (node) => check(node, node.value),
      TemplateElement: (node) => check(node, node.value.cooked),
    };
  },
};
