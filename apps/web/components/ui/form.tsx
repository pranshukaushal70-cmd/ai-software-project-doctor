import { cn } from "@/lib/utils";
import { Notice } from "./notice";

/** Shared field styling: the same height, border and focus treatment for inputs, selects and text areas. */
const FIELD =
  "w-full rounded-md border border-input bg-card text-sm shadow-xs transition-[border-color,box-shadow] placeholder:text-muted-foreground hover:border-primary/30 focus-visible:border-primary/60 focus-visible:shadow-[0_0_0_3px_var(--glow)] focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50";

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn("flex h-9 px-3", FIELD, className)} {...props} />;
}

export function Select({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn("flex h-9 px-2", FIELD, className)} {...props} />;
}

export function Textarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn("px-3 py-2", FIELD, className)} {...props} />;
}

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("text-sm font-medium", className)} {...props} />;
}

export function FormError({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <Notice tone="error" role="alert">
      {message}
    </Notice>
  );
}
