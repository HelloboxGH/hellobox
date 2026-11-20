import type { ReactNode } from "react";
import { BrandLink, Logo } from "@/components/brand";

export function StatusPage({
  code, title, description, actions, footnote,
}: {
  code: string;
  title: string;
  description: string;
  actions: ReactNode;
  footnote?: ReactNode;
}) {
  return (
    <div className="relative flex min-h-dvh flex-col overflow-hidden bg-canvas text-foreground">
      <div aria-hidden className="pointer-events-none absolute -top-48 left-1/2 size-[42rem] -translate-x-1/2 rounded-full bg-brand/15 blur-3xl" />
      <header className="relative px-4 py-4 sm:px-6"><BrandLink size={30} /></header>
      <main className="motion-rise relative flex flex-1 flex-col items-center justify-center px-4 pb-24 text-center">
        <div className="relative flex items-center justify-center">
          <span aria-hidden className="select-none font-serif text-[9rem] text-foreground/10 leading-none tabular-nums sm:text-[14rem]">{code}</span>
          <Logo size={88} className="absolute sm:hidden" />
          <Logo size={128} className="absolute hidden sm:block" />
        </div>
        <h1 className="mt-6 text-balance font-serif text-4xl tracking-tight sm:text-5xl">{title}</h1>
        <p className="mt-3 max-w-md text-pretty text-muted-foreground">{description}</p>
        <div className="mt-7 flex flex-wrap justify-center gap-3">{actions}</div>
        {footnote && <p className="mt-6 text-muted-foreground text-xs">{footnote}</p>}
      </main>
    </div>
  );
}
