export const DEFAULT_ZONE_CENTER = { lat: 51.513269, lng: -0.131 };
export const DEFAULT_ZONE_RADIUS = 600;
export const MIN_ZONE_RADIUS = 50;
export const DEFAULT_ROUND_SECONDS = 45 * 60;
export const ADMIN_PASSWORD = 'soniya';

export function isAdminPasswordValid(value) {
    return String(value || '').trim().toLowerCase() === ADMIN_PASSWORD;
}

export function normalizeZoneCenter(center) {
    if (!center || center.lat === undefined || center.lng === undefined) {
        return null;
    }

    const lat = Number(center.lat);
    const lng = Number(center.lng);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return null;
    }

    return { lat, lng };
}

export function getZoneRadiusForSeconds(totalSeconds, roundSeconds = DEFAULT_ROUND_SECONDS, minimumRadius = MIN_ZONE_RADIUS) {
    const safeSeconds = Math.max(0, Number(totalSeconds) || 0);
    const safeRoundSeconds = Math.max(1, Number(roundSeconds) || DEFAULT_ROUND_SECONDS);
    const shrinkEverySeconds = 9 * 60;
    const stages = [600, 500, 400, 300, 200, 50];

    if (safeSeconds <= 0) {
        return minimumRadius;
    }

    const elapsedSeconds = Math.max(0, safeRoundSeconds - safeSeconds);
    const completedSteps = Math.floor(Math.min(elapsedSeconds, safeRoundSeconds) / shrinkEverySeconds);
    const radius = stages[Math.min(stages.length - 1, completedSteps)] ? ? minimumRadius;

    return Math.max(minimumRadius, Math.min(DEFAULT_ZONE_RADIUS, radius));
}

export function resetZoneState(center, roundSeconds = DEFAULT_ROUND_SECONDS) {
    return {
        center: normalizeZoneCenter(center),
        radius: DEFAULT_ZONE_RADIUS,
        roundSeconds
    };
}

export function getZoneCenter(zone) {
    if (zone && zone.center) {
        return normalizeZoneCenter(zone.center);
    }
    return null;
}

export function getDataUrlByteLength(dataUrl) {
    if (typeof dataUrl !== 'string' || !dataUrl.includes(',')) {
        return 0;
    }

    const base64 = dataUrl.split(',')[1] || '';
    if (!base64) {
        return 0;
    }

    return Math.ceil((base64.length * 3) / 4);
}

export function shouldCompressDataUrl(dataUrl, maxBytes = 1 _000_000) {
    return getDataUrlByteLength(dataUrl) > maxBytes;
}