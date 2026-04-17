export function parseRequest(url: string) {
    const clean = decodeURIComponent(url.split("?")[0]);
    const parts = clean.split("/").filter(Boolean);

    const dashIndex = parts.indexOf("-");

    if (dashIndex !== -1) {
        return {
            pkgName: parts.slice(0, dashIndex).join("/"),
            tarball: parts[dashIndex + 1] ?? null
        };
    }

    return {
        pkgName: parts.join("/"),
        tarball: null
    };
}
