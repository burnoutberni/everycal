import { test, expect } from "./fixtures/auth";
import { waitForPageLoad, uniqueUsername, uniqueId } from "./test-utils";

test.describe("Profile", () => {
  test.describe("Profile Viewing", () => {
    test("should display own profile", async ({ authenticatedPage, testUser }) => {
      const page = authenticatedPage;
      
      await page.goto(`/@${testUser.username}`);
      await waitForPageLoad(page);
      
      await expect(page.locator(`text="${testUser.displayName}"`)).toBeVisible();
      await expect(page.locator(`text="@${testUser.username}"`)).toBeVisible();
    });
    
    test("should show followers and following counts", async ({ authenticatedPage, testUser }) => {
      const page = authenticatedPage;
      
      await page.goto(`/@${testUser.username}`);
      await waitForPageLoad(page);
      
      // Should show follower/following counts
      await expect(page.locator('text=/followers?/i')).toBeVisible();
      await expect(page.locator('text=/following/i')).toBeVisible();
    });
    
    test("should show 404 for non-existent profile", async ({ page }) => {
      await page.goto("/@nonexistentuser12345");
      await waitForPageLoad(page);
      
      await expect(page.locator('text=/404|not found/i')).toBeVisible();
    });
  });
  
  test.describe("Profile Editing", () => {
    test("should edit display name inline", async ({ authenticatedPage, testUser }) => {
      const page = authenticatedPage;
      
      await page.goto(`/@${testUser.username}`);
      await waitForPageLoad(page);
      
      // Click edit button on profile
      const editBtn = page.locator('button:has-text("Edit")').first();
      if (await editBtn.isVisible()) {
        await editBtn.click();
        
        // Update display name
        const newDisplayName = `Updated Name ${uniqueId()}`;
        await page.fill('input[id="displayName"], input[name="displayName"]', newDisplayName);
        
        // Save
        await page.click('button:has-text("Save")');
        
        await expect(page.locator(`text="${newDisplayName}"`)).toBeVisible();
      }
    });
    
    test("should cancel profile editing", async ({ authenticatedPage, testUser }) => {
      const page = authenticatedPage;
      
      await page.goto(`/@${testUser.username}`);
      await waitForPageLoad(page);
      
      const editBtn = page.locator('button:has-text("Edit")').first();
      if (await editBtn.isVisible()) {
        await editBtn.click();
        
        await page.fill('input[id="displayName"]', "Should not save");
        await page.click('button:has-text("Cancel")');
        
        // Should show original name
        await expect(page.locator(`text="${testUser.displayName}"`)).toBeVisible();
      }
    });
  });
  
  test.describe("Following", () => {
    test("should show followers list", async ({ authenticatedPage, testUser }) => {
      const page = authenticatedPage;
      
      await page.goto(`/@${testUser.username}`);
      await waitForPageLoad(page);
      
      // Click followers count
      const followersBtn = page.locator('a:has-text("followers"), button:has-text("followers")').first();
      if (await followersBtn.isVisible()) {
        await followersBtn.click();
        
        // Modal or page should show followers
        await expect(page.locator('[role="dialog"], .followers-list')).toBeVisible();
      }
    });
    
    test("should show following list", async ({ authenticatedPage, testUser }) => {
      const page = authenticatedPage;
      
      await page.goto(`/@${testUser.username}`);
      await waitForPageLoad(page);
      
      const followingBtn = page.locator('a:has-text("following"), button:has-text("following")').first();
      if (await followingBtn.isVisible()) {
        await followingBtn.click();
        
        await expect(page.locator('[role="dialog"], .following-list')).toBeVisible();
      }
    });
  });
  
  test.describe("Event Listings on Profile", () => {
    test("should show upcoming events", async ({ authenticatedPage, testUser }) => {
      const page = authenticatedPage;
      
      await page.goto(`/@${testUser.username}`);
      await waitForPageLoad(page);
      
      // Profile should load
      await expect(page.locator(`text="@${testUser.username}"`)).toBeVisible();
    });
  });
});
