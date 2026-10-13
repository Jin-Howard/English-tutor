// 통화 후 교정 리포트: 내용, 같은 문장 거르기, 표현 저장, 복습 연결, 짧은 통화, 실패
const { test, expect, seed, mockAI, fakeLive, open } = require('./helpers');

const REPORT = {
  summary: '카페 주문을 끝까지 영어로 해냈어요.',
  fixes: [{ said: 'Yesterday I go to the cafe', better: 'Yesterday I went to the cafe.', tip: '어제 일은 과거형 went' },
    { said: 'I am agree', better: 'I agree.', tip: 'agree는 be동사 없이 써요' },
    { said: 'I like it', better: 'I like it', tip: '같은 문장' }],
  good: ['Could I get a latte?'],
  phrases: [{ en: 'grab a coffee', ko: '커피 한잔하다' }],
};
const LINES = [{ who: 'ai', text: 'What did you do yesterday?' }, { who: 'me', text: 'Yesterday I go to the cafe' }, { who: 'ai', text: 'Nice!' }, { who: 'me', text: 'I am agree with you' }];

async function endWith(page, lines, sec) {
  await open(page);
  await page.click('#m-call');
  await expect(page.locator('#call')).toHaveClass(/\bon\b/);
  await page.evaluate(([l, s]) => { LiveCall._test.setLines(l); LiveCall._test.setSpoke(s); }, [lines, sec]);
  await page.click('#cl-end');
}

test('리포트: 고칠 문장, 잘 쓴 표현, 써먹을 표현', async ({ page }) => {
  await seed(page); await fakeLive(page); await mockAI(page, JSON.stringify(REPORT));
  await endWith(page, LINES, 110);
  await expect(page.locator('#call')).toHaveClass(/report/);
  await expect(page.locator('.rp-fix')).toHaveCount(2);  // 같은 문장 "교정"은 거름
  await expect(page.locator('.rp-fix').first()).toContainText('Yesterday I went to the cafe.');
  await expect(page.locator('.rp-good span')).toHaveCount(1);
  await page.click('[data-ph="0"]');
  await expect(page.locator('[data-ph="0"]')).toHaveText('저장됨');
  expect(await page.evaluate(() => findWord('grab a coffee').meaning)).toBe('ⓟ 커피 한잔하다');
  expect(await page.evaluate(() => reviewMaterial().mistakes[0].said)).toBe('I am agree');  // 복습에 통화 교정이 먼저
  await page.click('#rp-review');
  await expect.poll(() => page.evaluate(() => mode)).toBe('review');
});

test('짧은 통화는 리포트 없이 닫힘', async ({ page }) => {
  await seed(page); await fakeLive(page);
  await endWith(page, [{ who: 'me', text: 'Hi' }], 10);
  await expect(page.locator('#call')).not.toHaveClass(/\bon\b/);
});

test('AI 실패면 안내만, 복습 버튼 숨김', async ({ page }) => {
  await seed(page); await fakeLive(page); await mockAI(page, null);
  await endWith(page, LINES, 60);
  await expect(page.locator('#rp-body')).toContainText('리포트를 만들지 못했어요');
  await expect(page.locator('#rp-review')).toBeHidden();
});
