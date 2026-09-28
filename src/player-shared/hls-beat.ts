export function beatUrl(mediaBase: string, username: string, viewerId: string, captchaQuery: string): string {
    return `${mediaBase}/hls/${encodeURIComponent(username)}/beat?id=${encodeURIComponent(viewerId)}${captchaQuery}`;
}

function beatReply(status: number, body: string): Record<string, unknown> | null {
    if (status !== 200 || !body) return null;
    try {
        const parsed: unknown = JSON.parse(body);
        return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

export function beatVariants(status: number, body: string): number | null {
    const variants = beatReply(status, body)?.variants;
    return typeof variants === "number" && Number.isInteger(variants) && variants >= 0 ? variants : null;
}

export function beatEdgeLowLatency(status: number, body: string): boolean {
    return beatReply(status, body)?.edgeLL === true;
}

export interface LadderWatch {
    master: number | null;
    restartedFor: number | null;
}

export function newLadderWatch(): LadderWatch {
    return { master: null, restartedFor: null };
}

export function ladderGrew(watch: LadderWatch, variants: number | null, paused: boolean): boolean {
    if (variants === null || watch.master === null || watch.master <= 0) return false;
    if (variants <= watch.master) {
        watch.restartedFor = null;
        return false;
    }
    if (paused || (watch.restartedFor !== null && variants <= watch.restartedFor)) return false;
    watch.restartedFor = variants;
    return true;
}
