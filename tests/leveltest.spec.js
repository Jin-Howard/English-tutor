// 레벨 테스트: 단어, 문장, 말하기 화면과 말하기 녹음 흐름
const { test, expect, seed, mockAI, open } = require('./helpers');

async function toOnb(page) {  // 레벨 테스트 화면으로 (화면 전환이 끝나 첫 단계가 그려질 때까지)
  await page.evaluate(() => show('onb'));
  await page.waitForFunction(() => typeof obs !== 'undefined' && obs && obs.step === 'goal' && document.getElementById('obbody').childElementCount > 0);
}

const START = () => { obs = { step: 'goal', goals: ['일상 대화'], start: 0, days: 5, mins: 20, v: newSkill(3), r: newSkill(3), used: [], usedS: [], sp: { d: 2, res: [] } }; };

for (const step of ['vocab', 'read', 'speak']) {
  test(`레벨 테스트 ${step} 화면`, async ({ page }) => {
    await seed(page);
    await open(page);
    await toOnb(page);
    await page.evaluate(START);
    await page.evaluate(s => obGo(s), step);
    const body = page.locator('#obbody');
    if (step === 'vocab') { await expect(body).toContainText('모르겠어요'); expect(await body.locator('button').count()).toBeGreaterThanOrEqual(5); }  // 뜻 보기 4개 + 모르겠어요 (+ 발음 듣기)
    if (step === 'read') await expect(body.locator('button')).toHaveCount(5);  // 보기 4개 + 잘 모르겠어요
    if (step === 'speak') await expect(body).toContainText('이 말을 영어로 해 보세요');
  });
}

test('말하기: 녹음 → 받아쓰기 → 확인', async ({ page }) => {
  await seed(page);
  await mockAI(page, 'I went to the cafe yesterday.');
  await open(page);
  await toOnb(page);
  await page.evaluate(() => { obs = { step: 'speak', goals: ['일상 대화'], start: 0, days: 5, mins: 20, v: newSkill(3), r: newSkill(3), sp: { d: 2, res: [], fb: null, ui: 'idle' }, q: { ko: '어제 카페에 갔어요', en: 'I went to the cafe yesterday.', d: 2 } }; renderOb(false); });
  const mic = () => page.evaluate(() => document.getElementById('obmic').click());  // 녹음 시간 표시로 화면이 계속 갱신돼서 직접 누름
  await mic();
  await expect.poll(() => page.evaluate(() => obs.sp.ui)).toBe('rec');
  await page.waitForTimeout(800);
  await mic();
  await expect.poll(() => page.evaluate(() => obs.sp.ui)).toBe('check');
  expect(await page.evaluate(() => obs.sp.said)).toBe('I went to the cafe yesterday.');
});
