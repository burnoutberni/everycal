import type { Hono } from "hono";
import type { DB } from "../../db.js";
import { createSession, deleteSession, resolveSession } from "../../middleware/auth.js";
import { parseJsonBody } from "../../lib/request-body.js";
import { clearSessionCookie, setSessionCookie } from "./session-cookies.js";
import {
  consumeOidcLoginState,
  createOidcLoginState,
  getLocalAuthConfig,
  getOidcAdapter,
  getOidcProviderConfig,
  isSafeRedirectTo,
  resolveOidcAccount,
  sanitizeOidcErrorCode,
  validateOidcConfig,
} from "../../lib/oidc.js";

function errorRedirect(message: string) {
  return `/login?oidcError=${encodeURIComponent(message)}`;
}

export function registerOidcRoutes(router: Hono, db: DB): void {
  router.get("/oidc/providers", (c) => {
    const config = getOidcProviderConfig();
    const configError = validateOidcConfig(config);
    const local = getLocalAuthConfig();
    return c.json({
      oidcEnabled: config.enabled && !configError,
      configError: config.enabled ? configError : null,
      localPasswordAuthEnabled: !local.passwordAuthDisabled,
      localRegistrationEnabled: !local.registrationDisabled,
      providers: config.enabled && !configError ? [{ providerKey: config.providerKey, label: "Single Sign-On" }] : [],
    });
  });

  router.post("/oidc/start", async (c) => {
    const config = getOidcProviderConfig();
    const configError = validateOidcConfig(config);
    if (!config.enabled || configError) return c.json({ error: configError || "oidc_disabled" }, 503);
    const parsed = await parseJsonBody<{ redirectTo?: string }>(c);
    if (parsed instanceof Response) return parsed;
    const tx = createOidcLoginState(db, config, parsed.redirectTo);
    const authorizationUrl = await getOidcAdapter().buildAuthorizationUrl(config, tx);
    return c.json({ authorizationUrl });
  });

  router.get("/oidc/callback", async (c) => {
    const config = getOidcProviderConfig();
    const configError = validateOidcConfig(config);
    if (!config.enabled || configError) return c.redirect(errorRedirect(configError || "oidc_disabled"));
    const state = c.req.query("state");
    if (!state) return c.redirect(errorRedirect("oidc_invalid_state"));
    try {
      const tx = consumeOidcLoginState(db, config, state);
      const result = await getOidcAdapter().exchangeCallback(config, c.req.url, { state, nonce: tx.nonce, codeVerifier: tx.codeVerifier });
      const account = resolveOidcAccount(db, config, result);
      const session = createSession(db, account.accountId, "oidc");
      setSessionCookie(c, session.token, session.expiresAt);
      const redirectTo = isSafeRedirectTo(tx.redirectTo) || (account.isNew ? "/onboarding" : "/");
      return c.redirect(redirectTo);
    } catch (error) {
      return c.redirect(errorRedirect(sanitizeOidcErrorCode(error)));
    }
  });

  router.post("/oidc/logout", async (c) => {
    const cookieHeader = c.req.header("cookie") || "";
    const sessionMatch = cookieHeader.match(/everycal_session=([^\s;]+)/);
    const token = sessionMatch?.[1];
    const authHeader = c.req.header("authorization") || "";
    const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const sessionToken = token || bearerToken;
    const sessionAuthMethod = sessionToken ? resolveSession(db, sessionToken)?.user.sessionAuthMethod : null;
    if (sessionToken) deleteSession(db, sessionToken);
    clearSessionCookie(c);
    const config = getOidcProviderConfig();
    const logoutUrl = config.enabled && sessionAuthMethod === "oidc"
      ? await getOidcAdapter().buildLogoutUrl(config).catch(() => null)
      : null;
    return c.json({ ok: true, logoutUrl });
  });
}
