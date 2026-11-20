import { BrandLink } from "@/components/brand";
import { AppProviders } from "@/components/providers";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppProviders>
      <main className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-canvas px-4 py-10">
        <div
          aria-hidden
          className="pointer-events-none absolute -top-48 left-1/2 size-[42rem] -translate-x-1/2 rounded-full bg-brand/15 blur-3xl"
        />
        <BrandLink size={34} className="relative mb-7 text-lg text-foreground" />
        <div className="motion-rise relative w-full max-w-sm">{children}</div>
      </main>
    </AppProviders>
  );
}
