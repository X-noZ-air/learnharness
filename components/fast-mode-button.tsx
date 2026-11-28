"use client";

import { Hint } from "@/components/ui/hint";
import { cn } from "@/lib/utils";

export function FastModeButton({ checked, onToggle, disabled, label = "Fast Mode" }: {
	checked: boolean;
	onToggle: () => void;
	disabled?: boolean;
	label?: string;
}) {
	return (
		<Hint label="Fast Mode uses more of your ChatGPT quota." side="bottom">
			<button type="button" aria-label={label} aria-pressed={checked} disabled={disabled}
				onClick={onToggle}
				className={cn(
					"shrink-0 rounded-full border px-2.5 py-1 font-ui text-xs shadow-lg transition-colors narrow:min-h-11 narrow:min-w-11",
					checked ? "border-foreground bg-foreground text-background hover:bg-foreground/85" : "bg-card/85 text-muted-foreground hover:bg-muted hover:text-foreground",
				)}
			>Fast</button>
		</Hint>
	);
}
