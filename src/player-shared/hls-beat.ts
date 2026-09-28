export function beatUrl(mediaBase: string, username: string, viewerId: string, captchaQuery: string): string {
    return `${mediaBase}/hls/${encodeURIComponent(username)}/beat?id=${encodeURIComponent(viewerId)}${captchaQuery}`;
}

export function beatVariants(status: number, body: string): number | null {
    if (status !== 200 || !body) return null;
    try {
        const parsed: unknown = JSON.parse(body);
        if (typeof parsed !== "object" || parsed === null) return null;
        const variants = (parsed as { variants?: unknown }).variants;
        return typeof variants === "number" && Number.isInteger(variants) && variants >= 0 ? variants : null;
    } catch {
        return null;
    }
}

export function ladderGrew(variants: number | null, levels: number, paused: boolean): boolean {
    if (variants === null || paused || levels <= 0) return false;
    return variants > levels;
}
