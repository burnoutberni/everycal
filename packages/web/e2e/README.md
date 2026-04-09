# EveryCal E2E Tests

This directory contains comprehensive end-to-end tests for the EveryCal web frontend using Playwright.

## Test Structure

```
e2e/
├── fixtures/
│   ├── auth.ts      # Authentication fixtures and test user helpers
│   ├── users.ts     # User creation and management helpers
│   └── events.ts    # Event creation and management helpers
├── test-utils.ts    # Shared test utilities and helpers
├── auth.spec.ts     # Authentication tests (login, register, logout, etc.)
├── events.spec.ts   # Event management tests (CRUD, RSVP, repost)
├── profile.spec.ts  # Profile viewing and editing tests
├── calendar.spec.ts # Calendar view tests (month/week/day, MiniCalendar)
├── discover.spec.ts # Federation and discovery tests
├── settings.spec.ts # Settings page tests (profile, password, API keys, identities)
├── responsive.spec.ts # Responsive design tests (mobile/tablet/desktop)
├── i18n.spec.ts     # Internationalization tests (en/de)
├── accessibility.spec.ts # Accessibility tests (keyboard nav, screen reader)
└── errors.spec.ts   # Error handling tests (404, validation, API errors)
```

## Running Tests

### Prerequisites

1. Install dependencies:
   ```bash
   pnpm install
   ```

2. Install Playwright browsers:
   ```bash
   pnpm --filter @everycal/web exec playwright install
   ```

### Run All Tests

```bash
pnpm --filter @everycal/web test:e2e
```

### Run Specific Tests

```bash
# Run a specific test file
pnpm --filter @everycal/web test:e2e auth.spec.ts

# Run tests matching a pattern
pnpm --filter @everycal/web test:e2e -g "login"
```

### Interactive Debugging

```bash
# Run with UI mode for debugging
pnpm --filter @everycal/web test:e2e:ui

# Run in headed mode to see the browser
pnpm --filter @everycal/web test:e2e:headed

# Debug mode with step-through
pnpm --filter @everycal/web test:e2e:debug
```

### View Test Report

After running tests, open the HTML report:

```bash
pnpm --filter @everycal/web exec playwright show-report
```

## Test Configuration

Tests are configured in `playwright.config.ts` at the web package root:

- **Browsers**: Chromium, Firefox, WebKit, Mobile Chrome (iPhone 14)
- **Base URL**: http://localhost:3000
- **Web Server**: Automatically starts the dev server
- **Retries**: 2 in CI
- **Parallel**: Yes (4 workers in CI)
- **Traces**: On first retry
- **Screenshots**: On failure
- **Video**: On failure

## Test Patterns

### Authentication Fixtures

Tests that require authentication use the `authenticatedPage` fixture:

```typescript
test("should show user profile", async ({ authenticatedPage }) => {
  const page = authenticatedPage;
  // User is already logged in and onboarding is complete
  await page.goto("/settings");
  // ...
});
```

### Creating Test Data

Use the helper fixtures to create test data:

```typescript
test("should show events", async ({ authenticatedPage, request }) => {
  // Create test event via API
  const event = await eventHelper.create(request, {
    title: "Test Event",
    tags: ["test"],
  });
  // ...
});
```

### API Mocking

For tests that need to mock API responses:

```typescript
test("should handle API error", async ({ authenticatedPage }) => {
  await page.route("**/api/v1/events", (route) => {
    route.fulfill({ status: 500, body: JSON.stringify({ error: "Error" }) });
  });
  // ...
});
```

## CI Integration

Tests run automatically in GitHub Actions on:
- Push to `main` branch
- Pull requests to `main`

The workflow:
1. Sets up Node.js 22 and pnpm
2. Installs dependencies
3. Installs Playwright browsers
4. Builds the project
5. Runs E2E tests
6. Uploads reports and traces on failure

## Coverage Goals

The test suite aims for 90%+ coverage of:
- All 15 routes (home, calendar, discover, create, profile, settings, auth flows)
- All major user interactions (event CRUD, RSVP, follow/unfollow, settings)
- Responsive breakpoints (mobile, tablet, desktop)
- Internationalization (English, German)
- Accessibility features (keyboard navigation, screen reader support)
- Error handling (404, validation, API errors)

## Best Practices

1. **Use semantic selectors**: Prefer `getByRole`, `getByText`, `getByLabel` over CSS selectors
2. **Wait for network idle**: Use `waitForLoadState('networkidle')` after navigation
3. **Handle async operations**: Use `waitFor` and `expect` with timeouts
4. **Isolate test data**: Create unique test data per test to avoid conflicts
5. **Clean up**: Tests should clean up any created data (handled by fixtures)
6. **Avoid flaky tests**: Use retry logic and stable selectors

## Troubleshooting

### Tests timing out

Increase timeout in the test:
```typescript
test("slow test", async ({ page }) => {
  test.setTimeout(60000);
  // ...
});
```

### Element not found

Use `waitForSelector` or `expect` with timeout:
```typescript
await expect(page.locator('.my-element')).toBeVisible({ timeout: 10000 });
```

### Browser not installed

Run browser installation:
```bash
pnpm --filter @everycal/web exec playwright install
```
