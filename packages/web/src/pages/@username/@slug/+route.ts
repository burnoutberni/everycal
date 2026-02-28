// Same as the parent route — we need a Route Function because Vike's `@` parameter
// prefix conflicts with the literal `@` in `/@username/:slug` URLs.
export default function route(pageContext: { urlPathname: string }) {
    const match = pageContext.urlPathname.match(/^\/@([^/]+)\/([^/]+)$/);
    if (!match) return false;
    return {
        routeParams: { username: match[1], slug: match[2] },
    };
}
