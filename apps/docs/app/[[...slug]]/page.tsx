import { DocsBody, DocsPage, DocsTitle } from "fumadocs-ui/layouts/docs/page";
import { createRelativeLink } from "fumadocs-ui/mdx";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getMDXComponents } from "@/components/mdx";
import { REPO_URL, SITE_NAME } from "@/lib/site";
import { source } from "@/lib/source";

type Props = { params: Promise<{ slug?: string[] }> };

export default async function Page({ params }: Props) {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) notFound();
  const MDX = page.data.body;

  // The description is the page's first paragraph, which the body already shows.
  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsBody>
        <MDX components={getMDXComponents({ a: createRelativeLink(source, page) })} />
      </DocsBody>
      <p className="text-fd-muted-foreground mt-8 text-sm">
        Something wrong or missing?{" "}
        <a className="underline" href={`${REPO_URL}/issues`}>
          Open an issue
        </a>{" "}
        or edit the file in the repository.
      </p>
    </DocsPage>
  );
}

export function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) notFound();
  // The home page's title is the site's name; the layout's template would repeat it.
  return { title: slug ? page.data.title : { absolute: SITE_NAME }, description: page.data.description };
}
