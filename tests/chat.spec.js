// 채팅: 글로 보내기, 마이크 받아쓰기 (말로 대화는 통화로)
const { test, expect, seed, mockAI, open } = require('./helpers');

test('글로 보내면 튜터가 대답', async ({ page }) => {
  await seed(page);
  await mockAI(page, 'That sounds fun! What did you order?');
  await open(page);
  await page.click('#m-chat');
  await page.fill('#inp', 'Hello there');
  await page.evaluate(() => paint());
  await page.click('#act');
  await expect(page.locator('#chat .msg.user')).toContainText('Hello there');
  await expect(page.locator('#chat .msg.ai').last()).toContainText('That sounds fun');
});

test('마이크는 받아쓴 글을 입력칸에 넣음', async ({ page }) => {
  await seed(page);
  await mockAI(page, 'I went to the cafe yesterday.');
  await open(page);
  await page.click('#m-chat');
  await expect(page.locator('#bar button:visible')).toHaveCount(2);  // 통화 + 마이크(보내기)
  await page.click('#act');
  await expect(page.locator('#bar')).toHaveClass(/listening/);
  await page.waitForTimeout(600);
  await page.click('#act');
  await expect(page.locator('#inp')).toHaveValue('I went to the cafe yesterday.');
});
