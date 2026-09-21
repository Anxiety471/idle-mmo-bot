import { existsSync } from 'node:fs';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { AppConfig } from './config.js';

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close: () => Promise<void>;
}

export async function launchBrowser(config: AppConfig): Promise<BrowserSession> {
  const browser = await chromium.launch({ headless: config.headless });

  const contextOptions: Parameters<typeof browser.newContext>[0] = {};
  if (config.storageStatePath && existsSync(config.storageStatePath)) {
    contextOptions.storageState = config.storageStatePath;
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  return {
    browser,
    context,
    page,
    close: async () => {
      await context.close();
      await browser.close();
    },
  };
}

export async function navigateTo(page: Page, config: AppConfig, path: string): Promise<void> {
  const url = path.startsWith('http') ? path : new URL(path, config.baseUrl).toString();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
}

export async function saveStorageState(
  context: BrowserContext,
  path: string,
): Promise<void> {
  await context.storageState({ path });
}
