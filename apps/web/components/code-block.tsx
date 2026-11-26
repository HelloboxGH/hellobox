import { cn } from "@/lib/utils";

// A small highlighter for the snippets we write ourselves: JavaScript and shell. Not a parser,
// so it's only for code we control. Colors come from the theme's tokens.

export type Language = "js" | "bash";
export type TokenKind = "comment" | "string" | "keyword" | "property" | "number" | "plain";
export interface Token {
  kind: TokenKind;
  text: string;
}

const RULES: Record<Language, [TokenKind, RegExp][]> = {
  js: [
    ["comment", /\/\/[^\n]*/y],
    ["string", /`(?:\\[\s\S]|[^`\\])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/y],
    ["keyword", /\b(?:const|let|var|await|async|if|else|throw|new|return|function|import|from|export|true|false|null)\b/y],
    ["property", /\b[A-Za-z_$][\w$]*(?=\s*:(?!:))/y],
    ["number", /\b\d+(?:\.\d+)?\b/y],
  ],
  bash: [
    ["comment", /(?<=^|\s)#[^\n]*/my],
    ["string", /"(?:\\.|[^"\\])*"|'[^']*'/y],
    ["keyword", /(?<=^|\n)[A-Za-z][\w-]*/y],
    ["property", /(?<=\s)--?[A-Za-z][\w-]*/y],
  ],
};

export function highlight(code: string, language: Language): Token[] {
  const rules = RULES[language];
  const tokens: Token[] = [];
  let plain = "";
  let at = 0;
  while (at < code.length) {
    let matched: Token | null = null;
    for (const [kind, pattern] of rules) {
      pattern.lastIndex = at;
      const found = pattern.exec(code);
      if (found?.[0]) {
        matched = { kind, text: found[0] };
        break;
      }
    }
    if (!matched) {
      plain += code[at];
      at += 1;
      continue;
    }
    if (plain) tokens.push({ kind: "plain", text: plain });
    plain = "";
    tokens.push(matched);
    at += matched.text.length;
  }
  if (plain) tokens.push({ kind: "plain", text: plain });
  return tokens;
}

const COLORS: Record<TokenKind, string> = {
  comment: "text-muted-foreground",
  string: "text-success-foreground",
  keyword: "text-brand-foreground",
  property: "text-info-foreground",
  number: "text-warning-foreground",
  plain: "",
};

export function CodeBlock({ code, language, className }: { code: string; language: Language; className?: string }) {
  return (
    <pre className={cn("overflow-auto rounded-lg bg-muted p-3 font-mono text-xs leading-relaxed", className)}>
      <code>
        {highlight(code, language).map((token, index) =>
          token.kind === "plain" ? token.text : <span key={index} className={COLORS[token.kind]}>{token.text}</span>,
        )}
      </code>
    </pre>
  );
}
