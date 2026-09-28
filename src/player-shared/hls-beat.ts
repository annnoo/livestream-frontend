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
