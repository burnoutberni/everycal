import { beforeEach } from "vitest";

// Drop bcrypt cost factor to its minimum for the test suite so heavy
// auth flows (login lockout, password change, etc.) don't blow the
// vitest 5s timeout. Production stays at the SALT_ROUNDS=12 default
// resolved in src/middleware/auth.ts. Set at module scope — must run
// before any test file imports the auth module, since SALT_ROUNDS is
// captured once at module load.
process.env.BCRYPT_SALT_ROUNDS ??= "4";

beforeEach(() => {
  process.env.BASE_URL = "http://localhost:3000";
});
