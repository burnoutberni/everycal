// Vike uses `@` as its parameter prefix, so we can't use a route string like "/@username"
// because Vike would treat the `@` as a param marker, not a literal character.
// A Route Function lets us match the literal `@` in the URL and strip it from the param.
export default function route(pageContext: { urlPathname: string }) {
    const match = pageContext.urlPathname.match(/^\/@([^/]+)$/);
    if (!match) return false;
    return {
        routeParams: { username: match[1] },
    };
}
