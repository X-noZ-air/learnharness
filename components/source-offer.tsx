const commit = process.env.NEXT_PUBLIC_LH_SOURCE_OFFER ?? "";

export function SourceOffer() {
	if (!/^[0-9a-f]{40}$/.test(commit)) return null;
	return (
		<div className="px-2 pt-1">
			<a
				href={`https://github.com/X-noZ-air/learnharness/archive/${commit}.tar.gz`}
				className="block w-fit max-w-full rounded-sm text-xs text-foreground"
				data-testid="source-code-link"
				title={commit}
			>
				<span className="underline underline-offset-2">Source code of this version</span>
				<code className="block break-all text-[11px] text-muted-foreground">{commit.slice(0, 12)}</code>
			</a>
		</div>
	);
}
