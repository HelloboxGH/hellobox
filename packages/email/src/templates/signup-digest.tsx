import { Text } from "@react-email/components";
import { colors, EmailLayout, Muted, P } from "../layout";

export interface DigestSignup {
  name: string;
  email: string;
  method: string;
  verified: boolean;
  joinedByInvite: boolean;
  heardFrom: string | null;
  at: string;
}

export const signupDigestSubject = (count: number, day: string) =>
  `${count} new ${count === 1 ? "signup" : "signups"} on ${day}`;

// Goes to platform admins at the end of a day that had signups.
export default function SignupDigest({ day, signups, totalUsers }: { day: string; signups: DigestSignup[]; totalUsers: number }) {
  const count = signups.length;
  return (
    <EmailLayout preview={`${signups.map((s) => s.email).slice(0, 3).join(", ")}${count > 3 ? "…" : ""}`} heading={signupDigestSubject(count, day)}>
      <P>
        {count === 1 ? "One person" : `${count} people`} signed up for HelloBox today. You now have{" "}
        <strong>{totalUsers.toLocaleString("en-US")}</strong> {totalUsers === 1 ? "user" : "users"}.
      </P>
      <table width="100%" cellPadding={0} cellSpacing={0} role="presentation"
        style={{ border: `1px solid ${colors.border}`, borderRadius: 14, margin: "4px 0 22px", borderCollapse: "separate" }}>
        <tbody>
          {signups.map((signup, index) => (
            <tr key={signup.email}>
              <td style={{ padding: "10px 16px", borderTop: index ? `1px solid ${colors.border}` : "none" }}>
                <Text style={{ margin: 0, fontSize: 14, lineHeight: "20px", fontWeight: 600 }}>{signup.name}</Text>
                <Text style={{ margin: 0, fontSize: 13, lineHeight: "20px", color: colors.muted }}>
                  {signup.email} · {signup.method} · {signup.at}
                  {signup.heardFrom ? ` · heard from ${signup.heardFrom}` : ""}
                  {signup.joinedByInvite ? " · joined by invite" : ""}
                  {signup.verified ? "" : " · not verified"}
                </Text>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Muted>You get this because your address is in ADMIN_EMAILS. Days without signups send nothing.</Muted>
    </EmailLayout>
  );
}

SignupDigest.PreviewProps = {
  day: "Monday, November 9",
  totalUsers: 128,
  signups: [
    { name: "Ada Stone", email: "ada@example.com", method: "Google", verified: true, joinedByInvite: false, heardFrom: "Hacker News", at: "09:14" },
    { name: "Lin Park", email: "lin@acme.com", method: "Email", verified: false, joinedByInvite: true, heardFrom: null, at: "16:02" },
  ],
};
