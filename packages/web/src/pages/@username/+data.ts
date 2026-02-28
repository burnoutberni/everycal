import type { PageContextServer } from "vike/types";
import type { SsrInitialData } from "@everycal/core";
import { users as usersApi, auth as authApi, createApiRequestContext } from "../../lib/api";
import { stripHtmlToText } from "../../lib/text";

type ProfilePageContext = PageContextServer & { initialData?: SsrInitialData };

type SsrProfileModel = {
  username: string;
  displayName: string | null;
  bio?: string | null;
  avatarUrl?: string | null;
};

export async function data(pageContext: PageContextServer) {
    const { username } = pageContext.routeParams;
    if (!username) throw new Error("Missing username");

    const initialData = (pageContext as ProfilePageContext).initialData;
    if (initialData?.kind === "profile" && initialData.username === username) {
        const profile = initialData.profile as SsrProfileModel | null;
        return {
            user: initialData.user || null,
            profile,
            events: initialData.events || [],
            title: profile
                ? `${profile.displayName || profile.username} (@${profile.username}) on EveryCal`
                : "Profile not found",
            description: profile
                ? stripHtmlToText(profile.bio || "") || `View ${profile.displayName || profile.username}'s profile and events on EveryCal.`
                : "This profile could not be found on EveryCal.",
            ogImageUrl: profile?.avatarUrl || null,
        };
    }

    const requestContext = createApiRequestContext({
        headersOriginal: pageContext.headersOriginal as Record<string, string | string[] | undefined>,
    });
    const hasSessionCookie = !!requestContext.cookie && /(?:^|;\s*)everycal_session=/.test(requestContext.cookie);
    const authPromise = hasSessionCookie ? authApi.me(requestContext).catch(() => null) : Promise.resolve(null);

    const [profile, eventsData, authRes] = await Promise.all([
        usersApi.get(username, requestContext).catch(() => null),
        usersApi.events(username, { limit: 100, sort: "asc" }, requestContext).catch(() => null),
        authPromise,
    ]);

    if (!profile) {
        return {
            user: authRes || null,
            profile: null,
            events: [],
            title: "Profile not found",
            description: "This profile could not be found on EveryCal.",
            ogImageUrl: null,
        };
    }

    return {
        user: authRes || null,
        profile,
        events: eventsData ? eventsData.events : [],
        title: `${profile.displayName || profile.username} (@${profile.username}) on EveryCal`,
        description: stripHtmlToText(profile.bio || "") || `View ${profile.displayName || profile.username}'s profile and events on EveryCal.`,
        ogImageUrl: profile.avatarUrl || null,
    };
}
