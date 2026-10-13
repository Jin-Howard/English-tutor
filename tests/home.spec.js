// 홈: 시작, 오늘의 목표 3상태, 통화하기와 채팅하기 버튼
const { test, expect, seed, fakeLive, open } = require('./helpers');

const todaySec = sec => `(() => { const d = new Date(); const k = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); localStorage.setItem('talksec', JSON.stringify({ [k]: ${sec} })); })()`;

test('앱이 켜지고 오늘의 목표와 두 버튼이 보임', async ({ page }) => {
  await seed(page);
  await open(page);
  await expect(page.locator('#t-main')).toHaveText('오늘의 목표 통화 10분');
  await expect(page.locator('#m-call')).toContainText('통화하기');
  await expect(page.locator('#m-chat')).toContainText('채팅');
  await expect(page.locator('#w-empty')).toBeVisible();  // 이번 주 기록이 없으면 안내
});

for (const [sec, main, sub] of [[240, '오늘 4분 통화했어요', '목표까지 6분 남았어요'], [660, '오늘 목표 달성!', '11분 말했어요']]) {
  test(`오늘의 목표: ${sec}초 통화`, async ({ page }) => {
    await seed(page);
    await page.addInitScript(todaySec(sec));
    await open(page);
    await expect(page.locator('#t-main')).toHaveText(main);
    await expect(page.locator('#t-sub')).toContainText(sub);
  });
}

test('가운데 탭 버튼은 통화를 연다', async ({ page }) => {
  await seed(page);
  await fakeLive(page);
  await open(page);
  await page.click('#fab');
  await expect(page.locator('#call')).toHaveClass(/\bon\b/);
  await expect(page.locator('#cl-state')).not.toHaveText('');
});

test('채팅하기는 채팅 화면을 연다', async ({ page }) => {
  await seed(page);
  await open(page);
  await page.click('#m-chat');
  await expect(page.locator('#inp')).toBeVisible();
  await expect(page.locator('#barcall')).toBeVisible();
});

test('이번 주: 오늘 동그라미가 다른 날과 같은 줄', async ({ page }) => {
  await seed(page);
  await open(page);
  const tops = await page.evaluate(() => [...document.querySelectorAll('#w-dots .dy i')].map(i => Math.round(i.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(1);
});

test('통화하기, 채팅하기는 글 줄에 맞춘 크기 (카드를 꽉 채우지 않음)', async ({ page }) => {
  await seed(page);
  await open(page);
  const [card, call, chat] = await Promise.all(['.talkcard', '#m-call', '#m-chat'].map(s => page.locator(s).boundingBox()));
  expect(call.height).toBe(44);
  expect(call.x).toBe(chat.x - call.width - 8);  // 나란히, 간격 8
  expect(call.width + chat.width).toBeLessThan(card.width * 0.75);
  expect(Math.round(call.x)).toBe(Math.round((await page.locator('.talkcard h2').boundingBox()).x));  // 제목과 같은 왼쪽 선
});
