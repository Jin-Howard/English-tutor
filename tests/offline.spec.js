// 오프라인: 한 번 열었던 앱은 인터넷 없이도 켜짐 (서비스 워커 저장)
const { test, expect, seed, open } = require('./helpers');

test('인터넷이 끊겨도 앱과 교재가 열림', async ({ page, context }) => {
  await seed(page);
  await open(page);
  await page.waitForFunction(() => navigator.serviceWorker.controller || navigator.serviceWorker.ready);
  await page.waitForTimeout(1500);  // 저장 마치기
  await context.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => window.__ready === true);
  expect(await page.evaluate(() => units().length)).toBe(8);
  await context.setOffline(false);
});
