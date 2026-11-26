import { type CSSProperties, useEffect, useState } from "react";

export interface HelloBoxSupportProps {
  /**
   * Asks your server for a link: it calls POST /api/support/v1/sessions with your key and the
   * signed-in user, and returns the `url`. A link works once, so this runs on every mount.
   */
  getUrl: () => Promise<string>;
  title?: string;
  className?: string;
  style?: CSSProperties;
}

/**
 * The customer's support conversations, in an iframe around the HelloBox hosted page. Add
 * your site to "Sites that can show it" in Settings → Support, or the browser won't show it.
 * No dependencies beyond React, and nothing is tracked.
 */
export function HelloBoxSupport({ getUrl, title = "Support", className, style }: HelloBoxSupportProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let current = true;
    getUrl().then(
      (next) => { if (current) setUrl(next); },
      () => { if (current) setFailed(true); },
    );
    return () => {
      current = false;
    };
    // A new link only when the component mounts again: each link works once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (failed) return <p className={className}>Support couldn&apos;t open. Try again later.</p>;
  if (!url) return <div className={className} style={{ minHeight: 480, ...style }} aria-busy="true" />;
  return (
    <iframe
      src={url}
      title={title}
      className={className}
      style={{ width: "100%", minHeight: 480, border: 0, ...style }}
      referrerPolicy="no-referrer"
      allow=""
    />
  );
}
