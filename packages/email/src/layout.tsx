import { setting } from "@hellobox/config";

import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Img,
  Link,
  Preview,
  Section,
  Text,
} from "@react-email/components";
import type { CSSProperties, ReactNode } from "react";

// Links in every email point at this instance, so a self-hosted install never sends people
// to someone else's site. Read at load time, so APP_URL must be set where emails are sent.
export const SITE_URL = (setting("APP_URL") || "http://127.0.0.1:3010").replace(/\/+$/, "");
const SITE_HOST = SITE_URL.replace(/^https?:\/\//, "");

// The default periwinkle theme, converted from the app's oklch tokens. Email clients
// don't support oklch or CSS variables, so these stay as plain hex.
export const colors = {
  canvas: "#f3f4fa",
  card: "#ffffff",
  foreground: "#262626",
  muted: "#6b6b6b",
  border: "#e8e8ec",
  brand: "#6068bc",
  brandSoft: "#e7ecff",
  brandForeground: "#3e4292",
  warningSoft: "#fff7e6",
  warningForeground: "#92400e",
};

const sans = "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const serif = "'Instrument Serif', Georgia, 'Times New Roman', serif";
const mono = "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

export function EmailLayout({
  preview,
  heading,
  children,
  footer,
}: {
  preview: string;
  heading: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Html lang="en">
      <Head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light" />
        <meta name="supported-color-schemes" content="light" />
        {/* React Email's Font applies itself to every element, so headings load it on their own. */}
        <style>{`@font-face { font-family: 'Instrument Serif'; font-style: normal; font-weight: 400; src: url(https://fonts.gstatic.com/s/instrumentserif/v5/jizBRFtNs2ka5fXjeivQ4LroWlx-6zUTjg.woff2) format('woff2'); }`}</style>
      </Head>
      <Preview>{preview}</Preview>
      <Body style={{ margin: 0, backgroundColor: colors.canvas, fontFamily: sans, color: colors.foreground }}>
        <Container style={{ maxWidth: 560, margin: "0 auto", padding: "40px 16px 48px" }}>
          <Section style={{ paddingBottom: 24 }}>
            <Link href={SITE_URL} style={{ textDecoration: "none", color: colors.foreground }}>
              <Img
                src={`${SITE_URL}/logo.png`}
                width="32"
                height="29"
                alt="HelloBox"
                style={{ display: "inline-block", verticalAlign: "middle" }}
              />
              <span style={{ marginLeft: 10, fontSize: 17, fontWeight: 600, letterSpacing: "-0.01em", verticalAlign: "middle" }}>
                HelloBox
              </span>
            </Link>
          </Section>
          <Section
            style={{
              backgroundColor: colors.card,
              border: `1px solid ${colors.border}`,
              borderRadius: 20,
              padding: "36px 36px 32px",
            }}
          >
            <Heading
              as="h1"
              style={{
                margin: "0 0 18px",
                fontFamily: serif,
                fontSize: 34,
                fontWeight: 400,
                lineHeight: "1.1",
                letterSpacing: "-0.01em",
                color: colors.foreground,
              }}
            >
              {heading}
            </Heading>
            {children}
          </Section>
          <Section style={{ padding: "24px 8px 0" }}>
            {footer && <Text style={footerText}>{footer}</Text>}
            <Text style={footerText}>
              HelloBox, the inbox for the email you already send.{" "}
              <Link href={SITE_URL} style={{ color: colors.muted, textDecoration: "underline" }}>
                {SITE_HOST}
              </Link>
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

const footerText: CSSProperties = { margin: "0 0 6px", fontSize: 12, lineHeight: "18px", color: colors.muted };

export function P({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <Text style={{ margin: "0 0 16px", fontSize: 15, lineHeight: "24px", ...style }}>{children}</Text>;
}

export function Muted({ children }: { children: ReactNode }) {
  return <Text style={{ margin: "0 0 12px", fontSize: 13, lineHeight: "20px", color: colors.muted }}>{children}</Text>;
}

export function CtaButton({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Section style={{ margin: "8px 0 24px" }}>
      <Button
        href={href}
        style={{
          backgroundColor: colors.foreground,
          color: "#fafafa",
          borderRadius: 12,
          padding: "13px 22px",
          fontSize: 15,
          fontWeight: 600,
          textDecoration: "none",
        }}
      >
        {children}
      </Button>
    </Section>
  );
}

// For anyone whose client blocks the button.
export function LinkFallback({ href }: { href: string }) {
  return (
    <>
      <Hr style={{ borderColor: colors.border, margin: "8px 0 16px" }} />
      <Muted>If the button doesn&apos;t work, paste this link into your browser:</Muted>
      <Text style={{ margin: 0, fontFamily: mono, fontSize: 12, lineHeight: "18px", wordBreak: "break-all" }}>
        <Link href={href} style={{ color: colors.brandForeground }}>
          {href}
        </Link>
      </Text>
    </>
  );
}

export function Callout({ children, tone = "brand" }: { children: ReactNode; tone?: "brand" | "warning" }) {
  const warning = tone === "warning";
  return (
    <Section
      style={{
        backgroundColor: warning ? colors.warningSoft : colors.brandSoft,
        borderRadius: 14,
        padding: "14px 18px",
        margin: "4px 0 22px",
      }}
    >
      <Text
        style={{
          margin: 0,
          fontSize: 14,
          lineHeight: "22px",
          color: warning ? colors.warningForeground : colors.brandForeground,
        }}
      >
        {children}
      </Text>
    </Section>
  );
}

// Label and value rows, such as a plan summary.
export function Details({ rows }: { rows: [string, string][] }) {
  return (
    <Section style={{ border: `1px solid ${colors.border}`, borderRadius: 14, padding: "6px 18px", margin: "4px 0 22px" }}>
      {rows.map(([label, value], index) => (
        <table key={label} width="100%" cellPadding={0} cellSpacing={0} role="presentation"
          style={{ borderTop: index ? `1px solid ${colors.border}` : "none" }}>
          <tbody>
            <tr>
              <td style={{ padding: "10px 0", fontSize: 14, color: colors.muted }}>{label}</td>
              <td style={{ padding: "10px 0", fontSize: 14, fontWeight: 600, textAlign: "right" }}>{value}</td>
            </tr>
          </tbody>
        </table>
      ))}
    </Section>
  );
}

export const formatDate = (date: Date) =>
  date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
