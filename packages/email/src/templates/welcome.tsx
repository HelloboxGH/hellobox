import { CtaButton, EmailLayout, Muted, P, SITE_URL } from "../layout";
import { Section, Text } from "@react-email/components";
import { colors } from "../layout";

const STEPS = [
  ["Connect your sender", "Connect Amazon SES or Resend in two clicks, then pick the domains you want to receive on."],
  ["Get your first email", "Send a message to hello@yourdomain.com. It lands in seconds."],
  ["Bring the team", "Invite teammates and share mailboxes when you're ready."],
];

export default function Welcome({ name }: { name: string }) {
  return (
    <EmailLayout preview="Your domain finally has an inbox." heading={name ? `Welcome, ${name}.` : "Welcome."}>
      <P>
        Thank you for signing up. Seriously. HelloBox is a small, independent product, and every new account means a
        lot to us.
      </P>
      <P>Here&apos;s how to get your first reply in a couple of minutes:</P>
      <Section style={{ margin: "4px 0 20px" }}>
        {STEPS.map(([title, body], index) => (
          <table key={title} width="100%" cellPadding={0} cellSpacing={0} role="presentation" style={{ marginBottom: 12 }}>
            <tbody>
              <tr>
                <td width="36" style={{ verticalAlign: "top" }}>
                  <div
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: 13,
                      backgroundColor: colors.brandSoft,
                      color: colors.brandForeground,
                      fontSize: 13,
                      fontWeight: 600,
                      lineHeight: "26px",
                      textAlign: "center",
                    }}
                  >
                    {index + 1}
                  </div>
                </td>
                <td style={{ verticalAlign: "top" }}>
                  <Text style={{ margin: "2px 0 2px", fontSize: 15, fontWeight: 600 }}>{title}</Text>
                  <Text style={{ margin: 0, fontSize: 14, lineHeight: "21px", color: colors.muted }}>{body}</Text>
                </td>
              </tr>
            </tbody>
          </table>
        ))}
      </Section>
      <CtaButton href={`${SITE_URL}/inbox`}>Open HelloBox</CtaButton>
      <Muted>Stuck, or something feels off? Just reply to this email. A real person reads it.</Muted>
    </EmailLayout>
  );
}

Welcome.PreviewProps = { name: "Ada" };
