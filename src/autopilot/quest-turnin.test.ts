import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Page } from 'playwright';
import type { SnapshotQuest } from '../types.js';
import {
  questTitlePattern,
  sortTurnInCandidates,
  turnInCompletableQuests,
} from '../deterministic/quest.js';
import { GOBLIN_QUEST, HEARTH_QUEST } from '../deterministic/quest-accept.js';

const NAV_CHROME = ['Rain', 'Combat', 'More', 'Leagues', 'Search', 'Character'] as const;

type MockButton = {
  name: string;
  disabled?: boolean;
  visible?: boolean;
  inQuestsInspect?: boolean;
};

function matchesName(buttonName: string, pattern?: string | RegExp): boolean {
  if (!pattern) return true;
  if (pattern instanceof RegExp) return pattern.test(buttonName);
  return buttonName.includes(pattern);
}

function createMockPage(options: {
  buttons?: MockButton[];
  hasQuestsInspect?: boolean;
}): { page: Page; clicked: string[] } {
  const buttons = options.buttons ?? [];
  const clicked: string[] = [];
  const hasInspect = options.hasQuestsInspect ?? true;

  const getMatchingButtons = (role: string, opts?: { name?: string | RegExp; exact?: boolean }) => {
    if (role !== 'button') return [];
    return buttons.filter((btn) => {
      if (opts?.exact && typeof opts.name === 'string') {
        return btn.name === opts.name;
      }
      if (opts?.name !== undefined && !matchesName(btn.name, opts.name)) {
        return false;
      }
      return (btn.visible ?? true) || btn.inQuestsInspect;
    });
  };

  const createLocator = (matches: MockButton[]) => {
    const locator = {
      count: async () => matches.length,
      first: () => ({
        click: async (clickOpts?: { force?: boolean; timeout?: number }) => {
          if (matches[0]) clicked.push(matches[0].name);
          return undefined;
        },
        isDisabled: async () => matches[0]?.disabled ?? false,
        isVisible: async () => matches[0]?.visible ?? true,
        waitFor: async () => undefined,
      }),
      click: async () => {
        if (matches[0]) clicked.push(matches[0].name);
      },
      nth: (index: number) => ({
        innerText: async () => matches[index]?.name ?? '',
        click: async () => {
          if (matches[index]) clicked.push(matches[index].name);
        },
        isVisible: async () => matches[index]?.visible ?? true,
      }),
      or(other: { count: () => Promise<number>; first: () => { waitFor: () => Promise<void> } }) {
        return createLocator(matches);
      },
    };
    return locator;
  };

  const page = {
    url: () => 'https://web.idle-mmo.com/quests',
    keyboard: { press: async () => undefined },
    waitForTimeout: async () => undefined,
    locator: (selector: string) => {
      if (selector === '[x-data="questsInspect"]') {
        const inspectButtons = hasInspect ? buttons.filter((b) => b.inQuestsInspect) : [];
        return {
          getByRole: (role: string, opts?: { name?: string | RegExp; exact?: boolean }) =>
            createLocator(getMatchingButtons(role, opts).filter((b) => b.inQuestsInspect)),
          count: async () => (hasInspect ? 1 : 0),
        };
      }
      return createLocator([]);
    },
    getByRole: (role: string, opts?: { name?: string | RegExp; exact?: boolean }) =>
      createLocator(getMatchingButtons(role, opts)),
    getByText: () => createLocator([]),
  };

  return { page: page as unknown as Page, clicked };
}

function acceptedQuest(title: string, canTurnIn: boolean): SnapshotQuest {
  return { title, canTurnIn, tab: 'accepted' };
}

describe('questTitlePattern', () => {
  it('matches UI card title from scraped Goblin Menace', () => {
    const pattern = questTitlePattern(GOBLIN_QUEST);
    assert.match('The Goblin Menace Goblin Totem 30 / 30 500', pattern);
  });

  it('matches hearth title literally', () => {
    const pattern = questTitlePattern(HEARTH_QUEST);
    assert.match('Wood for the Hearth Oak Log 150 / 150', pattern);
  });
});

describe('sortTurnInCandidates', () => {
  it('prefers hearth before goblin when both can turn in', () => {
    const sorted = sortTurnInCandidates([
      acceptedQuest(GOBLIN_QUEST, true),
      acceptedQuest(HEARTH_QUEST, true),
    ]);
    assert.equal(sorted[0]?.title, HEARTH_QUEST);
    assert.equal(sorted[1]?.title, GOBLIN_QUEST);
  });
});

describe('turnInCompletableQuests', () => {
  it('opens matching quest card by title and clicks Turn In without touching nav chrome', async () => {
    const { page, clicked } = createMockPage({
      buttons: [
        ...NAV_CHROME.map((name) => ({ name, visible: true })),
        { name: 'Accepted 1', visible: true },
        { name: 'Pending Nearby 3', visible: true },
        { name: 'Completed 1', visible: true },
        {
          name: 'The Goblin Menace Goblin Totem 30 / 30 500',
          visible: true,
        },
        { name: 'Turn In', visible: true, inQuestsInspect: true },
      ],
    });

    const outcome = await turnInCompletableQuests(
      page,
      { baseUrl: 'https://web.idle-mmo.com' } as never,
      [acceptedQuest(GOBLIN_QUEST, true)],
      { skipNavigate: true },
    );

    assert.equal(outcome.result, 'turned_in');
    assert.equal(outcome.turnedInTitle, GOBLIN_QUEST);
    assert.ok(
      clicked.some((name) => /Goblin Menace/i.test(name)),
      `expected quest card click, got ${JSON.stringify(clicked)}`,
    );
    assert.ok(clicked.includes('Turn In'));
    for (const chrome of NAV_CHROME) {
      assert.equal(
        clicked.includes(chrome),
        false,
        `nav chrome "${chrome}" must not be clicked`,
      );
    }
  });

  it('returns failed when no matching quest card is visible', async () => {
    const { page, clicked } = createMockPage({
      buttons: [
        ...NAV_CHROME.map((name) => ({ name, visible: true })),
        { name: 'Accepted 1', visible: true },
      ],
    });

    const outcome = await turnInCompletableQuests(
      page,
      { baseUrl: 'https://web.idle-mmo.com' } as never,
      [acceptedQuest(GOBLIN_QUEST, true)],
      { skipNavigate: true },
    );

    assert.equal(outcome.result, 'failed');
    for (const chrome of NAV_CHROME) {
      assert.equal(clicked.includes(chrome), false);
    }
  });

  it('ignores quests without canTurnIn', async () => {
    const { page, clicked } = createMockPage({
      buttons: [
        { name: 'The Goblin Menace Goblin Totem 30 / 30 500', visible: true },
        { name: 'Turn In', visible: true, inQuestsInspect: true },
      ],
    });

    const outcome = await turnInCompletableQuests(
      page,
      { baseUrl: 'https://web.idle-mmo.com' } as never,
      [acceptedQuest(GOBLIN_QUEST, false)],
      { skipNavigate: true },
    );

    assert.equal(outcome.result, 'no_action');
    assert.equal(clicked.length, 0);
  });
});
