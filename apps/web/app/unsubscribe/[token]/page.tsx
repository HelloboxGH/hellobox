import { contactForUnsubscribeToken } from "@hellobox/mail";
import type { Metadata } from "next";
import { Suspense } from "react";
import { StatusPage } from "@/components/status-page";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Unsubscribe", robots: { index: false } };

type Props = {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ done?: string }>;
};

export default function UnsubscribePage(props: Props) {
  return (
    <Suspense fallback={null}>
      <Unsubscribe {...props} />
    </Suspense>
  );
}

async function Unsubscribe({ params, searchParams }: Props) {
  const [{ token }, { done }] = await Promise.all([params, searchParams]);
  const contact = await contactForUnsubscribeToken(token);
  if (!contact) {
    return (
      <StatusPage
        code="404"
        title="This link doesn't work"
        description="It may have been copied incompletely. Try the link in the email again."
        actions={null}
      />
    );
  }
  if (done || contact.unsubscribedAt) {
    return (
      <StatusPage
        code="✓"
        title="You're unsubscribed"
        description={`${contact.email} won't get these emails any more.`}
        actions={null}
      />
    );
  }
  return (
    <StatusPage
      code="?"
      title="Unsubscribe from these emails?"
      description={`${contact.email} will stop getting campaign emails from this sender.`}
      actions={
        <form method="post" action={`/api/unsubscribe/${encodeURIComponent(token)}`}>
          <Button size="lg" type="submit">Unsubscribe</Button>
        </form>
      }
    />
  );
}
