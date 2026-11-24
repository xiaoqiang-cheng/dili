import { expect, type Locator } from '@playwright/test';
import { mutationHeaders, test } from './fixtures';

async function expectColors(pane: Locator, background: string, foreground: string) {
  await expect(pane).toHaveCSS('background-color', background);
  // Check xterm's own viewport and rendered glyphs, not only the wrapper CSS.
  await expect(pane.locator('.xterm .xterm-scrollable-element')).toHaveCSS('background-color', background);
  await expect(pane.locator('.xterm-rows')).toHaveCSS('color', foreground);
}

for (const mobile of [false, true]) {
  test.describe(mobile ? 'mobile terminal theme' : 'desktop terminal theme', () => {
    test.use(mobile ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : {});
    test('follows page colors live without replacing terminals or reconnecting', async ({ page, request }) => {
      const existing = new Set(((await (await request.get('/api/shells')).json()) as { id: string }[]).map(item => item.id));
      const sockets: string[] = [];
      page.on('websocket', socket => {
        if (/\/api\/(terminal\/|shells\/.*\/terminal)/.test(socket.url())) sockets.push(socket.url());
      });
      try {
        await page.goto('/');
        await page.getByRole('button', { name: '进入 Dili · 开发笔记 的会话', exact: true }).click();
        const native = page.locator('.session-conversation .terminal-pane');
        await expect(page.locator('.drawer-header .terminal-connection.connected')).toHaveCount(1);
        const panes: Locator[] = [native];
        if (!mobile) {
          await page.getByRole('button', { name: '打开终端', exact: true }).click();
          const dock = page.getByRole('region', { name: '终端面板' });
          await expect(dock.locator('.terminal-connection.connected')).toHaveCount(1);
          await dock.getByRole('button', { name: '终端分屏', exact: true }).click();
          await expect(dock.locator('.terminal-connection.connected')).toHaveCount(2);
          panes.push(dock.locator('.terminal-pane').nth(0), dock.locator('.terminal-pane').nth(1));
          const input = panes[1].locator('.xterm-helper-textarea');
          await input.focus();
          // Shells share the native terminal: whole-phrase IME insertion must
          // work here too, including after a live theme change.
          await page.keyboard.insertText('SD_THEME_VALUE=中文多字🙂');
          await input.press('Enter');
          await expect(panes[1].locator('.xterm-rows')).toContainText('SD_THEME_VALUE=中文多字🙂');
        }
        const elements = await Promise.all(panes.map(pane => pane.locator('.xterm').elementHandle()));
        const connectionCount = sockets.length;
        for (const pane of panes) await expectColors(pane, 'rgb(255, 255, 255)', 'rgb(37, 43, 53)');
        await page.screenshot({ path: `artifacts/terminal-theme-${mobile ? 'mobile' : 'desktop'}-light.png` });
        await page.evaluate(() => {
          const style = document.documentElement.style;
          for (const [name, value] of Object.entries({ bg: '#16181d', text: '#e6e7ea', subtle: '#1c1f25', hover: '#2a2e36', line: '#303641', muted: '#a1a8b4' })) {
            style.setProperty(`--${name}`, value);
          }
        });
        for (const pane of panes) await expectColors(pane, 'rgb(22, 24, 29)', 'rgb(230, 231, 234)');
        if (mobile) await expect(page.getByLabel('终端输入栏')).toHaveCSS('background-color', 'rgb(22, 24, 29)');
        await page.screenshot({ path: `artifacts/terminal-theme-${mobile ? 'mobile' : 'desktop'}-dark.png` });
        await page.evaluate(() => document.documentElement.removeAttribute('style'));
        for (let i = 0; i < panes.length; i++) {
          await expectColors(panes[i], 'rgb(255, 255, 255)', 'rgb(37, 43, 53)');
          expect(await elements[i]!.evaluate(element => element.isConnected)).toBe(true);
          await expect(i === 0 ? page.locator('.drawer-header .terminal-connection.connected') : panes[i].locator('.terminal-connection.connected')).toHaveCount(1);
        }
        if (!mobile) {
          const input = panes[1].locator('.xterm-helper-textarea');
          await input.focus();
          await input.pressSequentially('printf "THEME_RESULT:%s\\n" "$SD_THEME_VALUE"');
          await input.press('Enter');
          await expect(panes[1].locator('.xterm-rows')).toContainText('THEME_RESULT:中文多字🙂');
        }
        expect(sockets.length).toBe(connectionCount);
      } finally {
        const shells = await (await request.get('/api/shells')).json() as { id: string }[];
        const headers = await mutationHeaders(request);
        for (const shell of shells.filter(item => !existing.has(item.id))) {
          expect((await request.delete(`/api/shells/${shell.id}`, { headers, data: {} })).ok()).toBe(true);
        }
      }
    });
  });
}
