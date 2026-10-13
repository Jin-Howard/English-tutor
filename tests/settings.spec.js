// 설정: 목록 값, 하위 화면 7개, 뒤로가기, 저장, 처음 설정 흐름
const { test, expect, seed, mockAI, open } = require('./helpers');

const SUBS = { key: 'API 키', info: '내 정보', memo: '튜터가 기억하는 나', alarm: '학습 알림', rate: '튜터 목소리 속도', share: '친구에게 소개', adv: '고급 설정' };

test('설정 목록과 현재 값', async ({ page }) => {
  await seed(page);
  await open(page);
  await page.click('#tabs .tab[data-s=setup]');
  await expect(page.locator('#setuptitle')).toHaveText('설정');
  await expect(page.locator('#pc-lv')).toHaveText('레벨 2 · 초급');
  await expect(page.locator('#sv-key')).toHaveText('연결됨');
  await expect(page.locator('#setup .savebar')).toBeHidden();  // 바꾸면 바로 저장이라 목록엔 저장 버튼 없음
});

for (const [sub, title] of Object.entries(SUBS)) {
  test(`설정 하위 화면: ${title}`, async ({ page }) => {
    await seed(page);
    await open(page);
    await page.click('#tabs .tab[data-s=setup]');
    await page.click(`#setup [data-go=${sub}]`);
    await expect(page.locator('#setuptitle')).toHaveText(title);
    await expect(page.locator(`#setup .spg[data-sp=${sub}]`)).toBeVisible();
    await expect(page.locator('.slist')).toBeHidden();
    if (sub === 'key' || sub === 'info') await expect(page.locator('#setup .savebar')).toBeVisible();
    await page.click('#sback');
    await expect(page.locator('#setuptitle')).toHaveText('설정');
    await expect(page.locator('.slist')).toBeVisible();
  });
}

test('폰 뒤로가기로 목록 복귀', async ({ page }) => {
  await seed(page);
  await open(page);
  await page.click('#tabs .tab[data-s=setup]');
  await page.click('#setup [data-go=memo]');
  await page.goBack();
  await expect(page.locator('#setuptitle')).toHaveText('설정');
});

test('내 정보 저장', async ({ page }) => {
  await seed(page);
  await open(page);
  await page.click('#tabs .tab[data-s=setup]');
  await page.click('#setup [data-go=info]');
  await page.fill('#f-age', '34');
  await page.click('#save');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('profile')).age)).toBe('34');
});

test('처음 설정: 키 넣고 저장하면 다음 단계', async ({ page }) => {
  await seed(page, { user: null, extra: { obpre: '1', ob: { lvl: 2, goals: ['병원'], mins: 10, days: 5 }, coachseen: '1' } });
  await mockAI(page, '{"models":[]}');
  await page.route('**/generativelanguage.googleapis.com/v1beta/models?**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"models":[]}' }));
  await open(page);
  await expect(page.locator('#setuptitle')).toHaveText('처음 설정');
  await page.evaluate(() => { document.getElementById('coach').classList.remove('open'); });
  await page.fill('#f-key', 'AIzaTESTKEY1234');
  await page.click('#save');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('gkey'))).toBe('AIzaTESTKEY1234');
  await expect.poll(() => page.evaluate(() => curScreen)).not.toBe('setup');
});
