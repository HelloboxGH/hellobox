import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { REPO_URL } from "@/lib/site";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: <span className="font-semibold">HelloBox docs</span>,
    },
    githubUrl: REPO_URL,
    links: [{ text: "hellobox.app", url: "https://hellobox.app", external: true }],
  };
}
