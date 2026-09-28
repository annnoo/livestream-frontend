export interface SourceLoading {
    loadSource(url: string): void;
}

export function loadSourceOnce(hls: SourceLoading, src: string, active: () => boolean): () => void {
    let loaded = false;
    return () => {
        if (loaded || !active()) return;
        loaded = true;
        hls.loadSource(src);
    };
}
