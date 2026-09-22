import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Page } from 'playwright';
import { talkQuest } from './quest.js';

type MockButton = {
  name: string;
  disabled?: boolean;
};

function createLocator(
  counters: Array<() => Promise<number>>,
  click: () => Promise<void> = async () => undefined,
) {
  const locator = {
    count: async () => {
      for (const counter of counters) {
        const value = await counter();
        if (value > 0) return value;
      }
      return 0;
    },
    click,
    first: () => ({
      click,
      isDisabled: async () => false,
    }),
    or(other: { count: () => Promise<number> }) {
      return createLocator([...counters, () => other.count()], click);
    },
  };
  return locator;
}

function createMockPage(options: {
  buttons?: MockButton[];
  texts?: string[];
}): Page {
  const buttons = options.buttons ?? [];
  const texts = new Set(options.texts ?? []);

  const page = {
    getByRole: (_role: string, opts?: { name?: string | RegExp; exact?: boolean }) => {
      const name = opts?.name;
      const matching = typeof name === 'string'
        ? buttons.filter((btn) => btn.name === name)
        : [];
      return createLocator([async () => matching.length], async () => undefined);
    },
    getByText: (text: string) =>
      createLocator([async () => (texts.has(text) ? 1 : 0)], async () => undefined),
    waitForTimeout: async () => undefined,
  };

  return page as unknown as Page;
}

describe('talkQuest', () => {
  it('returns no_action when Talk and Accept are missing', async () => {
    const page = createMockPage({ buttons: [{ name: 'Overview' }] });
    assert.equal(await talkQuest(page), 'no_action');
  });

  it('clicks Accept when present', async () => {
    const page = createMockPage({ buttons: [{ name: 'Accept' }] });
    assert.equal(await talkQuest(page), 'talked');
  });

  it('returns no_action when Talk is present but dialogue is not', async () => {
    const page = createMockPage({ buttons: [{ name: 'Talk' }] });
    assert.equal(await talkQuest(page), 'no_action');
  });

  it('clicks known Hearth dialogue after Talk', async () => {
    const page = createMockPage({
      buttons: [{ name: 'Talk' }],
      texts: ["Right. I'll fetch the logs."],
    });
    assert.equal(await talkQuest(page), 'talked');
  });
});
