import type { Locator, Page } from 'playwright';
import {
  canAttemptVerify,
  effectivePollMs,
  recordVerifyAttempt,
  type VerifyBudget,
} from './poll-interval.js';

const EMOJI_PATTERN = /[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/gu;

const NAME_TO_EMOJI: Record<string, string> = {
  sun: '☀️',
  star: '⭐',
  moon: '🌙',
  cloud: '☁️',
  fire: '🔥',
  water: '💧',
  tree: '🌳',
  fish: '🐟',
  heart: '❤️',
  flower: '🌸',
  rainbow: '🌈',
};

export interface SolveHumanCaptchaOptions {
  pollMs?: number;
  maxAttempts?: number;
}

export type HumanVerifyResult = 'not_present' | 'solved' | 'failed' | 'blocked';

/** Extract emoji name from IdleMMO human-check prompts. */
export function parseEmojiPromptTarget(body: string): string | undefined {
  const pressMatch = body.match(/Press the\s+(.+?)\s+emoji to continue/i);
  if (pressMatch?.[1]) return pressMatch[1].trim().toLowerCase();
  return undefined;
}

export function emojiForPromptName(name: string): string | undefined {
  const normalized = name.trim().toLowerCase().replace(/\s+emoji$/, '');
  return NAME_TO_EMOJI[normalized];
}

/** True when Quick-check emoji buttons exist but carry no emoji glyphs (CF / rate-limit symptom). */
export function areEmojiChoicesBlank(options: Array<{ emoji: string }>): boolean {
  if (options.length === 0) return false;
  return options.every((o) => !o.emoji?.trim());
}

/** True when Verify / Quick check / emoji challenge is blocking the page. */
export async function isHumanCheckPresent(page: Page): Promise<boolean> {
  const probes = [
    page.getByText(/Quick check/i),
    page.getByText(/make sure you're human/i),
    page.getByText(/choose the matching emoji/i),
    page.getByRole('button', { name: /^Verify$/i }),
  ];
  for (const probe of probes) {
    if (await probe.first().isVisible().catch(() => false)) return true;
  }
  return false;
}

async function collectEmojiOptionButtons(scope: Locator): Promise<Array<{ btn: Locator; emoji: string }>> {
  const buttons = scope.getByRole('button');
  const count = await buttons.count();
  const options: Array<{ btn: Locator; emoji: string }> = [];

  for (let i = 0; i < count; i++) {
    const btn = buttons.nth(i);
    if (!(await btn.isVisible().catch(() => false))) continue;
    const label = ((await btn.innerText().catch(() => '')) || '').trim();
    if (!label || /^close$/i.test(label) || /^x$/i.test(label)) continue;
    const emojis = [...label.matchAll(EMOJI_PATTERN)].map((m) => m[0]);
    if (emojis.length === 1) {
      options.push({ btn, emoji: emojis[0] });
    } else if (emojis.length === 0) {
      options.push({ btn, emoji: '' });
    }
  }

  return options;
}

/** Quick check: reference emoji in prompt, pick matching option in dialog grid. */
async function solveQuickCheckMatching(page: Page): Promise<boolean> {
  const dialog = page
    .locator('[role="dialog"]')
    .filter({ hasText: /Quick check|matching emoji|Thanks for playing/i })
    .first();
  if (await dialog.count() === 0) return false;

  const text = await dialog.innerText().catch(() => '');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const options = await collectEmojiOptionButtons(dialog);
  if (options.length === 0) return false;

  if (areEmojiChoicesBlank(options)) {
    return false;
  }

  const promptLines = lines.filter(
    (l) =>
      !/quick check|thanks for playing|choose the matching emoji|so we know you're here/i.test(l),
  );

  for (const line of promptLines) {
    const emojis = [...line.matchAll(EMOJI_PATTERN)].map((m) => m[0]);
    if (emojis.length !== 1) continue;
    const match = options.find((o) => o.emoji === emojis[0]);
    if (match) {
      await match.btn.click({ force: true }).catch(() => undefined);
      return true;
    }
  }

  const validOptions = options.filter((o) => o.emoji);
  if (validOptions.length === 0) return false;

  await validOptions[0].btn.click({ force: true }).catch(() => undefined);
  return true;
}

/**
 * Idle MMO human-check: Verify → emoji challenge → confirm.
 * Handles gather "Press the X emoji" and Battle "Quick check" matching-emoji modal.
 */
export async function solveHumanCaptchaIfPresent(
  page: Page,
  options: SolveHumanCaptchaOptions = {},
): Promise<boolean> {
  const pollMs = effectivePollMs(options.pollMs);
  const maxAttempts = options.maxAttempts ?? 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (!(await isHumanCheckPresent(page))) return false;

    const verifyBtn = page.getByRole('button', { name: /^Verify$/i });
    if ((await verifyBtn.count()) > 0) {
      await verifyBtn.first().click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(Math.min(pollMs, 3000));
    }

    const body = await page.locator('body').innerText();
    const targetName = parseEmojiPromptTarget(body);
    const targetEmoji = targetName ? emojiForPromptName(targetName) : undefined;

    const optionButtons = page.locator('button');
    const count = await optionButtons.count();
    let clicked = false;

    for (let i = 0; i < count; i++) {
      const btn = optionButtons.nth(i);
      const label = ((await btn.innerText().catch(() => '')) || '').trim();
      const aria = (await btn.getAttribute('aria-label').catch(() => '')) || '';
      const hay = `${label} ${aria}`;
      if (targetEmoji && hay.includes(targetEmoji)) {
        await btn.click({ force: true }).catch(() => undefined);
        clicked = true;
        break;
      }
      if (targetName && new RegExp(targetName, 'i').test(hay) && hay.length < 40) {
        await btn.click({ force: true }).catch(() => undefined);
        clicked = true;
        break;
      }
    }

    if (!clicked && targetEmoji) {
      const byText = page.getByText(targetEmoji, { exact: true });
      if ((await byText.count()) > 0) {
        await byText.first().click({ force: true }).catch(() => undefined);
        clicked = true;
      }
    }

    if (!clicked) {
      clicked = await solveQuickCheckMatching(page);
    }

    await page.waitForTimeout(pollMs);

    if (!(await isHumanCheckPresent(page))) {
      return true;
    }

    if (attempt + 1 < maxAttempts) {
      await page.waitForTimeout(pollMs);
    }
  }

  return !(await isHumanCheckPresent(page));
}

/** Guarded verify attempt respecting per-cycle budget (combat rounds). */
export async function attemptHumanVerify(
  page: Page,
  budget: VerifyBudget,
  pollMs?: number,
): Promise<HumanVerifyResult> {
  if (!(await isHumanCheckPresent(page))) return 'not_present';
  if (!canAttemptVerify(budget)) return 'blocked';
  recordVerifyAttempt(budget);
  const solved = await solveHumanCaptchaIfPresent(page, { pollMs, maxAttempts: 1 });
  if (!(await isHumanCheckPresent(page))) {
    return solved ? 'solved' : 'solved';
  }
  return solved ? 'failed' : 'failed';
}
