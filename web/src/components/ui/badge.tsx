import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

type Variant = "shared" | "unclaimed";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant: Variant;
}

const VARIANTS: Record<Variant, string> = {
  shared: "bg-muted text-muted-foreground ring-border",
  unclaimed: "bg-[hsl(var(--brand-orange)/0.12)] text-[hsl(var(--brand-orange))] ring-[hsl(var(--brand-orange)/0.28)]",
};

export function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex w-fit shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-medium leading-none ring-1",
        VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
}
