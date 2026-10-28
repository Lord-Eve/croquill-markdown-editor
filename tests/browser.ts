import { chromium } from '@playwright/test';
import { existsSync } from 'node:fs';

/** Keep the Windows test browser, with system/bundled Chromium on Linux. */
export function launchTestBrowser() {
  return chromium.launch({
    headless: true,
    ...(process.platform === 'win32' ? { channel: 'msedge' } :
      existsSync('/usr/bin/chromium') ? { executablePath: '/usr/bin/chromium' } : {}),
  });
}
