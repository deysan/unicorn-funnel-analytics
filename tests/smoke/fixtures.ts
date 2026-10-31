import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test as base, expect } from '@playwright/test';

export const test = base.extend({
  launchOptions: async ({ browserName, launchOptions }, use) => {
    if (process.platform !== 'darwin' || browserName !== 'firefox') {
      await use(launchOptions);
      return;
    }

    // Firefox 157 звертається до особистого app-data навіть із тимчасовим
    // профілем. Ізолюємо його на macOS: microsoft/playwright#42768.
    const firefoxAppData = await mkdtemp(join(tmpdir(), 'unicorn-firefox-'));
    try {
      const appData = join(firefoxAppData, 'app-data');
      const localAppData = join(firefoxAppData, 'local-app-data');
      await Promise.all([mkdir(appData), mkdir(localAppData)]);
      await use({
        ...launchOptions,
        env: {
          ...process.env,
          ...launchOptions.env,
          MOZ_APP_DATA: appData,
          MOZ_LOCAL_APP_DATA: localAppData,
        },
      });
    } finally {
      await rm(firefoxAppData, { recursive: true, force: true });
    }
  },
});

export { expect };
