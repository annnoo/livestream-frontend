export const SMALL_AVATAR_SIZE = 128;

export function smallAvatarUrl(username: string, version?: number | null): string {
    const path = `/api/live/profile/${encodeURIComponent(username)}/avatar`;
    const versioned = typeof version === "number" && Number.isFinite(version) && version > 0;
    return versioned ? `${path}?v=${version}&s=${SMALL_AVATAR_SIZE}` : `${path}?s=${SMALL_AVATAR_SIZE}`;
}
