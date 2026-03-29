type HttpMethod = "get" | "post" | "put" | "patch" | "delete";
type SchemaObject = Record<string, unknown>;
type SecuritySchemeObject = Record<string, unknown>;
type RequestBodyObject = Record<string, unknown>;
type ResponseObject = Record<string, unknown>;
type ResponsesObject = Record<string, unknown>;
type SecurityRequirementObject = Record<string, string[]>;
type Document = Record<string, any>;
type PathsObject = Record<string, any>;
type OperationObject = Record<string, unknown>;

const ErrorSchema: SchemaObject = {
  type: "object",
  required: ["error"],
  properties: {
    error: { type: "string", description: "Localized human-readable error message." },
  },
};

const SuccessSchema: SchemaObject = {
  type: "object",
  additionalProperties: true,
};

const EventSchema: SchemaObject = {
  type: "object",
  required: ["id", "source", "title", "startDate", "visibility", "createdAt", "updatedAt"],
  properties: {
    id: { type: "string" },
    slug: { type: "string", nullable: true },
    source: { type: "string", enum: ["local", "remote"] },
    accountId: { type: "string", nullable: true },
    actorUri: { type: "string", nullable: true },
    account: { type: "object", additionalProperties: true, nullable: true },
    title: { type: "string" },
    description: { type: "string", nullable: true },
    startDate: { type: "string", format: "date-time" },
    endDate: { type: "string", format: "date-time", nullable: true },
    startAtUtc: { type: "string", format: "date-time", nullable: true },
    endAtUtc: { type: "string", format: "date-time", nullable: true },
    eventTimezone: { type: "string", nullable: true },
    allDay: { type: "boolean" },
    location: { type: "object", additionalProperties: true, nullable: true },
    image: { type: "object", additionalProperties: true, nullable: true },
    tags: { type: "array", items: { type: "string" } },
    visibility: { type: "string", enum: ["public", "unlisted", "followers_only", "private"] },
    url: { type: "string", nullable: true },
    ogImageUrl: { type: "string", nullable: true },
    rsvpStatus: { type: "string", nullable: true },
    reposted: { type: "boolean" },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
};

const SecuritySchemes: Record<string, SecuritySchemeObject> = {
  sessionCookie: {
    type: "apiKey",
    in: "cookie",
    name: "everycal_session",
    description: "Browser session cookie set by auth endpoints.",
  },
  bearerAuth: {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
    description: "API key-style bearer token for bot/scraper access.",
  },
  scraperApiKey: {
    type: "apiKey",
    in: "header",
    name: "x-api-key",
    description: "Scraper integration key where configured.",
  },
};

function jsonBody(schema: SchemaObject, required = true): RequestBodyObject {
  return {
    required,
    content: {
      "application/json": { schema },
    },
  };
}

function responses(codes: Record<string, ResponseObject>): ResponsesObject {
  return codes;
}

function jsonResponse(description: string, schema: SchemaObject): ResponseObject {
  return {
    description,
    content: {
      "application/json": { schema },
    },
  };
}

function errorResponse(description: string): ResponseObject {
  return jsonResponse(description, { $ref: "#/components/schemas/Error" });
}

function secured(security: SecurityRequirementObject[] = [{ sessionCookie: [] }, { bearerAuth: [] }, { scraperApiKey: [] }]) {
  return security;
}

export function buildOpenApiDocument(): Document {
  const paths: PathsObject = {};

  const add = (path: string, method: HttpMethod, operation: OperationObject) => {
    paths[path] ||= {};
    (paths[path] as Record<string, OperationObject>)[method] = operation;
  };

  add("/healthz", "get", { tags: ["System/Well-Known"], operationId: "healthz", summary: "Health check", responses: responses({ "200": jsonResponse("OK", { type: "object", required: ["status"], properties: { status: { type: "string", const: "ok" } } }) }) });
  add("/api/v1/bootstrap", "get", { tags: ["System/Well-Known"], operationId: "bootstrap", summary: "Bootstrap data", responses: responses({ "200": jsonResponse("Bootstrap payload", { type: "object", additionalProperties: true }) }) });

  // Auth
  add("/api/v1/auth/register", "post", { tags: ["Auth"], operationId: "register", requestBody: jsonBody({ type: "object", required: ["username"], properties: { username: { type: "string" }, email: { type: "string", format: "email" }, password: { type: "string", minLength: 8 }, displayName: { type: "string" }, city: { type: "string" }, cityLat: { type: "number" }, cityLng: { type: "number" }, isBot: { type: "boolean" } } }), responses: responses({ "201": jsonResponse("Created", SuccessSchema), "400": errorResponse("Invalid input"), "403": errorResponse("Closed registrations"), "409": errorResponse("Conflict") }) });
  add("/api/v1/auth/verify-email", "get", { tags: ["Auth"], operationId: "verifyEmail", parameters: [{ in: "query", name: "token", required: true, schema: { type: "string" } }], responses: responses({ "200": jsonResponse("Verified", SuccessSchema), "400": errorResponse("Invalid token") }) });
  add("/api/v1/auth/request-email-change", "post", { tags: ["Auth"], operationId: "requestEmailChange", security: secured(), requestBody: jsonBody({ type: "object", required: ["email"], properties: { email: { type: "string", format: "email" } } }), responses: responses({ "200": jsonResponse("Verification requested", SuccessSchema), "400": errorResponse("Invalid request"), "401": errorResponse("Unauthorized"), "409": errorResponse("Conflict") }) });
  add("/api/v1/auth/change-password", "post", { tags: ["Auth"], operationId: "changePassword", security: secured(), requestBody: jsonBody({ type: "object", required: ["currentPassword", "newPassword"], properties: { currentPassword: { type: "string" }, newPassword: { type: "string", minLength: 8 } } }), responses: responses({ "200": jsonResponse("Password changed", SuccessSchema), "400": errorResponse("Invalid request"), "401": errorResponse("Unauthorized") }) });
  add("/api/v1/auth/login", "post", { tags: ["Auth"], operationId: "login", requestBody: jsonBody({ type: "object", required: ["username", "password"], properties: { username: { type: "string" }, password: { type: "string" } } }), responses: responses({ "200": jsonResponse("Logged in", SuccessSchema), "400": errorResponse("Invalid request"), "401": errorResponse("Invalid credentials") }) });
  add("/api/v1/auth/forgot-password", "post", { tags: ["Auth"], operationId: "forgotPassword", requestBody: jsonBody({ type: "object", required: ["email"], properties: { email: { type: "string", format: "email" } } }), responses: responses({ "200": jsonResponse("Email sent", SuccessSchema), "400": errorResponse("Invalid request") }) });
  add("/api/v1/auth/reset-password", "post", { tags: ["Auth"], operationId: "resetPassword", requestBody: jsonBody({ type: "object", required: ["token", "password"], properties: { token: { type: "string" }, password: { type: "string", minLength: 8 } } }), responses: responses({ "200": jsonResponse("Password reset", SuccessSchema), "400": errorResponse("Invalid token") }) });
  add("/api/v1/auth/logout", "post", { tags: ["Auth"], operationId: "logout", security: secured(), responses: responses({ "200": jsonResponse("Logged out", SuccessSchema), "401": errorResponse("Unauthorized") }) });
  add("/api/v1/auth/me", "get", { tags: ["Auth"], operationId: "me", security: secured(), responses: responses({ "200": jsonResponse("Current user", SuccessSchema), "401": errorResponse("Unauthorized") }) });
  add("/api/v1/auth/me", "patch", { tags: ["Auth"], operationId: "updateMe", security: secured(), requestBody: jsonBody({ type: "object", additionalProperties: true }), responses: responses({ "200": jsonResponse("Updated", SuccessSchema), "400": errorResponse("Invalid request"), "401": errorResponse("Unauthorized") }) });
  add("/api/v1/auth/me", "delete", { tags: ["Auth"], operationId: "deleteMe", security: secured(), responses: responses({ "200": jsonResponse("Deleted", SuccessSchema), "401": errorResponse("Unauthorized") }) });
  add("/api/v1/auth/notification-prefs", "patch", { tags: ["Auth"], operationId: "updateNotificationPrefs", security: secured(), requestBody: jsonBody({ type: "object", additionalProperties: true }), responses: responses({ "200": jsonResponse("Updated", SuccessSchema), "400": errorResponse("Invalid request"), "401": errorResponse("Unauthorized") }) });
  add("/api/v1/auth/api-keys", "get", { tags: ["Auth"], operationId: "listApiKeys", security: secured(), responses: responses({ "200": jsonResponse("API keys", { type: "array", items: { type: "object", additionalProperties: true } }), "401": errorResponse("Unauthorized") }) });
  add("/api/v1/auth/api-keys", "post", { tags: ["Auth"], operationId: "createApiKey", security: secured(), requestBody: jsonBody({ type: "object", properties: { name: { type: "string" } } }, false), responses: responses({ "201": jsonResponse("Created", SuccessSchema), "401": errorResponse("Unauthorized") }) });
  add("/api/v1/auth/api-keys/{id}", "delete", { tags: ["Auth"], operationId: "deleteApiKey", security: secured(), parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }], responses: responses({ "200": jsonResponse("Deleted", SuccessSchema), "401": errorResponse("Unauthorized"), "404": errorResponse("Not found") }) });

  // Events
  add("/api/v1/events/tags", "get", { tags: ["Events"], operationId: "listTags", responses: responses({ "200": jsonResponse("Tags", { type: "array", items: { type: "string" } }) }) });
  add("/api/v1/events", "get", { tags: ["Events"], operationId: "listEvents", parameters: [{ in: "query", name: "from", schema: { type: "string", format: "date-time" } }, { in: "query", name: "to", schema: { type: "string", format: "date-time" } }, { in: "query", name: "tags", schema: { type: "string" } }, { in: "query", name: "limit", schema: { type: "integer", minimum: 1, maximum: 200 } }, { in: "query", name: "account", schema: { type: "string" } }, { in: "query", name: "includeRemote", schema: { type: "boolean" } }], responses: responses({ "200": jsonResponse("Event list", { type: "array", items: { $ref: "#/components/schemas/Event" } }) }) });
  add("/api/v1/events", "post", { tags: ["Events"], operationId: "createEvent", security: secured(), requestBody: jsonBody({ type: "object", required: ["title", "startDate"], properties: { title: { type: "string" }, description: { type: "string" }, startDate: { type: "string", format: "date-time" }, endDate: { type: "string", format: "date-time" }, timezone: { type: "string" }, allDay: { type: "boolean" }, tags: { type: "array", items: { type: "string" } }, visibility: { type: "string" }, location: { type: "object", additionalProperties: true }, image: { type: "object", additionalProperties: true }, actorSelection: { type: "object", additionalProperties: true } } }), responses: responses({ "201": jsonResponse("Created", { $ref: "#/components/schemas/Event" }), "400": errorResponse("Invalid request"), "401": errorResponse("Unauthorized") }) });
  add("/api/v1/events/rsvp", "post", { tags: ["Events"], operationId: "setRsvp", security: secured(), requestBody: jsonBody({ type: "object", required: ["eventUri", "status"], properties: { eventUri: { type: "string" }, status: { type: "string", enum: ["yes", "no", "maybe", "interested"] } } }), responses: responses({ "200": jsonResponse("RSVP stored", SuccessSchema), "400": errorResponse("Invalid request"), "401": errorResponse("Unauthorized") }) });
  add("/api/v1/events/timeline", "get", { tags: ["Events"], operationId: "timeline", security: secured(), responses: responses({ "200": jsonResponse("Timeline", { type: "array", items: { $ref: "#/components/schemas/Event" } }), "401": errorResponse("Unauthorized") }) });
  add("/api/v1/events/sync", "post", { tags: ["Events"], operationId: "syncEvents", security: secured([{ scraperApiKey: [] }, { sessionCookie: [] }]), requestBody: jsonBody({ type: "object", additionalProperties: true }), responses: responses({ "200": jsonResponse("Synced", SuccessSchema), "400": errorResponse("Invalid request"), "401": errorResponse("Unauthorized") }) });
  add("/api/v1/events/by-slug/{username}/{slug}", "get", { tags: ["Events"], operationId: "getEventBySlug", parameters: [{ in: "path", name: "username", required: true, schema: { type: "string" } }, { in: "path", name: "slug", required: true, schema: { type: "string" } }], responses: responses({ "200": jsonResponse("Event", { $ref: "#/components/schemas/Event" }), "404": errorResponse("Not found") }) });
  add("/api/v1/events/resolve", "get", { tags: ["Events"], operationId: "resolveEvent", parameters: [{ in: "query", name: "url", required: true, schema: { type: "string", format: "uri" } }], responses: responses({ "200": jsonResponse("Resolved", SuccessSchema), "400": errorResponse("Invalid URL"), "404": errorResponse("Not found") }) });
  add("/api/v1/events/{id}", "get", { tags: ["Events"], operationId: "getEvent", parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }], responses: responses({ "200": jsonResponse("Event", { $ref: "#/components/schemas/Event" }), "403": errorResponse("Forbidden"), "404": errorResponse("Not found") }) });
  add("/api/v1/events/{id}", "put", { tags: ["Events"], operationId: "updateEvent", security: secured(), parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }], requestBody: jsonBody({ type: "object", additionalProperties: true }), responses: responses({ "200": jsonResponse("Updated", { $ref: "#/components/schemas/Event" }), "400": errorResponse("Invalid request"), "401": errorResponse("Unauthorized"), "403": errorResponse("Forbidden"), "404": errorResponse("Not found") }) });
  add("/api/v1/events/{id}", "delete", { tags: ["Events"], operationId: "deleteEvent", security: secured(), parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }], responses: responses({ "200": jsonResponse("Deleted", SuccessSchema), "401": errorResponse("Unauthorized"), "403": errorResponse("Forbidden"), "404": errorResponse("Not found") }) });
  add("/api/v1/events/{id}/repost", "post", { tags: ["Events"], operationId: "repostEvent", security: secured(), parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }], responses: responses({ "200": jsonResponse("Reposted", SuccessSchema), "401": errorResponse("Unauthorized"), "404": errorResponse("Not found") }) });
  add("/api/v1/events/{id}/repost", "delete", { tags: ["Events"], operationId: "undoRepostEvent", security: secured(), parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }], responses: responses({ "200": jsonResponse("Deleted", SuccessSchema), "401": errorResponse("Unauthorized"), "404": errorResponse("Not found") }) });
  add("/api/v1/events/{id}/repost-actors", "get", { tags: ["Events"], operationId: "eventRepostActors", security: secured(), parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }], responses: responses({ "200": jsonResponse("Actors", { type: "array", items: { type: "object", additionalProperties: true } }), "401": errorResponse("Unauthorized") }) });

  // Feeds
  add("/api/v1/feeds/{file}", "get", { tags: ["Feeds"], operationId: "publicFeed", parameters: [{ in: "path", name: "file", required: true, schema: { type: "string" } }], responses: responses({ "200": { description: "JSON or iCal feed", content: { "application/json": { schema: { type: "object", additionalProperties: true } }, "text/calendar": { schema: { type: "string" } } } }, "404": errorResponse("Not found") }) });
  add("/api/v1/private-feeds/calendar-url", "get", { tags: ["Feeds"], operationId: "privateFeedUrl", security: secured(), responses: responses({ "200": jsonResponse("Tokenized private feed URL", SuccessSchema), "401": errorResponse("Unauthorized") }) });
  add("/api/v1/private-feeds/calendar.ics", "get", { tags: ["Feeds"], operationId: "privateFeedIcs", parameters: [{ in: "query", name: "token", required: true, schema: { type: "string" } }], responses: responses({ "200": { description: "Calendar data", content: { "text/calendar": { schema: { type: "string" } } } }, "401": errorResponse("Unauthorized"), "404": errorResponse("Not found") }) });

  // Users
  add("/api/v1/users", "get", { tags: ["Users"], operationId: "listUsers", parameters: [{ in: "query", name: "q", schema: { type: "string" } }, { in: "query", name: "limit", schema: { type: "integer", minimum: 1, maximum: 100 } }], responses: responses({ "200": jsonResponse("Users", { type: "array", items: { type: "object", additionalProperties: true } }) }) });
  add("/api/v1/users/{username}", "get", { tags: ["Users"], operationId: "getUser", parameters: [{ in: "path", name: "username", required: true, schema: { type: "string" } }], responses: responses({ "200": jsonResponse("User", SuccessSchema), "404": errorResponse("Not found") }) });
  add("/api/v1/users/{username}/events", "get", { tags: ["Users"], operationId: "userEvents", parameters: [{ in: "path", name: "username", required: true, schema: { type: "string" } }, { in: "query", name: "from", schema: { type: "string", format: "date-time" } }, { in: "query", name: "to", schema: { type: "string", format: "date-time" } }], responses: responses({ "200": jsonResponse("Events", { type: "array", items: { $ref: "#/components/schemas/Event" } }) }) });
  add("/api/v1/users/{username}/follow", "post", { tags: ["Users"], operationId: "followUser", security: secured(), parameters: [{ in: "path", name: "username", required: true, schema: { type: "string" } }], responses: responses({ "200": jsonResponse("Followed", SuccessSchema), "401": errorResponse("Unauthorized"), "404": errorResponse("Not found") }) });
  add("/api/v1/users/{username}/unfollow", "post", { tags: ["Users"], operationId: "unfollowUser", security: secured(), parameters: [{ in: "path", name: "username", required: true, schema: { type: "string" } }], responses: responses({ "200": jsonResponse("Unfollowed", SuccessSchema), "401": errorResponse("Unauthorized"), "404": errorResponse("Not found") }) });
  add("/api/v1/users/{username}/auto-repost", "post", { tags: ["Users"], operationId: "enableAutoRepost", security: secured(), parameters: [{ in: "path", name: "username", required: true, schema: { type: "string" } }], responses: responses({ "200": jsonResponse("Enabled", SuccessSchema), "401": errorResponse("Unauthorized") }) });
  add("/api/v1/users/{username}/auto-repost", "delete", { tags: ["Users"], operationId: "disableAutoRepost", security: secured(), parameters: [{ in: "path", name: "username", required: true, schema: { type: "string" } }], responses: responses({ "200": jsonResponse("Disabled", SuccessSchema), "401": errorResponse("Unauthorized") }) });
  add("/api/v1/users/{username}/follow-actors", "get", { tags: ["Users"], operationId: "followActors", security: secured(), parameters: [{ in: "path", name: "username", required: true, schema: { type: "string" } }], responses: responses({ "200": jsonResponse("Actors", { type: "array", items: { type: "object", additionalProperties: true } }), "401": errorResponse("Unauthorized") }) });
  add("/api/v1/users/{username}/auto-repost-actors", "get", { tags: ["Users"], operationId: "autoRepostActors", security: secured(), parameters: [{ in: "path", name: "username", required: true, schema: { type: "string" } }], responses: responses({ "200": jsonResponse("Actors", { type: "array", items: { type: "object", additionalProperties: true } }), "401": errorResponse("Unauthorized") }) });
  add("/api/v1/users/{username}/followers", "get", { tags: ["Users"], operationId: "followers", parameters: [{ in: "path", name: "username", required: true, schema: { type: "string" } }], responses: responses({ "200": jsonResponse("Followers", { type: "array", items: { type: "object", additionalProperties: true } }) }) });
  add("/api/v1/users/{username}/following", "get", { tags: ["Users"], operationId: "following", parameters: [{ in: "path", name: "username", required: true, schema: { type: "string" } }], responses: responses({ "200": jsonResponse("Following", { type: "array", items: { type: "object", additionalProperties: true } }) }) });

  // Identities
  add("/api/v1/identities", "get", { tags: ["Identities"], operationId: "listIdentities", security: secured(), responses: responses({ "200": jsonResponse("Identities", { type: "array", items: { type: "object", additionalProperties: true } }), "401": errorResponse("Unauthorized") }) });
  add("/api/v1/identities", "post", { tags: ["Identities"], operationId: "createIdentity", security: secured(), requestBody: jsonBody({ type: "object", required: ["username", "displayName"], properties: { username: { type: "string" }, displayName: { type: "string" }, summary: { type: "string" } } }), responses: responses({ "201": jsonResponse("Created", SuccessSchema), "400": errorResponse("Invalid"), "401": errorResponse("Unauthorized"), "409": errorResponse("Conflict") }) });
  add("/api/v1/identities/{username}", "patch", { tags: ["Identities"], operationId: "updateIdentity", security: secured(), parameters: [{ in: "path", name: "username", required: true, schema: { type: "string" } }], requestBody: jsonBody({ type: "object", additionalProperties: true }), responses: responses({ "200": jsonResponse("Updated", SuccessSchema), "401": errorResponse("Unauthorized"), "403": errorResponse("Forbidden"), "404": errorResponse("Not found") }) });
  add("/api/v1/identities/{username}", "delete", { tags: ["Identities"], operationId: "deleteIdentity", security: secured(), parameters: [{ in: "path", name: "username", required: true, schema: { type: "string" } }], responses: responses({ "200": jsonResponse("Deleted", SuccessSchema), "401": errorResponse("Unauthorized"), "403": errorResponse("Forbidden"), "404": errorResponse("Not found") }) });
  add("/api/v1/identities/{username}/members", "get", { tags: ["Identities"], operationId: "listIdentityMembers", security: secured(), parameters: [{ in: "path", name: "username", required: true, schema: { type: "string" } }], responses: responses({ "200": jsonResponse("Members", { type: "array", items: { type: "object", additionalProperties: true } }), "401": errorResponse("Unauthorized") }) });
  add("/api/v1/identities/{username}/members", "post", { tags: ["Identities"], operationId: "addIdentityMember", security: secured(), parameters: [{ in: "path", name: "username", required: true, schema: { type: "string" } }], requestBody: jsonBody({ type: "object", required: ["memberUsername", "role"], properties: { memberUsername: { type: "string" }, role: { type: "string", enum: ["viewer", "editor", "owner"] } } }), responses: responses({ "201": jsonResponse("Created", SuccessSchema), "400": errorResponse("Invalid"), "401": errorResponse("Unauthorized"), "403": errorResponse("Forbidden") }) });
  add("/api/v1/identities/{username}/members/{memberId}", "patch", { tags: ["Identities"], operationId: "updateIdentityMember", security: secured(), parameters: [{ in: "path", name: "username", required: true, schema: { type: "string" } }, { in: "path", name: "memberId", required: true, schema: { type: "string" } }], requestBody: jsonBody({ type: "object", required: ["role"], properties: { role: { type: "string", enum: ["viewer", "editor", "owner"] } } }), responses: responses({ "200": jsonResponse("Updated", SuccessSchema), "400": errorResponse("Invalid"), "401": errorResponse("Unauthorized"), "403": errorResponse("Forbidden") }) });
  add("/api/v1/identities/{username}/members/{memberId}", "delete", { tags: ["Identities"], operationId: "removeIdentityMember", security: secured(), parameters: [{ in: "path", name: "username", required: true, schema: { type: "string" } }, { in: "path", name: "memberId", required: true, schema: { type: "string" } }], responses: responses({ "200": jsonResponse("Deleted", SuccessSchema), "401": errorResponse("Unauthorized"), "403": errorResponse("Forbidden") }) });

  // Locations, uploads, media
  add("/api/v1/locations", "get", { tags: ["Locations"], operationId: "listLocations", security: secured(), responses: responses({ "200": jsonResponse("Locations", { type: "array", items: { type: "object", additionalProperties: true } }), "401": errorResponse("Unauthorized") }) });
  add("/api/v1/locations", "post", { tags: ["Locations"], operationId: "createLocation", security: secured(), requestBody: jsonBody({ type: "object", required: ["name", "lat", "lng"], properties: { name: { type: "string" }, address: { type: "string" }, lat: { type: "number" }, lng: { type: "number" }, url: { type: "string", format: "uri" } } }), responses: responses({ "201": jsonResponse("Created", SuccessSchema), "400": errorResponse("Invalid"), "401": errorResponse("Unauthorized") }) });
  add("/api/v1/locations/{id}", "delete", { tags: ["Locations"], operationId: "deleteLocation", security: secured(), parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }], responses: responses({ "200": jsonResponse("Deleted", SuccessSchema), "401": errorResponse("Unauthorized") }) });

  add("/api/v1/uploads", "post", { tags: ["Uploads/Media"], operationId: "uploadMedia", security: secured(), requestBody: { required: true, content: { "multipart/form-data": { schema: { type: "object", required: ["file"], properties: { file: { type: "string", format: "binary" }, alt: { type: "string" } } } } } }, responses: responses({ "201": jsonResponse("Uploaded", SuccessSchema), "400": errorResponse("Invalid upload"), "401": errorResponse("Unauthorized"), "413": errorResponse("Payload too large") }) });
  add("/uploads/{filename}", "get", { tags: ["Uploads/Media"], operationId: "serveUpload", parameters: [{ in: "path", name: "filename", required: true, schema: { type: "string" } }], responses: responses({ "200": { description: "Image bytes", content: { "image/*": { schema: { type: "string", format: "binary" } } } }, "404": errorResponse("Not found") }) });
  add("/api/v1/og-images", "post", { tags: ["Uploads/Media"], operationId: "createOgImage", security: secured(), requestBody: jsonBody({ type: "object", required: ["eventId"], properties: { eventId: { type: "string" } } }), responses: responses({ "200": jsonResponse("Generated", SuccessSchema), "400": errorResponse("Invalid"), "401": errorResponse("Unauthorized") }) });
  add("/og-images/{ogImageUrl}", "get", { tags: ["Uploads/Media"], operationId: "serveOgImage", parameters: [{ in: "path", name: "ogImageUrl", required: true, schema: { type: "string" } }], responses: responses({ "200": { description: "Image bytes", content: { "image/*": { schema: { type: "string", format: "binary" } } } }, "404": errorResponse("Not found") }) });
  add("/api/v1/images/sources", "get", { tags: ["Uploads/Media"], operationId: "imageSources", responses: responses({ "200": jsonResponse("Sources", { type: "array", items: { type: "object", additionalProperties: true } }) }) });
  add("/api/v1/images/trigger-download", "post", { tags: ["Uploads/Media"], operationId: "triggerImageDownload", security: secured([{ scraperApiKey: [] }, { sessionCookie: [] }]), requestBody: jsonBody({ type: "object", required: ["url"], properties: { url: { type: "string", format: "uri" } } }), responses: responses({ "200": jsonResponse("Queued", SuccessSchema), "400": errorResponse("Invalid URL"), "401": errorResponse("Unauthorized") }) });
  add("/api/v1/images/search", "get", { tags: ["Uploads/Media"], operationId: "searchImages", parameters: [{ in: "query", name: "q", required: true, schema: { type: "string" } }, { in: "query", name: "source", schema: { type: "string" } }, { in: "query", name: "page", schema: { type: "integer", minimum: 1 } }], responses: responses({ "200": jsonResponse("Search results", SuccessSchema), "400": errorResponse("Invalid query") }) });

  // Federation API
  add("/api/v1/federation/search", "get", { tags: ["Federation"], operationId: "federationSearch", security: secured(), parameters: [{ in: "query", name: "q", required: true, schema: { type: "string" } }], responses: responses({ "200": jsonResponse("Actors", { type: "array", items: { type: "object", additionalProperties: true } }), "400": errorResponse("Invalid query"), "401": errorResponse("Unauthorized") }) });
  add("/api/v1/federation/fetch-actor", "post", { tags: ["Federation"], operationId: "fetchActor", security: secured(), requestBody: jsonBody({ type: "object", required: ["uri"], properties: { uri: { type: "string", format: "uri" } } }), responses: responses({ "200": jsonResponse("Actor", SuccessSchema), "400": errorResponse("Invalid uri"), "401": errorResponse("Unauthorized") }) });
  add("/api/v1/federation/follow", "post", { tags: ["Federation"], operationId: "followActor", security: secured(), requestBody: jsonBody({ type: "object", required: ["actorUri"], properties: { actorUri: { type: "string", format: "uri" } } }), responses: responses({ "200": jsonResponse("Followed", SuccessSchema), "400": errorResponse("Invalid"), "401": errorResponse("Unauthorized") }) });
  add("/api/v1/federation/follow-actors", "get", { tags: ["Federation"], operationId: "federationFollowActors", security: secured(), responses: responses({ "200": jsonResponse("Actors", { type: "array", items: { type: "object", additionalProperties: true } }), "401": errorResponse("Unauthorized") }) });
  add("/api/v1/federation/unfollow", "post", { tags: ["Federation"], operationId: "unfollowActor", security: secured(), requestBody: jsonBody({ type: "object", required: ["actorUri"], properties: { actorUri: { type: "string", format: "uri" } } }), responses: responses({ "200": jsonResponse("Unfollowed", SuccessSchema), "400": errorResponse("Invalid"), "401": errorResponse("Unauthorized") }) });
  add("/api/v1/federation/remote-events", "get", { tags: ["Federation"], operationId: "remoteEvents", parameters: [{ in: "query", name: "actorUri", schema: { type: "string", format: "uri" } }, { in: "query", name: "limit", schema: { type: "integer", minimum: 1, maximum: 200 } }], responses: responses({ "200": jsonResponse("Remote events", { type: "array", items: { $ref: "#/components/schemas/Event" } }) }) });
  add("/api/v1/federation/following", "get", { tags: ["Federation"], operationId: "federationFollowing", security: secured(), responses: responses({ "200": jsonResponse("Following", { type: "array", items: { type: "object", additionalProperties: true } }), "401": errorResponse("Unauthorized") }) });
  add("/api/v1/federation/refresh-actors", "post", { tags: ["Federation"], operationId: "refreshActors", security: secured(), requestBody: jsonBody({ type: "object", properties: { actorUris: { type: "array", items: { type: "string", format: "uri" } } } }, false), responses: responses({ "200": jsonResponse("Refreshed", SuccessSchema), "401": errorResponse("Unauthorized") }) });
  add("/api/v1/federation/actors", "get", { tags: ["Federation"], operationId: "listFederatedActors", responses: responses({ "200": jsonResponse("Actors", { type: "array", items: { type: "object", additionalProperties: true } }) }) });

  // Directory
  add("/api/v1/directory", "get", { tags: ["Users"], operationId: "directory", parameters: [{ in: "query", name: "q", schema: { type: "string" } }, { in: "query", name: "limit", schema: { type: "integer", minimum: 1, maximum: 200 } }], responses: responses({ "200": jsonResponse("Directory", { type: "array", items: { type: "object", additionalProperties: true } }) }) });

  // ActivityPub + well-known
  add("/.well-known/webfinger", "get", { tags: ["ActivityPub"], operationId: "webfinger", parameters: [{ in: "query", name: "resource", required: true, schema: { type: "string" } }], responses: responses({ "200": jsonResponse("JRD", { type: "object", additionalProperties: true }), "404": errorResponse("Not found") }) });
  add("/.well-known/nodeinfo", "get", { tags: ["ActivityPub", "System/Well-Known"], operationId: "nodeInfoDiscovery", responses: responses({ "200": jsonResponse("NodeInfo discovery", { type: "object", additionalProperties: true }) }) });
  add("/.well-known/host-meta", "get", { tags: ["ActivityPub", "System/Well-Known"], operationId: "hostMeta", responses: responses({ "200": { description: "XRD", content: { "application/xrd+xml": { schema: { type: "string" } }, "application/xml": { schema: { type: "string" } } } } }) });
  add("/nodeinfo/2.0", "get", { tags: ["ActivityPub", "System/Well-Known"], operationId: "nodeInfo20", responses: responses({ "200": jsonResponse("NodeInfo 2.0", { type: "object", additionalProperties: true }) }) });

  add("/users/{username}", "get", { tags: ["ActivityPub"], operationId: "apActor", parameters: [{ in: "path", name: "username", required: true, schema: { type: "string" } }, { in: "header", name: "accept", schema: { type: "string" } }], responses: responses({ "200": { description: "Actor JSON-LD or profile page", content: { "application/activity+json": { schema: { type: "object", additionalProperties: true } }, "application/ld+json": { schema: { type: "object", additionalProperties: true } }, "text/html": { schema: { type: "string" } } } }, "404": errorResponse("Not found") }) });
  add("/users/{username}/outbox", "get", { tags: ["ActivityPub"], operationId: "apOutbox", parameters: [{ in: "path", name: "username", required: true, schema: { type: "string" } }], responses: responses({ "200": jsonResponse("Outbox", { type: "object", additionalProperties: true }), "404": errorResponse("Not found") }) });
  add("/users/{username}/followers", "get", { tags: ["ActivityPub"], operationId: "apFollowers", parameters: [{ in: "path", name: "username", required: true, schema: { type: "string" } }], responses: responses({ "200": jsonResponse("Followers", { type: "object", additionalProperties: true }), "404": errorResponse("Not found") }) });
  add("/users/{username}/following", "get", { tags: ["ActivityPub"], operationId: "apFollowing", parameters: [{ in: "path", name: "username", required: true, schema: { type: "string" } }], responses: responses({ "200": jsonResponse("Following", { type: "object", additionalProperties: true }), "404": errorResponse("Not found") }) });
  add("/users/{username}/inbox", "post", { tags: ["ActivityPub"], operationId: "apUserInbox", parameters: [{ in: "path", name: "username", required: true, schema: { type: "string" } }, { in: "header", name: "signature", schema: { type: "string" } }, { in: "header", name: "digest", schema: { type: "string" } }], requestBody: jsonBody({ type: "object", additionalProperties: true }), responses: responses({ "202": jsonResponse("Accepted", SuccessSchema), "400": errorResponse("Invalid activity"), "404": errorResponse("Not found") }) });
  add("/inbox", "post", { tags: ["ActivityPub"], operationId: "apSharedInbox", parameters: [{ in: "header", name: "signature", schema: { type: "string" } }, { in: "header", name: "digest", schema: { type: "string" } }], requestBody: jsonBody({ type: "object", additionalProperties: true }), responses: responses({ "202": jsonResponse("Accepted", SuccessSchema), "400": errorResponse("Invalid activity") }) });
  add("/events/{id}", "get", { tags: ["ActivityPub"], operationId: "apEventObject", parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }], responses: responses({ "200": jsonResponse("ActivityStreams Event", { type: "object", additionalProperties: true }), "404": errorResponse("Not found") }) });

  return {
    openapi: "3.1.0",
    info: {
      title: "EveryCal API",
      version: "1.0.0",
      description: "Code-defined OpenAPI documentation for EveryCal server APIs including ActivityPub federation surfaces.",
    },
    servers: [{ url: "/" }],
    tags: [
      { name: "ActivityPub", description: "Federation and ActivityStreams endpoints." },
      { name: "Auth" },
      { name: "Events" },
      { name: "Users" },
      { name: "Federation" },
      { name: "Feeds" },
      { name: "Identities" },
      { name: "Locations" },
      { name: "Uploads/Media" },
      { name: "System/Well-Known" },
    ],
    paths,
    components: {
      securitySchemes: SecuritySchemes,
      schemas: {
        Error: ErrorSchema,
        Event: EventSchema,
      },
    },
  };
}

function quote(str: string): string {
  if (/^[a-zA-Z0-9_./:-]+$/.test(str)) return str;
  return JSON.stringify(str);
}

function toYaml(value: unknown, indent = 0): string {
  const space = "  ".repeat(indent);
  if (value === null) return "null";
  if (typeof value === "string") return quote(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value
      .map((item) => {
        const rendered = toYaml(item, indent + 1);
        if (rendered.includes("\n")) {
          return `${space}-\n${rendered
            .split("\n")
            .map((line) => `${space}  ${line}`)
            .join("\n")}`;
        }
        return `${space}- ${rendered}`;
      })
      .join("\n");
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return "{}";
    return entries
      .map(([k, v]) => {
        const rendered = toYaml(v, indent + 1);
        if (rendered.includes("\n")) {
          return `${space}${quote(k)}:\n${rendered}`;
        }
        return `${space}${quote(k)}: ${rendered}`;
      })
      .join("\n");
  }
  return "null";
}

export function buildOpenApiYaml(): string {
  return `${toYaml(buildOpenApiDocument())}\n`;
}

export function validateOpenApiDoc(): { ok: boolean; issues: string[] } {
  const document = buildOpenApiDocument();
  const issues: string[] = [];
  if (document.openapi !== "3.1.0") issues.push(`Expected openapi=3.1.0, got ${document.openapi}`);
  if (!document.paths || Object.keys(document.paths).length === 0) issues.push("No paths declared.");
  if (!document.components?.securitySchemes) issues.push("No security schemes declared.");
  if (!document.tags?.some((t: { name?: string }) => t.name === "ActivityPub")) issues.push("Missing ActivityPub tag.");
  return { ok: issues.length === 0, issues };
}
