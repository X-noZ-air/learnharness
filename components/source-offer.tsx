const offer = /^(werft-(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.[1-9][0-9]*):([0-9a-f]{40})$/
	.exec(process.env.NEXT_PUBLIC_LH_SOURCE_OFFER ?? "");
const [, tag, commit] = offer ?? [];
const source = tag && commit ? { tag, commit } : null;

export const hasSourceOffer = source !== null;

export function SourceOffer({ fullCommit = false }: { fullCommit?: boolean }) {
	if (!source) return null;
	const { tag, commit } = source;
	return (
		<a
			href={`https://github.com/X-noZ-air/learnharness/releases/download/${tag}/learnharness-source.tar.gz`}
			className="block w-fit max-w-full rounded-sm text-xs text-foreground"
			data-testid="source-code-link"
		>
			<span className="underline underline-offset-2">Source code of this version</span>
			<code className="block break-all text-[11px] text-muted-foreground" title={commit}>{fullCommit ? commit : commit.slice(0, 12)}</code>
		</a>
	);
}
