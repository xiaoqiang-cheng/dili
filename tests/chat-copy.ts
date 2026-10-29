import { expect, type Locator, type Page } from '@playwright/test';

export const copyPrompt = '请检查复制功能。\n\n  保留缩进与 **Markdown**，中文 🙂';

/** Exercise actual clipboard contents, including the HTTP fallback inside a dialog. */
export async function expectMessageCopy(page: Page, message: Locator) {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  // Headless Chromium cannot emulate display-mode. Activate the application's
  // actual standalone CSS rules, including the body selection restriction.
  const standaloneRules = await page.evaluate(() => {
    let count = 0;
    for (const sheet of document.styleSheets) for (const rule of sheet.cssRules) {
      if (rule instanceof CSSMediaRule && rule.conditionText === '(display-mode: standalone)') { rule.media.mediaText = 'all'; count++; }
    }
    return count;
  });
  expect(standaloneRules).toBeGreaterThan(0);
  await expect(page.locator('body')).toHaveCSS('user-select', 'none');
  const body = message.locator('.chat-message-body');
  await expect(body).toHaveCSS('user-select', 'text');
  await body.scrollIntoViewIfNeeded();
  const firstLetter = await body.evaluate(element => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) if (node.textContent?.startsWith('请检查')) {
      const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, 1);
      const rect = range.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }
    throw new Error('Missing prompt text');
  });
  await page.mouse.click(firstLetter.x, firstLetter.y, { clickCount: 3 });
  expect(await page.evaluate(() => window.getSelection()?.toString())).toContain('请检查复制功能');
  const copy = message.getByRole('button', { name: '复制消息', exact: true });
  await copy.click();
  await expect(message.getByRole('status')).toHaveText('已复制');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(copyPrompt);

  await page.setViewportSize({ width: 390, height: 844 });
  for (const mode of ['unavailable', 'denied'] as const) {
    await page.evaluate(mode => {
      const target = window as unknown as { readCopiedMessage?: () => Promise<string>; resetCopiedMessage?: (value: string) => Promise<void> };
      target.readCopiedMessage ??= navigator.clipboard.readText.bind(navigator.clipboard);
      target.resetCopiedMessage ??= navigator.clipboard.writeText.bind(navigator.clipboard);
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: mode === 'unavailable' ? undefined : { writeText: async () => { throw new Error('Permission denied'); } } });
      return target.resetCopiedMessage('clipboard reset: ' + mode);
    }, mode);
    await copy.click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { readCopiedMessage: () => Promise<string> }).readCopiedMessage())).toBe(copyPrompt);
    await expect(copy).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await page.evaluate(() => { document.execCommand = () => false; });
  await copy.click();
  await expect(message.getByRole('status')).toHaveText('复制失败，请选中文字手动复制');
  await expect(body).toHaveText(copyPrompt);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}
