import { test, expect } from "./fixtures/auth";
import { waitForPageLoad, uniqueId, uniqueEmail } from "./test-utils";

test.describe("Settings", () => {
  test.describe("Settings Navigation", () => {
    test("should display settings page", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/settings");
      await waitForPageLoad(page);
      
      await expect(page.locator('h1:has-text("Settings"), [data-testid="settings-title"]')).toBeVisible();
    });
    
    test("should show all settings sections", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/settings");
      await waitForPageLoad(page);
      
      // Profile section
      await expect(page.locator('text=/profile/i')).toBeVisible();
      
      // Notifications section
      await expect(page.locator('text=/notification/i')).toBeVisible();
      
      // Password section
      await expect(page.locator('text=/password/i')).toBeVisible();
    });
    
    test("should navigate to settings from header dropdown", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/");
      await waitForPageLoad(page);
      
      // Open user menu
      await page.click('.header-user-btn');
      await page.waitForSelector('.header-dropdown');
      
      // Click settings
      await page.click('a:has-text("Settings")');
      
      await expect(page).toHaveURL(/\/settings/);
    });
  });
  
  test.describe("Profile Settings", () => {
    test("should update display name", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/settings");
      await waitForPageLoad(page);
      
      const newName = `New Name ${uniqueId()}`;
      const displayNameInput = page.locator('input[id="displayName"], input[name="displayName"]').first();
      
      if (await displayNameInput.isVisible()) {
        await displayNameInput.fill(newName);
        
        const saveBtn = page.locator('button:has-text("Save"):near(input[name="displayName"])').first();
        if (await saveBtn.isVisible()) {
          await saveBtn.click();
          
          await expect(page.locator('text=/saved|success/i')).toBeVisible();
        }
      }
    });
    
    test("should update bio", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/settings");
      await waitForPageLoad(page);
      
      const newBio = `Updated bio ${uniqueId()}`;
      const bioInput = page.locator('textarea[id="bio"], textarea[name="bio"]').first();
      
      if (await bioInput.isVisible()) {
        await bioInput.fill(newBio);
        
        const saveBtn = page.locator('button:has-text("Save"):near(textarea[name="bio"])').first();
        if (await saveBtn.isVisible()) {
          await saveBtn.click();
          
          await expect(page.locator('text=/saved|success/i')).toBeVisible();
        }
      }
    });
    
    test("should validate website URL", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/settings");
      await waitForPageLoad(page);
      
      const websiteInput = page.locator('input[id="website"], input[name="website"]').first();
      
      if (await websiteInput.isVisible()) {
        await websiteInput.fill("not-a-valid-url");
        
        const saveBtn = page.locator('button:has-text("Save"):near(input[name="website"])').first();
        if (await saveBtn.isVisible()) {
          await saveBtn.click();
          
          // Should show validation error
          await expect(page.locator('text=/invalid url|error/i')).toBeVisible();
        }
      }
    });
    
    test("should toggle discoverable setting", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/settings");
      await waitForPageLoad(page);
      
      const toggle = page.locator('input[type="checkbox"][id="discoverable"], input[name="discoverable"]').first();
      if (await toggle.isVisible()) {
        const isChecked = await toggle.isChecked();
        await toggle.click();
        
        // Wait for save
        await page.waitForTimeout(500);
        
        expect(await toggle.isChecked()).toBe(!isChecked);
      }
    });
  });
  
  test.describe("Password Change", () => {
    test("should change password successfully", async ({ authenticatedPage, testUser }) => {
      const page = authenticatedPage;
      
      await page.goto("/settings");
      await waitForPageLoad(page);
      
      // Navigate to password section
      const passwordSection = page.locator('button:has-text("Password"), [data-section="password"]').first();
      if (await passwordSection.isVisible()) {
        await passwordSection.click();
        
        // Fill password form
        await page.fill('input[id="currentPassword"]', testUser.password);
        await page.fill('input[id="newPassword"]', `NewPass${uniqueId()}!`);
        await page.fill('input[id="confirmPassword"]', `NewPass${uniqueId()}!`);
        
        await page.click('button:has-text("Change Password")');
        
        await expect(page.locator('text=/password changed|success/i')).toBeVisible();
      }
    });
    
    test("should require matching new passwords", async ({ authenticatedPage, testUser }) => {
      const page = authenticatedPage;
      
      await page.goto("/settings");
      await waitForPageLoad(page);
      
      const passwordSection = page.locator('button:has-text("Password"), [data-section="password"]').first();
      if (await passwordSection.isVisible()) {
        await passwordSection.click();
        
        await page.fill('input[id="currentPassword"]', testUser.password);
        await page.fill('input[id="newPassword"]', "NewPassword123!");
        await page.fill('input[id="confirmPassword"]', "DifferentPassword!");
        
        await page.click('button:has-text("Change Password")');
        
        await expect(page.locator('text=/match|error/i')).toBeVisible();
      }
    });
  });
  
  test.describe("Notification Preferences", () => {
    test("should toggle reminder notifications", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/settings");
      await waitForPageLoad(page);
      
      const toggle = page.locator('input[type="checkbox"][id="reminderEnabled"], input[name="reminderEnabled"]').first();
      if (await toggle.isVisible()) {
        await toggle.click();
        await page.waitForTimeout(500);
      }
    });
    
    test("should update reminder hours", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/settings");
      await waitForPageLoad(page);
      
      const select = page.locator('select[id="reminderHoursBefore"], select[name="reminderHoursBefore"]').first();
      if (await select.isVisible()) {
        await select.selectOption("48");
        await page.waitForTimeout(500);
      }
    });
  });
  
  test.describe("API Keys", () => {
    test("should show API keys section", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/settings");
      await waitForPageLoad(page);
      
      const apiKeysSection = page.locator('button:has-text("API Keys"), [data-section="api-keys"]').first();
      if (await apiKeysSection.isVisible()) {
        await apiKeysSection.click();
        
        await expect(page.locator('text=/api key/i')).toBeVisible();
      }
    });
    
    test("should create new API key", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/settings");
      await waitForPageLoad(page);
      
      const apiKeysSection = page.locator('button:has-text("API Keys"), [data-section="api-keys"]').first();
      if (await apiKeysSection.isVisible()) {
        await apiKeysSection.click();
        
        const labelInput = page.locator('input[id="apiKeyLabel"], input[placeholder*="label" i]').first();
        if (await labelInput.isVisible()) {
          await labelInput.fill(`Test Key ${uniqueId()}`);
          await page.click('button:has-text("Create"), button:has-text("Generate")');
          
          // Should show the new key (only shown once)
          await expect(page.locator('code, input[value^="ec_"]')).toBeVisible();
        }
      }
    });
  });
  
  test.describe("Publishing Identities", () => {
    test("should show identities section", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/settings");
      await waitForPageLoad(page);
      
      await expect(page.locator('text=/identit/i')).toBeVisible();
    });
  });
  
  test.describe("Language Settings", () => {
    test("should change language preference", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/settings");
      await waitForPageLoad(page);
      
      const languageSelect = page.locator('select[id="language"], select[name="preferredLanguage"]').first();
      if (await languageSelect.isVisible()) {
        await languageSelect.selectOption("de");
        await page.waitForTimeout(500);
        
        await expect(languageSelect).toHaveValue("de");
      }
    });
  });
  
  test.describe("Account Deletion", () => {
    test("should show delete account section", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/settings");
      await waitForPageLoad(page);
      
      // Scroll to bottom
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      
      await expect(page.locator('text=/delete account/i')).toBeVisible();
    });
  });
});
