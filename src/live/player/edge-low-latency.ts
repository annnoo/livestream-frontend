import { masterOffersLowLatency } from "../../player-shared/low-latency.ts";

export function watchesEdgeLowLatencyOffer(requested: boolean, edgeServed: boolean, chosen: boolean): boolean {
    return requested && edgeServed && !chosen;
}

export interface ReprobeView {
    paused: boolean;
    behindLive: boolean;
    visible: boolean;
}

export function edgeReprobeDue(view: ReprobeView): boolean {
    return view.visible && !view.paused && !view.behindLive;
}

export function edgeLowLatencyUpgrade(masterBody: string, view: ReprobeView): boolean {
    return edgeReprobeDue(view) && masterOffersLowLatency(masterBody);
}

export interface EdgeOfferWatchDeps {
    live(): boolean;
    wanted(): boolean;
    view(): ReprobeView;
    fetchMaster(): Promise<string | null>;
    switchToLowLatency(): void;
}

export function edgeOfferWatch(deps: EdgeOfferWatchDeps): (edgeLowLatency: boolean) => void {
    let checking = false;
    let declined = false;
    return (edgeLowLatency) => {
        if (!edgeLowLatency) {
            declined = false;
            return;
        }
        if (checking || declined || !deps.live() || !deps.wanted() || !edgeReprobeDue(deps.view())) return;
        checking = true;
        void deps.fetchMaster()
            .catch(() => null)
            .then((body) => {
                checking = false;
                if (body === null || !deps.live()) return;
                if (!masterOffersLowLatency(body)) {
                    declined = true;
                    return;
                }
                if (edgeLowLatencyUpgrade(body, deps.view())) deps.switchToLowLatency();
            });
    };
}

export type PartsTransition = "withdrawn" | "restored" | null;

export function partsTransition(hadParts: boolean | null, hasParts: boolean): PartsTransition {
    if (hadParts === null || hadParts === hasParts) return null;
    return hasParts ? "restored" : "withdrawn";
}
