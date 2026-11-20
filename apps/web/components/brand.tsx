import Image from "next/image";
import Link from "next/link";
import { cn } from "@/lib/utils";

export function Logo({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <Image
      src="/logo.png"
      alt=""
      width={size}
      height={Math.round((size * 660) / 720)}
      className={cn("shrink-0 select-none drop-shadow-[0_1px_2px_rgb(40_40_90/0.22)]", className)}
      priority
    />
  );
}

// The marketing pages mark the product as in beta, set small under the name.
export function BrandLink({ size = 28, beta, className }: { size?: number; beta?: boolean; className?: string }) {
  return (
    <Link href="/" className={cn("inline-flex items-center gap-2 font-semibold tracking-tight", className)}>
      <Logo size={size} />
      {beta ? (
        // Hung below the name, out of the flow, so the name sits exactly where it would without it.
        <span className="relative">
          HelloBox
          <span className="pointer-events-none absolute top-full left-px -mt-px font-semibold text-[7.5px] text-brand-foreground/75 uppercase leading-none tracking-[0.16em]">Beta</span>
        </span>
      ) : (
        "HelloBox"
      )}
    </Link>
  );
}
