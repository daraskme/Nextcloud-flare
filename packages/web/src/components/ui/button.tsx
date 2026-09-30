import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

const variants = cva("button", {
  variants: {
    variant: {
      primary: "button-primary",
      secondary: "button-secondary",
      ghost: "button-ghost",
      danger: "button-danger",
    },
    size: { normal: "", icon: "button-icon", small: "button-small" },
  },
  defaultVariants: { variant: "secondary", size: "normal" },
});
export function Button({
  className,
  variant,
  size,
  asChild,
  ...props
}: ComponentProps<"button"> & VariantProps<typeof variants> & { asChild?: boolean }) {
  const Component = asChild ? Slot : "button";
  return (
    <Component
      type="button"
      data-slot="button"
      className={cn(variants({ variant, size }), className)}
      {...props}
    />
  );
}
