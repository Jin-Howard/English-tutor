// 화면 자동 테스트 설정: npx playwright test (GitHub에서는 Actions가 올릴 때마다 실행)
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: 'tests',
  timeout: 30000,
  workers: process.env.CI ? 2 : 4,
  retries: process.env.CI ? 1 : 0,  // 서버가 느린 순간의 우연한 실패만 한 번 더
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:4173',
    viewport: { width: 375, height: 812 },  // 폰 화면
    permissions: ['microphone'],
    launchOptions: {
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],  // 가짜 마이크
      executablePath: process.env.CHROMIUM || undefined,
    },
    trace: 'retain-on-failure',  // 실패하면 화면 기록을 남김
  },
  webServer: { command: 'python3 -m http.server 4173', url: 'http://localhost:4173/index.html', reuseExistingServer: !process.env.CI, stdout: 'ignore', stderr: 'ignore' },
});
