import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import type { AppConfig } from '../config.js';
import {
  configureAndBattle,
  ensureHuntActive,
  huntMore,
  takeCookedCodSpentOnHeal,
  pickBattleEnemy,
  prepareEnemyBattleSelection,
  readHuntState,
  stopHunt,
} from './combat.js';

let browser: Browser;

before(async () => {
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
});

async function load(html: string): Promise<Page> {
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  return page;
}

/** Post-stop screen: one monster image, count badge, Hunt More. Gold chip sits above the label. */
const POST_STOP_ICON = `<!DOCTYPE html>
<html><body>
  <div id="wrap" style="position:relative;width:800px;height:640px">
    <div role="button" id="gold" style="position:absolute;top:8px;left:8px">
      <img alt="Gold" src="/ui/gold.png" style="width:40px;height:40px" />
      <span>94</span>
    </div>
    <div style="position:absolute;top:280px;left:180px">ENEMIES NEARBY</div>
    <div role="button" id="goblin" style="position:absolute;top:320px;left:180px">
      <img alt="Goblin" src="/enemies/goblin.png" style="width:72px;height:72px" />
      <span>3</span>
    </div>
    <div role="button" id="rabbit" style="position:absolute;top:320px;left:280px">
      <img alt="" src="/enemies/rabbit-icon.png" style="width:72px;height:72px" />
      <span>218</span>
    </div>
    <button type="button" style="position:absolute;top:340px;left:420px">Hunt More</button>
  </div>
</body></html>`;

/** Active hunt: decorative sprites, no ENEMIES NEARBY label, Stop still showing. */
const ACTIVE_HUNT = `<!DOCTYPE html>
<html><body>
  <button type="button">Stop</button>
      <img alt="Rabbit" src="/enemies/rabbit.png" style="width:64px;height:64px" />
  <div>Total Enemies Found</div>
  <div>216</div>
  <button type="button">Power Hunt</button>
</body></html>`;

const BATTLE_FLOW = `<!DOCTYPE html>
<html><body>
  <div id="nearby">
    <div>ENEMIES NEARBY</div>
    <div role="button" id="tile">
      <img alt="Rabbit" src="/enemies/rabbit.png" style="width:72px;height:72px" />
      <span>218</span>
    </div>
    <button type="button">Hunt More</button>
  </div>
  <div id="modal" hidden x-data="show-battle-entity">
    <h2>Rabbit</h2>
    <div>3 Combat EXP</div>
    <div>FOOD</div>
    <button type="button" id="food-add">Add</button>
    <div>STANCE</div>
    <select name="location"><option value="balanced">Balanced (All Stats)</option></select>
    <div>ENEMIES</div>
    <input id="max_enemies" value="1" />
    <button type="button" id="enemax">Max</button>
    <button type="button" id="battle">Battle</button>
  </div>
  <div id="food" hidden x-data="food-for-battle">
    <div>Food</div>
    <button type="button" id="cod">
      <img src="/items/cooked-cod.png" style="width:40px;height:40px" />
    </button>
  </div>
  <script>
    const order = [];
    const note = (step) => {
      order.push(step);
      document.body.dataset.order = order.join(',');
    };
    document.getElementById('tile').addEventListener('click', () => {
      document.getElementById('modal').hidden = false;
    });
    document.getElementById('food-add').addEventListener('click', () => {
      document.getElementById('food').hidden = false;
    });
    document.getElementById('cod').addEventListener('click', () => {
      note('food');
      document.getElementById('food').hidden = true;
    });
    document.getElementById('enemax').addEventListener('click', () => {
      note('max');
      document.getElementById('max_enemies').value = '218';
    });
    document.getElementById('battle').addEventListener('click', () => {
      note('battle');
      document.getElementById('modal').hidden = true;
      const flee = document.createElement('button');
      flee.type = 'button';
      flee.textContent = 'Run Away';
      document.body.appendChild(flee);
    });
  </script>
</body></html>`;

const BATTLE_MODAL_BLOCKS_HUNT_MORE = `<!DOCTYPE html>
<html><body>
  <div x-data="show-battle-entity">
    <h2>Rabbit</h2>
    <div>3 Combat EXP</div>
    <div>FOOD</div>
    <button type="button" id="food-add">Add</button>
    <div>STANCE</div>
    <select name="location"><option value="balanced">Balanced (All Stats)</option></select>
    <div>ENEMIES</div>
    <input id="max_enemies" value="4" />
    <button type="button" id="enemax">Max</button>
    <button type="button" id="battle">Battle</button>
  </div>
  <div id="food" hidden x-data="food-for-battle">
    <div>Food</div>
    <button type="button" id="cod">
      <img src="/items/cooked-cod.png" style="width:40px;height:40px" />
    </button>
  </div>
  <script>
    document.getElementById('food-add').addEventListener('click', () => {
      document.getElementById('food').hidden = false;
    });
    document.getElementById('cod').addEventListener('click', () => {
      document.getElementById('food').hidden = true;
    });
    document.getElementById('battle').addEventListener('click', () => {
      document.body.dataset.battled = '1';
      document.querySelector('[x-data*="show-battle-entity"]').remove();
      const flee = document.createElement('button');
      flee.type = 'button';
      flee.textContent = 'Run Away';
      document.body.appendChild(flee);
    });
    document.getElementById('enemax').addEventListener('click', () => {
      document.getElementById('max_enemies').value = '4';
    });
  </script>
</body></html>`;

const BATTLE_FLOW_NO_FOOD = `<!DOCTYPE html>
<html><body>
  <div id="nearby">
    <div>ENEMIES NEARBY</div>
    <div role="button" id="tile">
      <img alt="Rabbit" src="/enemies/rabbit.png" style="width:72px;height:72px" />
      <span>218</span>
    </div>
  </div>
  <div id="modal" hidden x-data="show-battle-entity">
    <h2>Rabbit</h2>
    <div>3 Combat EXP</div>
    <div>FOOD</div>
    <button type="button" id="food-add">Add</button>
    <div>STANCE</div>
    <select name="location"><option value="balanced">Balanced (All Stats)</option></select>
    <div>ENEMIES</div>
    <input id="max_enemies" value="1" />
    <button type="button" id="enemax">Max</button>
    <button type="button" id="battle">Battle</button>
  </div>
  <div id="food" hidden x-data="food-for-battle"><div>Food</div></div>
  <script>
    document.getElementById('tile').addEventListener('click', () => {
      document.getElementById('modal').hidden = false;
    });
    document.getElementById('food-add').addEventListener('click', () => {
      document.getElementById('food').hidden = false;
    });
    document.getElementById('battle').addEventListener('click', () => {
      document.body.dataset.battled = '1';
      document.getElementById('modal').hidden = true;
      const flee = document.createElement('button');
      flee.type = 'button';
      flee.textContent = 'Run Away';
      document.body.appendChild(flee);
    });
  </script>
</body></html>`;

describe('post-stop enemy icon scrape', () => {
  it('reads Rabbit from the count-badge image and ignores the header gold chip', async () => {
    const page = await load(POST_STOP_ICON);
    try {
      const state = await readHuntState(page);
      const names = state.enemies.map((e) => e.name);
      assert.ok(names.includes('Rabbit'), `expected Rabbit in ${names.join(', ')}`);
      assert.equal(names.includes('Gold'), false);
      assert.equal(pickBattleEnemy(state.enemies)?.name, 'Rabbit');
    } finally {
      await page.close();
    }
  });

  it('does not treat in-hunt sprites as selectable while Stop is the screen', async () => {
    const page = await load(ACTIVE_HUNT);
    try {
      const state = await readHuntState(page);
      assert.equal(state.enemies.length, 0);
      assert.equal(state.totalEnemiesFound, 216);
    } finally {
      await page.close();
    }
  });

  it('prepareEnemyBattleSelection returns the icon tile instead of an empty list', async () => {
    const page = await load(POST_STOP_ICON);
    try {
      const state = await prepareEnemyBattleSelection(page, 4_000, 2_000);
      assert.equal(pickBattleEnemy(state.enemies)?.name, 'Rabbit');
    } finally {
      await page.close();
    }
  });
});


/** Battle button present but does not start a fight — must return failed. */
const BATTLE_FLOW_NOOP = `<!DOCTYPE html>
<html><body>
  <div id="nearby">
    <div>ENEMIES NEARBY</div>
    <div role="button" id="tile">
      <img alt="Rabbit" src="/enemies/rabbit.png" style="width:72px;height:72px" />
      <span>10</span>
    </div>
  </div>
  <div id="modal" hidden x-data="show-battle-entity">
    <h2>Rabbit</h2>
    <div>3 Combat EXP</div>
    <div>STANCE</div>
    <select name="location"><option value="balanced">Balanced (All Stats)</option></select>
    <div>ENEMIES</div>
    <input id="max_enemies" value="1" />
    <button type="button" id="enemax">Max</button>
    <button type="button" id="battle">Battle</button>
  </div>
  <script>
    document.getElementById('tile').addEventListener('click', () => {
      document.getElementById('modal').hidden = false;
    });
    document.getElementById('battle').addEventListener('click', () => {
      document.body.dataset.battled = '1';
      // Intentionally do NOT show Run Away — simulates live no-op Battle click.
    });
  </script>
</body></html>`;

describe('battle from monster image', () => {
  it('clicks the image, packs Cooked Cod, Maxes enemies, then Battle', async () => {
    const page = await load(BATTLE_FLOW);
    try {
      const result = await configureAndBattle(page, 0, 1, 'Balanced');
      assert.equal(result, 'battle_started');
      assert.equal(await page.locator('#max_enemies').inputValue(), '218');
      assert.equal(await page.locator('body').getAttribute('data-order'), 'food,max,battle');
    } finally {
      await page.close();
    }
  });

  it('still clicks Battle when the food picker is empty', async () => {
    const page = await load(BATTLE_FLOW_NO_FOOD);
    try {
      const result = await configureAndBattle(page, 0, 1, 'Balanced');
      assert.equal(result, 'battle_started');
      assert.equal(await page.locator('body').getAttribute('data-battled'), '1');
    } finally {
      await page.close();
    }
  });

  it('clicks Battle when the show-battle-entity modal covers Hunt More', async () => {
    const page = await load(BATTLE_MODAL_BLOCKS_HUNT_MORE);
    try {
      const result = await huntMore(page, false);
      assert.equal(result, 'battle_started');
      assert.equal(await page.locator('body').getAttribute('data-battled'), '1');
    } finally {
      await page.close();
    }
  });

  it('returns failed when Battle click does not reveal Run Away', async () => {
    const prev = process.env.COMBAT_FIGHT_CONFIRM_MS;
    process.env.COMBAT_FIGHT_CONFIRM_MS = '1500';
    const page = await load(BATTLE_FLOW_NOOP);
    try {
      const result = await configureAndBattle(page, 0, 1, 'Balanced');
      assert.equal(result, 'failed');
      assert.equal(await page.locator('body').getAttribute('data-battled'), '1');
      assert.equal(await page.getByRole('button', { name: 'Run Away', exact: true }).count(), 0);
    } finally {
      if (prev === undefined) delete process.env.COMBAT_FIGHT_CONFIRM_MS;
      else process.env.COMBAT_FIGHT_CONFIRM_MS = prev;
      await page.close();
    }
  });

  it('solves a delayed Quick check after Battle and then starts the fight', async () => {
    const prev = process.env.COMBAT_FIGHT_CONFIRM_MS;
    process.env.COMBAT_FIGHT_CONFIRM_MS = '12000';
    const page = await load(BATTLE_FLOW_QUICK_CHECK);
    try {
      const result = await configureAndBattle(page, 0, 1, 'Balanced');
      assert.equal(result, 'battle_started');
      assert.equal(await page.locator('body').getAttribute('data-battled'), '1');
      assert.equal(await page.locator('body').getAttribute('data-captcha'), 'tree');
      assert.equal(await page.getByRole('button', { name: 'Run Away', exact: true }).count(), 1);
      assert.equal(await page.locator('#captcha').isVisible(), false);
    } finally {
      if (prev === undefined) delete process.env.COMBAT_FIGHT_CONFIRM_MS;
      else process.env.COMBAT_FIGHT_CONFIRM_MS = prev;
      await page.close();
    }
  });

  it('clicks Start anyway when Battle is pressed during another action', async () => {
    const page = await load(BATTLE_FLOW_REPLACE_DIALOG);
    try {
      const result = await configureAndBattle(page, 0, 1, 'Balanced', true);
      assert.equal(result, 'battle_started');
      assert.equal(await page.locator('body').getAttribute('data-battled'), '1');
      assert.equal(await page.locator('body').getAttribute('data-started-anyway'), '1');
      assert.equal(await page.locator('body').getAttribute('data-replace-closed'), null);
      assert.equal(await page.locator('body').getAttribute('data-modal-closed'), null);
      assert.equal(await page.getByRole('button', { name: 'Run Away', exact: true }).count(), 1);
      assert.equal(await page.locator('#replace').isVisible(), false);
    } finally {
      await page.close();
    }
  });

  it('closes the replace dialog and does not fight when interrupt is off', async () => {
    const page = await load(BATTLE_FLOW_REPLACE_DIALOG);
    try {
      const result = await configureAndBattle(page, 0, 1, 'Balanced');
      assert.equal(result, 'no_action');
      assert.equal(await page.locator('body').getAttribute('data-battled'), '1');
      assert.equal(await page.locator('body').getAttribute('data-replace-closed'), '1');
      assert.equal(await page.locator('body').getAttribute('data-started-anyway'), null);
      assert.equal(await page.getByRole('button', { name: 'Run Away', exact: true }).count(), 0);
    } finally {
      await page.close();
    }
  });

  it('starts the fight from Hunt More when Battle needs Start anyway', async () => {
    const page = await load(BATTLE_MODAL_REPLACE_DIALOG);
    try {
      const result = await huntMore(page, true);
      assert.equal(result, 'battle_started');
      assert.equal(await page.locator('body').getAttribute('data-started-anyway'), '1');
      assert.equal(await page.getByRole('button', { name: 'Run Away', exact: true }).count(), 1);
    } finally {
      await page.close();
    }
  });

  it('solves Quick check after Start anyway and then shows Run Away', async () => {
    const prev = process.env.COMBAT_FIGHT_CONFIRM_MS;
    process.env.COMBAT_FIGHT_CONFIRM_MS = '12000';
    const page = await load(BATTLE_FLOW_REPLACE_THEN_CAPTCHA);
    try {
      const result = await configureAndBattle(page, 0, 1, 'Balanced', true);
      assert.equal(result, 'battle_started');
      assert.equal(await page.locator('body').getAttribute('data-started-anyway'), '1');
      assert.equal(await page.locator('body').getAttribute('data-captcha'), 'tree');
      assert.equal(await page.getByRole('button', { name: 'Run Away', exact: true }).count(), 1);
      assert.equal(await page.locator('#captcha').isVisible(), false);
    } finally {
      if (prev === undefined) delete process.env.COMBAT_FIGHT_CONFIRM_MS;
      else process.env.COMBAT_FIGHT_CONFIRM_MS = prev;
      await page.close();
    }
  });
});

/**
 * Battle click opens gawain-captcha after a short delay (Alpine is_processing),
 * so the immediate post-click probe can miss it. Only the Tree emoji continues.
 */
const BATTLE_FLOW_QUICK_CHECK = `<!DOCTYPE html>
<html><body>
  <div id="nearby">
    <div>ENEMIES NEARBY</div>
    <div role="button" id="tile">
      <img alt="Rabbit" src="/enemies/rabbit.png" style="width:72px;height:72px" />
      <span>10</span>
    </div>
  </div>
  <div id="modal" hidden x-data="show-battle-entity">
    <h2>Rabbit</h2>
    <div>3 Combat EXP</div>
    <div>STANCE</div>
    <select name="location"><option value="balanced">Balanced (All Stats)</option></select>
    <div>ENEMIES</div>
    <input id="max_enemies" value="1" />
    <button type="button" id="enemax">Max</button>
    <button type="button" id="battle">Battle</button>
  </div>
  <div id="captcha" hidden role="dialog" x-data="gawain-captcha">
    <h2>Quick check</h2>
    <p>Thanks for playing. Choose the matching emoji below so we know you're here.</p>
    <p>Press the Tree emoji to continue.</p>
    <button type="button" id="heart">❤️</button>
    <button type="button" id="tree">🌳</button>
    <button type="button" id="star">⭐</button>
    <button type="button" id="sun">☀️</button>
    <button type="button" id="key">🔑</button>
    <button type="button" id="apple">🍎</button>
  </div>
  <script>
    const note = (id) => {
      document.body.dataset.captcha = id;
    };
    document.getElementById('tile').addEventListener('click', () => {
      document.getElementById('modal').hidden = false;
    });
    document.getElementById('battle').addEventListener('click', () => {
      document.body.dataset.battled = '1';
      setTimeout(() => {
        document.getElementById('captcha').hidden = false;
      }, 700);
    });
    document.getElementById('tree').addEventListener('click', () => {
      note('tree');
      document.getElementById('captcha').hidden = true;
      const flee = document.createElement('button');
      flee.type = 'button';
      flee.textContent = 'Run Away';
      document.body.appendChild(flee);
    });
    for (const id of ['heart', 'star', 'sun', 'key', 'apple']) {
      document.getElementById(id).addEventListener('click', () => note(id));
    }
  </script>
</body></html>`;

/**
 * Gather-busy Battle: modal Battle opens confirm-action-request
 * ("Start a new action?" / Start anyway) instead of Run Away.
 * The entity modal's own Close must not be the button we press.
 */
const BATTLE_FLOW_REPLACE_DIALOG = `<!DOCTYPE html>
<html><body>
  <div id="nearby">
    <div>ENEMIES NEARBY</div>
    <div role="button" id="tile">
      <img alt="Rabbit" src="/enemies/rabbit.png" style="width:72px;height:72px" />
      <span>10</span>
    </div>
  </div>
  <div id="modal" hidden x-data="show-battle-entity">
    <h2>Rabbit</h2>
    <div>3 Combat EXP</div>
    <div>STANCE</div>
    <select name="location"><option value="balanced">Balanced (All Stats)</option></select>
    <div>ENEMIES</div>
    <input id="max_enemies" value="1" />
    <button type="button" id="enemax">Max</button>
    <button type="button" id="modal-close" aria-label="Close">×</button>
    <button type="button" id="battle">Battle</button>
  </div>
  <div id="replace" hidden x-data="modal('confirm-action-request', false, null)">
    <h2>Start a new action?</h2>
    <p>You are already doing an action right now.</p>
    <p>Starting a new action may finish, stop, or replace the action you are doing.</p>
    <button type="button" id="replace-close">Close</button>
    <button type="button" id="start-anyway">Start anyway</button>
  </div>
  <script>
    document.getElementById('tile').addEventListener('click', () => {
      document.getElementById('modal').hidden = false;
    });
    document.getElementById('battle').addEventListener('click', () => {
      document.body.dataset.battled = '1';
      document.getElementById('replace').hidden = false;
    });
    document.getElementById('start-anyway').addEventListener('click', () => {
      document.body.dataset.startedAnyway = '1';
      document.getElementById('replace').hidden = true;
      const flee = document.createElement('button');
      flee.type = 'button';
      flee.textContent = 'Run Away';
      document.body.appendChild(flee);
    });
    document.getElementById('replace-close').addEventListener('click', () => {
      document.body.dataset.replaceClosed = '1';
      document.getElementById('replace').hidden = true;
    });
    document.getElementById('modal-close').addEventListener('click', () => {
      document.body.dataset.modalClosed = '1';
      document.getElementById('modal').hidden = true;
    });
  </script>
</body></html>`;

/** Same confirm dialog, but the battle modal is already open (Hunt More path). */
const BATTLE_MODAL_REPLACE_DIALOG = `<!DOCTYPE html>
<html><body>
  <div id="modal" x-data="show-battle-entity">
    <h2>Rabbit</h2>
    <div>3 Combat EXP</div>
    <div>STANCE</div>
    <select name="location"><option value="balanced">Balanced (All Stats)</option></select>
    <div>ENEMIES</div>
    <input id="max_enemies" value="4" />
    <button type="button" id="enemax">Max</button>
    <button type="button" id="modal-close" aria-label="Close">×</button>
    <button type="button" id="battle">Battle</button>
  </div>
  <div id="replace" hidden x-data="modal('confirm-action-request', false, null)">
    <h2>Start a new action?</h2>
    <p>You are already doing an action right now.</p>
    <button type="button" id="replace-close">Close</button>
    <button type="button" id="start-anyway">Start anyway</button>
  </div>
  <script>
    document.getElementById('battle').addEventListener('click', () => {
      document.body.dataset.battled = '1';
      document.getElementById('replace').hidden = false;
    });
    document.getElementById('start-anyway').addEventListener('click', () => {
      document.body.dataset.startedAnyway = '1';
      document.getElementById('replace').hidden = true;
      document.getElementById('modal').remove();
      const flee = document.createElement('button');
      flee.type = 'button';
      flee.textContent = 'Run Away';
      document.body.appendChild(flee);
    });
    document.getElementById('replace-close').addEventListener('click', () => {
      document.body.dataset.replaceClosed = '1';
      document.getElementById('replace').hidden = true;
    });
  </script>
</body></html>`;

/** Start anyway, then the same delayed gawain Quick check as a normal Battle click. */
const BATTLE_FLOW_REPLACE_THEN_CAPTCHA = `<!DOCTYPE html>
<html><body>
  <div id="nearby">
    <div>ENEMIES NEARBY</div>
    <div role="button" id="tile">
      <img alt="Rabbit" src="/enemies/rabbit.png" style="width:72px;height:72px" />
      <span>10</span>
    </div>
  </div>
  <div id="modal" hidden x-data="show-battle-entity">
    <h2>Rabbit</h2>
    <div>3 Combat EXP</div>
    <div>STANCE</div>
    <select name="location"><option value="balanced">Balanced (All Stats)</option></select>
    <div>ENEMIES</div>
    <input id="max_enemies" value="1" />
    <button type="button" id="enemax">Max</button>
    <button type="button" id="battle">Battle</button>
  </div>
  <div id="replace" hidden x-data="modal('confirm-action-request', false, null)">
    <h2>Start a new action?</h2>
    <p>You are already doing an action right now.</p>
    <button type="button" id="start-anyway">Start anyway</button>
    <button type="button" id="replace-close">Close</button>
  </div>
  <div id="captcha" hidden role="dialog" x-data="gawain-captcha">
    <h2>Quick check</h2>
    <p>Thanks for playing. Choose the matching emoji below so we know you're here.</p>
    <p>Press the Tree emoji to continue.</p>
    <button type="button" id="heart">❤️</button>
    <button type="button" id="tree">🌳</button>
    <button type="button" id="star">⭐</button>
  </div>
  <script>
    const note = (id) => {
      document.body.dataset.captcha = id;
    };
    document.getElementById('tile').addEventListener('click', () => {
      document.getElementById('modal').hidden = false;
    });
    document.getElementById('battle').addEventListener('click', () => {
      document.body.dataset.battled = '1';
      document.getElementById('replace').hidden = false;
    });
    document.getElementById('start-anyway').addEventListener('click', () => {
      document.body.dataset.startedAnyway = '1';
      document.getElementById('replace').hidden = true;
      setTimeout(() => {
        document.getElementById('captcha').hidden = false;
      }, 700);
    });
    document.getElementById('tree').addEventListener('click', () => {
      note('tree');
      document.getElementById('captcha').hidden = true;
      const flee = document.createElement('button');
      flee.type = 'button';
      flee.textContent = 'Run Away';
      document.body.appendChild(flee);
    });
    for (const id of ['heart', 'star']) {
      document.getElementById(id).addEventListener('click', () => note(id));
    }
  </script>
</body></html>`;

/** Confirm copy from the live "Stop Hunting" dialog (Close + purple Stop). */
const STOP_HUNTING_DIALOG = `<!DOCTYPE html>
<html><body>
  <div id="dialog">
    <h2>Stop Hunting</h2>
    <p>The enemies you've already hunted will be ready to battle right away.</p>
    <p>You can jump back into hunting anytime, as long as you haven't hit your limit. Any new enemies you discover will be added to the ones you're already found.</p>
    <button type="button" id="close">Close</button>
    <button type="button" id="confirm">Stop</button>
  </div>
  <div id="nearby" hidden>ENEMIES NEARBY</div>
  <button type="button" id="hunt-more" hidden>Hunt More</button>
  <script>
    document.getElementById('close').addEventListener('click', () => {
      document.body.dataset.closed = '1';
    });
    document.getElementById('confirm').addEventListener('click', () => {
      document.body.dataset.stopped = '1';
      document.getElementById('dialog').hidden = true;
      document.getElementById('nearby').hidden = false;
      document.getElementById('hunt-more').hidden = false;
    });
  </script>
</body></html>`;

/** Panel Stop only opens the dialog and then hides, so a second Stop is not already in the DOM. */
const STOP_OPENS_CONFIRM = `<!DOCTYPE html>
<html><body>
  <button type="button" id="panel-stop">Stop</button>
  <div id="dialog" hidden>
    <h2>Stop Hunting</h2>
    <p>The enemies you've already hunted will be ready to battle right away.</p>
    <button type="button" id="close">Close</button>
    <button type="button" id="confirm">Stop</button>
  </div>
  <div id="nearby" hidden>ENEMIES NEARBY</div>
  <script>
    document.getElementById('panel-stop').addEventListener('click', () => {
      document.getElementById('panel-stop').remove();
      document.getElementById('dialog').hidden = false;
    });
    document.getElementById('close').addEventListener('click', () => {
      document.body.dataset.closed = '1';
    });
    document.getElementById('confirm').addEventListener('click', () => {
      document.body.dataset.stopped = '1';
      document.getElementById('dialog').hidden = true;
      document.getElementById('nearby').hidden = false;
    });
  </script>
</body></html>`;

/**
 * Live freeze: ENEMIES NEARBY icon tiles (Duck / Goblin / King Goblin) already
 * on screen with Hunt More underneath. No Start Hunt, no Stop, not in battle.
 */
const ENEMIES_READY_AND_HUNT_MORE = `<!DOCTYPE html>
<html><body>
  <div id="wrap" style="position:relative;width:900px;height:640px">
    <div style="position:absolute;top:240px;left:160px">ENEMIES NEARBY</div>
    <div role="button" id="duck" style="position:absolute;top:300px;left:160px">
      <img alt="Duck" src="/enemies/duck.png" style="width:72px;height:72px" />
      <span>2</span>
    </div>
    <div role="button" id="goblin" style="position:absolute;top:300px;left:280px">
      <img alt="Goblin" src="/enemies/goblin.png" style="width:72px;height:72px" />
      <span>140</span>
    </div>
    <div role="button" id="king" style="position:absolute;top:300px;left:400px">
      <img alt="King Goblin" src="/enemies/king-goblin.png" style="width:72px;height:72px" />
      <span>116</span>
    </div>
    <button type="button" id="hunt-more" style="position:absolute;top:400px;left:520px">Hunt More</button>
  </div>
  <script>
    document.getElementById('hunt-more').addEventListener('click', () => {
      const n = Number(document.body.dataset.huntMoreClicks || '0') + 1;
      document.body.dataset.huntMoreClicks = String(n);
    });
  </script>
</body></html>`;

/** Hunt More alone — no enemy tiles. Click must still go through the Hunt More path. */
const HUNT_MORE_ONLY = `<!DOCTYPE html>
<html><body>
  <button type="button" id="hunt-more">Hunt More</button>
  <script>
    document.getElementById('hunt-more').addEventListener('click', () => {
      const n = Number(document.body.dataset.huntMoreClicks || '0') + 1;
      document.body.dataset.huntMoreClicks = String(n);
    });
  </script>
</body></html>`;

/**
 * Tiles appear only after Hunt More is clicked, and the click does not start a hunt.
 * Defense in depth should fall back to enemy_select_ready.
 */
const HUNT_MORE_REVEALS_TILES = `<!DOCTYPE html>
<html><body>
  <div id="wrap" style="position:relative;width:900px;height:640px">
    <div id="nearby" hidden>
      <div style="position:absolute;top:240px;left:160px">ENEMIES NEARBY</div>
      <div role="button" id="duck" style="position:absolute;top:300px;left:160px">
        <img alt="Duck" src="/enemies/duck.png" style="width:72px;height:72px" />
        <span>2</span>
      </div>
    </div>
    <button type="button" id="hunt-more" style="position:absolute;top:400px;left:520px">Hunt More</button>
  </div>
  <script>
    document.getElementById('hunt-more').addEventListener('click', () => {
      const n = Number(document.body.dataset.huntMoreClicks || '0') + 1;
      document.body.dataset.huntMoreClicks = String(n);
      document.getElementById('nearby').hidden = false;
    });
  </script>
</body></html>`;

/** Idle Battle screen: Start Hunt stays first even if Hunt More is also present. */
const IDLE_START_HUNT = `<!DOCTYPE html>
<html><body>
  <p>Start a hunt to find nearby enemies</p>
  <button type="button" id="start">Start Hunt</button>
  <button type="button" id="hunt-more">Hunt More</button>
  <script>
    document.getElementById('hunt-more').addEventListener('click', () => {
      const n = Number(document.body.dataset.huntMoreClicks || '0') + 1;
      document.body.dataset.huntMoreClicks = String(n);
    });
    document.getElementById('start').addEventListener('click', () => {
      document.body.dataset.startHuntClicks = '1';
      document.getElementById('start').remove();
      const stop = document.createElement('button');
      stop.type = 'button';
      stop.textContent = 'Stop';
      document.body.appendChild(stop);
      const hunting = document.createElement('div');
      hunting.textContent = 'Hunting';
      document.body.appendChild(hunting);
      const found = document.createElement('div');
      found.textContent = 'Total Enemies Found';
      document.body.appendChild(found);
    });
  </script>
</body></html>`;

function testConfig(baseUrl: string): AppConfig {
  return {
    baseUrl,
    pollMs: 2000,
    headless: true,
    storageStatePath: undefined,
    buyBait: false,
    forceInterrupt: false,
    sellGoldThreshold: 800,
    characterName: undefined,
    accountSlug: undefined,
  };
}

async function serveHtml(html: string): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('combat test server failed to bind');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function withServedCombatPage(
  html: string,
  fn: (page: Page, config: AppConfig, logs: string[]) => Promise<void>,
): Promise<void> {
  const served = await serveHtml(html);
  const page = await browser.newPage();
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((part) => String(part)).join(' '));
    original(...args);
  };
  try {
    await fn(page, testConfig(served.baseUrl), logs);
  } finally {
    console.log = original;
    await page.close();
    await served.close();
  }
}

describe('ensureHuntActive enemy selection vs Hunt More', () => {
  it('returns enemy_select_ready for ENEMIES NEARBY tiles without clicking Hunt More', async () => {
    await withServedCombatPage(ENEMIES_READY_AND_HUNT_MORE, async (page, config, logs) => {
      const result = await ensureHuntActive(page, config, false);
      assert.equal(result, 'enemy_select_ready');
      assert.equal(await page.locator('body').getAttribute('data-hunt-more-clicks'), null);
      assert.equal(
        logs.some((line) => line.includes('Hunt More returned')),
        false,
      );
    });
  });

  it('still clicks Hunt More when no enemy tiles are ready', async () => {
    await withServedCombatPage(HUNT_MORE_ONLY, async (page, config, logs) => {
      const result = await ensureHuntActive(page, config, false);
      assert.equal(result, 'failed');
      assert.equal(await page.locator('body').getAttribute('data-hunt-more-clicks'), '1');
      assert.ok(
        logs.some((line) => line.includes('ensureHuntActive failed (hunt_more)')),
        `expected hunt_more failure log, got: ${logs.join(' | ')}`,
      );
      assert.ok(
        logs.some((line) => line.includes('huntMore=true') && line.includes('enemySelect=false')),
        `expected button probe, got: ${logs.join(' | ')}`,
      );
    });
  });

  it('keeps Start Hunt first on the idle battle screen', async () => {
    await withServedCombatPage(IDLE_START_HUNT, async (page, config, logs) => {
      const result = await ensureHuntActive(page, config, false);
      assert.equal(result, 'hunt_started');
      assert.equal(await page.locator('body').getAttribute('data-start-hunt-clicks'), '1');
      assert.equal(await page.locator('body').getAttribute('data-hunt-more-clicks'), null);
      assert.equal(
        logs.some((line) => line.includes('ensureHuntActive failed')),
        false,
      );
    });
  });

  it('falls back to enemy_select_ready when Hunt More fails and tiles are ready', async () => {
    await withServedCombatPage(HUNT_MORE_REVEALS_TILES, async (page, config, logs) => {
      const result = await ensureHuntActive(page, config, false);
      assert.equal(result, 'enemy_select_ready');
      assert.equal(await page.locator('body').getAttribute('data-hunt-more-clicks'), '1');
      assert.ok(
        logs.some((line) =>
          line.includes('Hunt More returned failed; enemy selection is ready — using enemy_select_ready'),
        ),
        `expected fallback log, got: ${logs.join(' | ')}`,
      );
    });
  });
});

/**
 * Probe shape: ENEMIES NEARBY counts 2 / 140 / 116 and Hunt More, but no
 * img[alt=Duck]. A collapsed duck image (no alt) still names Duck from its src.
 * Character-sheet numbers must not become tiles.
 */
const COUNT_BADGES_NO_ALT = `<!DOCTYPE html>
<html><body>
  <div id="wrap" style="position:relative;width:980px;height:720px">
    <div style="position:absolute;top:80px;left:180px;width:160px;height:18px">ENEMIES NEARBY</div>
    <div id="duck" style="position:absolute;top:120px;left:180px;width:72px;height:72px">
      <img alt="" src="/enemies/duck.png" style="width:0;height:0" />
      <span>2</span>
    </div>
    <div id="goblin" style="position:absolute;top:120px;left:280px;width:72px;height:72px"><span>140</span></div>
    <div id="crown" style="position:absolute;top:120px;left:400px;width:72px;height:72px"><span>116</span></div>
    <button type="button" id="hunt-more" style="position:absolute;top:140px;left:520px">Hunt More</button>
    <section style="position:absolute;top:80px;left:760px;width:180px">
      <div>YOUR CHARACTER</div>
      <div>Combat</div>
      <div>Lv. 9</div>
      <div>Attack Power</div>
      <div id="stat-58" style="width:40px;height:20px">58</div>
      <div>Agility</div>
      <div id="stat-2" style="width:40px;height:20px">2</div>
    </section>
  </div>
  <script>
    document.getElementById('hunt-more').addEventListener('click', () => {
      document.body.dataset.huntMoreClicks = String(Number(document.body.dataset.huntMoreClicks || '0') + 1);
    });
  </script>
</body></html>`;

/** Active hunt zone pool (40) under ENEMIES NEARBY must not become a selectable tile. */
const ACTIVE_HUNT_ZONE_POOL = `<!DOCTYPE html>
<html><body>
  <button type="button">Stop</button>
  <div>Hunting</div>
  <div>Total Enemies Found</div>
  <div>10</div>
  <div style="position:absolute;top:200px;left:180px">ENEMIES NEARBY</div>
  <div style="position:absolute;top:240px;left:180px;width:48px;height:24px">40</div>
</body></html>`;

const BATTLE_MODAL_SHELL = `
  <div id="modal" hidden x-data="show-battle-entity">
    <h2 id="who">Enemy</h2>
    <div>3 Combat EXP</div>
    <div>FOOD</div>
    <div>STANCE</div>
    <select name="location"><option value="offensive">Offensive (Damage)</option></select>
    <div>ENEMIES</div>
    <button type="button" id="enemax">Max</button>
    <button type="button" id="battle" disabled x-bind:disabled="selected_battle_entity?.status?.is_restrictive || is_processing">Battle</button>
    <button type="button" id="close">Close</button>
  </div>`;

function battleModalScript(enableNames: string): string {
  return `<script>
    const battle = document.getElementById('battle');
    const modal = document.getElementById('modal');
    const enable = new Set(${enableNames});
    const openEnemy = (name) => {
      const opened = document.body.dataset.opened ? document.body.dataset.opened.split(',') : [];
      opened.push(name);
      document.body.dataset.opened = opened.join(',');
      document.getElementById('who').textContent = name;
      if (enable.has(name)) {
        battle.disabled = false;
        battle.removeAttribute('disabled');
      } else {
        battle.disabled = true;
        battle.setAttribute('disabled', 'disabled');
      }
      modal.hidden = false;
    };
    document.querySelectorAll('[data-enemy]').forEach((tile) => {
      tile.addEventListener('click', () => openEnemy(tile.getAttribute('data-enemy')));
    });
    document.getElementById('close').addEventListener('click', () => {
      modal.hidden = true;
    });
    document.getElementById('enemax').addEventListener('click', () => {
      document.body.dataset.maxClicks = String(Number(document.body.dataset.maxClicks || '0') + 1);
    });
    battle.addEventListener('click', () => {
      if (battle.disabled) {
        document.body.dataset.clickedDisabled = '1';
        return;
      }
      document.body.dataset.battled = document.getElementById('who').textContent;
      modal.hidden = true;
      const flee = document.createElement('button');
      flee.type = 'button';
      flee.textContent = 'Run Away';
      document.body.appendChild(flee);
    });
  </script>`;
}

/** Rabbit is restrictive; Duck is the next tile and can fight. Goblin must not be opened. */
const BATTLE_SKIPS_RESTRICTIVE = `<!DOCTYPE html>
<html><body>
  <div id="wrap" style="position:relative;width:900px;height:640px">
    <div style="position:absolute;top:80px;left:160px">ENEMIES NEARBY</div>
    <div role="button" data-enemy="Duck" style="position:absolute;top:120px;left:160px">
      <img alt="Duck" src="/enemies/duck.png" style="width:72px;height:72px" />
      <span>2</span>
    </div>
    <div role="button" data-enemy="Rabbit" style="position:absolute;top:120px;left:280px">
      <img alt="Rabbit" src="/enemies/rabbit.png" style="width:72px;height:72px" />
      <span>8</span>
    </div>
    <div role="button" data-enemy="Goblin" style="position:absolute;top:120px;left:400px">
      <img alt="Goblin" src="/enemies/goblin.png" style="width:72px;height:72px" />
      <span>140</span>
    </div>
    <button type="button" style="position:absolute;top:140px;left:560px">Hunt More</button>
  </div>
  ${BATTLE_MODAL_SHELL}
  ${battleModalScript("['Duck', 'Goblin']")}
</body></html>`;

/** Battle starts disabled and becomes enabled shortly after Max. */
const BATTLE_ENABLES_AFTER_MAX = `<!DOCTYPE html>
<html><body>
  <div style="position:relative;width:640px;height:480px">
    <div style="position:absolute;top:40px;left:40px">ENEMIES NEARBY</div>
    <div role="button" id="tile" data-enemy="Rabbit" style="position:absolute;top:80px;left:40px">
      <img alt="Rabbit" src="/enemies/rabbit.png" style="width:72px;height:72px" />
      <span>4</span>
    </div>
  </div>
  ${BATTLE_MODAL_SHELL}
  <script>
    const battle = document.getElementById('battle');
    const modal = document.getElementById('modal');
    document.getElementById('tile').addEventListener('click', () => {
      document.getElementById('who').textContent = 'Rabbit';
      battle.disabled = true;
      battle.setAttribute('disabled', 'disabled');
      modal.hidden = false;
    });
    document.getElementById('close').addEventListener('click', () => {
      modal.hidden = true;
    });
    document.getElementById('enemax').addEventListener('click', () => {
      document.body.dataset.maxWhileDisabled = battle.disabled ? '1' : '0';
      setTimeout(() => {
        battle.disabled = false;
        battle.removeAttribute('disabled');
      }, 400);
    });
    battle.addEventListener('click', () => {
      if (battle.disabled) return;
      document.body.dataset.battled = 'Rabbit';
      modal.hidden = true;
      const flee = document.createElement('button');
      flee.type = 'button';
      flee.textContent = 'Run Away';
      document.body.appendChild(flee);
    });
  </script>
</body></html>`;

/** Single restrictive enemy: Battle never enables. Must return failed, not throw. */
const BATTLE_STAYS_DISABLED = `<!DOCTYPE html>
<html><body>
  <div style="position:relative;width:640px;height:480px">
    <div style="position:absolute;top:40px;left:40px">ENEMIES NEARBY</div>
    <div role="button" id="tile" data-enemy="Duck" style="position:absolute;top:80px;left:40px">
      <img alt="Duck" src="/enemies/duck.png" style="width:72px;height:72px" />
      <span>2</span>
    </div>
  </div>
  ${BATTLE_MODAL_SHELL}
  ${battleModalScript('[]')}
</body></html>`;

/** Count badge with no image still opens the battle modal. */
const BATTLE_FROM_COUNT_BADGE = `<!DOCTYPE html>
<html><body>
  <div style="position:relative;width:640px;height:480px">
    <div style="position:absolute;top:40px;left:40px;width:140px;height:18px">ENEMIES NEARBY</div>
    <div id="badge" data-enemy="stack 2" style="position:absolute;top:80px;left:40px;width:72px;height:72px">2</div>
  </div>
  ${BATTLE_MODAL_SHELL}
  ${battleModalScript("['stack 2']")}
</body></html>`;

async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string[] }> {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((part) => String(part)).join(' '));
    original(...args);
  };
  try {
    return { result: await fn(), logs };
  } finally {
    console.log = original;
  }
}

describe('enemy count badges without alt images', () => {
  it('reads stack badges under ENEMIES NEARBY and ignores character stats', async () => {
    const page = await load(COUNT_BADGES_NO_ALT);
    try {
      const state = await readHuntState(page);
      assert.deepEqual(
        state.enemies.map((enemy) => enemy.name),
        ['Duck', 'stack 140', 'stack 116'],
      );
    } finally {
      await page.close();
    }
  });

  it('does not treat the active-hunt zone pool as an enemy tile', async () => {
    const page = await load(ACTIVE_HUNT_ZONE_POOL);
    try {
      const state = await readHuntState(page);
      assert.equal(state.enemies.length, 0);
      assert.equal(state.totalEnemiesFound, 10);
    } finally {
      await page.close();
    }
  });

  it('prefers count-badge enemies over Hunt More', async () => {
    await withServedCombatPage(COUNT_BADGES_NO_ALT, async (page, config) => {
      const result = await ensureHuntActive(page, config, false);
      assert.equal(result, 'enemy_select_ready');
      assert.equal(await page.locator('body').getAttribute('data-hunt-more-clicks'), null);
    });
  });
});

describe('disabled Battle button', () => {
  it('waits for Battle to become enabled after Max', async () => {
    const page = await load(BATTLE_ENABLES_AFTER_MAX);
    try {
      const result = await configureAndBattle(page, 0, 1, 'Offensive');
      assert.equal(result, 'battle_started');
      assert.equal(await page.locator('body').getAttribute('data-max-while-disabled'), '1');
      assert.equal(await page.locator('body').getAttribute('data-battled'), 'Rabbit');
    } finally {
      await page.close();
    }
  });

  it('returns failed when Battle stays disabled instead of throwing', async () => {
    const prev = process.env.COMBAT_BATTLE_ENABLE_MS;
    process.env.COMBAT_BATTLE_ENABLE_MS = '700';
    const page = await load(BATTLE_STAYS_DISABLED);
    try {
      const { result, logs } = await captureLogs(() => configureAndBattle(page, 0, 1, 'Offensive'));
      assert.equal(result, 'failed');
      assert.equal(await page.locator('body').getAttribute('data-battled'), null);
      assert.equal(await page.locator('body').getAttribute('data-clicked-disabled'), null);
      const stayed = logs.find((line) => line.includes('Battle stayed disabled for Duck'));
      assert.ok(stayed, `expected disabled log, got: ${logs.join(' | ')}`);
      assert.match(stayed, /bind looks restrictive or processing/);
      assert.match(stayed, /is_restrictive/);
      assert.match(stayed, /is_processing/);
    } finally {
      if (prev === undefined) delete process.env.COMBAT_BATTLE_ENABLE_MS;
      else process.env.COMBAT_BATTLE_ENABLE_MS = prev;
      await page.close();
    }
  });

  it('tries the next enemy when the preferred tile leaves Battle disabled', async () => {
    const prev = process.env.COMBAT_BATTLE_ENABLE_MS;
    process.env.COMBAT_BATTLE_ENABLE_MS = '700';
    const page = await load(BATTLE_SKIPS_RESTRICTIVE);
    try {
      const { result, logs } = await captureLogs(() => configureAndBattle(page, 0, 1, 'Offensive'));
      assert.equal(result, 'battle_started');
      assert.equal(await page.locator('body').getAttribute('data-opened'), 'Rabbit,Duck');
      assert.equal(await page.locator('body').getAttribute('data-battled'), 'Duck');
      assert.ok(logs.some((line) => line.includes('Battle stayed disabled for Rabbit')));
      assert.ok(logs.some((line) => line.includes('trying next enemy tile: Duck')));
      assert.equal(
        logs.some((line) => line.includes('opening enemy tile: Goblin')),
        false,
      );
    } finally {
      if (prev === undefined) delete process.env.COMBAT_BATTLE_ENABLE_MS;
      else process.env.COMBAT_BATTLE_ENABLE_MS = prev;
      await page.close();
    }
  });

  it('battles a count badge when the tile has no enemy image', async () => {
    const page = await load(BATTLE_FROM_COUNT_BADGE);
    try {
      const result = await configureAndBattle(page, 0, 1, 'Offensive');
      assert.equal(result, 'battle_started');
      assert.equal(await page.locator('body').getAttribute('data-opened'), 'stack 2');
      assert.equal(await page.locator('body').getAttribute('data-battled'), 'stack 2');
    } finally {
      await page.close();
    }
  });
});

type LowHealthUse = 'enable' | 'stay_low' | 'close_modal' | 'leave_overlay';

/** Battle modal with the live low-HP Heal → food → Quick Feed path. */
function lowHealthBattleHtml(options: {
  enemies: string[];
  use: LowHealthUse;
  status?: string;
  healButton?: boolean;
  battleDisabled?: boolean;
}): string {
  const status = options.status ?? 'CHARACTER_HEALTH_TOO_LOW';
  const healButton = options.healButton !== false;
  const battleDisabled = options.battleDisabled !== false;
  const tiles = options.enemies
    .map((name, index) => {
      const left = 160 + index * 120;
      return `<div role="button" data-enemy="${name}" style="position:absolute;top:120px;left:${left}px">
      <img alt="${name}" src="/enemies/${name.toLowerCase()}.png" style="width:72px;height:72px" />
      <span>${index + 2}</span>
    </div>`;
    })
    .join('\n');
  const disabledAttr = battleDisabled
    ? 'disabled x-bind:disabled="selected_battle_entity?.status?.is_restrictive || is_processing"'
    : '';
  return `<!DOCTYPE html>
<html><body>
  <style>
    .absolute.inset-0.bg-immo { position: fixed; inset: 0; z-index: 2; width: 100vw; height: 100vh; }
    #quick { position: relative; z-index: 3; }
  </style>
  <div id="wrap" style="position:relative;width:900px;height:640px">
    <div style="position:absolute;top:80px;left:160px">ENEMIES NEARBY</div>
    ${tiles}
    <button type="button" style="position:absolute;top:140px;left:560px">Hunt More</button>
  </div>
  <div id="modal" hidden x-data="show-battle-entity" data-status-value="${status}">
    <h2 id="who">Enemy</h2>
    <div>3 Combat EXP</div>
    <div id="problem">PROBLEM</div>
    <div id="health-copy">You do not have enough health. Heal</div>
    ${healButton ? '<button type="button" id="heal">Heal</button>' : ''}
    <div>FOOD</div>
    <div>STANCE</div>
    <select name="location"><option value="offensive">Offensive (Damage)</option></select>
    <div>ENEMIES</div>
    <button type="button" id="enemax">Max</button>
    <button type="button" id="battle" ${disabledAttr}>Battle</button>
    <button type="button" id="close">Close</button>
  </div>
  <div id="picker" hidden x-data="food-for-battle">
    <div>Food</div>
    <button type="button" id="untradable">12 Cooked Cod (Untradable) +10 Health</button>
    <button type="button" id="cod">105 Cooked Cod +10 Health</button>
  </div>
  <div id="quick" hidden x-data="quick_view_food">
    <input id="quantity" name="quantity" value="1" />
    <a href="#max-health" id="max-health">Max Health</a>
    <button type="button" id="use">Use</button>
    <button type="button" id="quick-close">Close</button>
  </div>
  <div id="dim" class="absolute inset-0 bg-immo" hidden></div>
  <script>
    window.Alpine = {
      $data(el) {
        const value = el.getAttribute('data-status-value');
        if (!value) return {};
        return { selected_battle_entity: { status: { value: value, is_restrictive: value !== 'AVAILABLE' } } };
      }
    };
    const order = [];
    const note = (step) => {
      order.push(step);
      document.body.dataset.order = order.join(',');
    };
    const battle = document.getElementById('battle');
    const modal = document.getElementById('modal');
    const markReady = () => {
      modal.setAttribute('data-status-value', 'AVAILABLE');
      const problem = document.getElementById('problem');
      const copy = document.getElementById('health-copy');
      const heal = document.getElementById('heal');
      if (problem) problem.remove();
      if (copy) copy.remove();
      if (heal) heal.remove();
      battle.disabled = false;
      battle.removeAttribute('disabled');
    };
    document.querySelectorAll('[data-enemy]').forEach((tile) => {
      tile.addEventListener('click', () => {
        const name = tile.getAttribute('data-enemy');
        const opened = document.body.dataset.opened ? document.body.dataset.opened.split(',') : [];
        opened.push(name);
        document.body.dataset.opened = opened.join(',');
        document.getElementById('who').textContent = name;
        modal.hidden = false;
      });
    });
    const heal = document.getElementById('heal');
    if (heal) {
      heal.addEventListener('click', () => {
        note('heal');
        document.getElementById('picker').hidden = false;
      });
    }
    document.getElementById('untradable').addEventListener('click', () => note('untradable'));
    document.getElementById('cod').addEventListener('click', () => {
      note('cod');
      document.getElementById('picker').hidden = true;
      document.getElementById('quick').hidden = false;
      document.getElementById('dim').hidden = false;
    });
    document.getElementById('max-health').addEventListener('click', (event) => {
      event.preventDefault();
      note('maxHealth');
      document.getElementById('quantity').value = '99';
    });
    document.getElementById('use').addEventListener('click', () => {
      note('use');
      const mode = ${JSON.stringify(options.use)};
      if (mode === 'leave_overlay') {
        document.getElementById('quick').hidden = true;
        markReady();
        return;
      }
      document.getElementById('quick').hidden = true;
      document.getElementById('dim').hidden = true;
      if (mode === 'close_modal') {
        markReady();
        modal.hidden = true;
        return;
      }
      if (mode === 'enable') markReady();
    });
    document.getElementById('quick-close').addEventListener('click', () => {
      note('dismiss');
      document.getElementById('quick').hidden = true;
      document.getElementById('dim').hidden = true;
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (!document.getElementById('dim').hidden) {
        note('escape');
        document.getElementById('dim').hidden = true;
      }
    });
    document.getElementById('close').addEventListener('click', () => {
      modal.hidden = true;
    });
    document.getElementById('enemax').addEventListener('click', () => note('max'));
    battle.addEventListener('click', () => {
      const dim = document.getElementById('dim');
      const quick = document.getElementById('quick');
      if ((dim && !dim.hidden) || (quick && !quick.hidden)) {
        document.body.dataset.overlayBlocked = '1';
        return;
      }
      if (battle.disabled) {
        document.body.dataset.clickedDisabled = '1';
        return;
      }
      note('battle');
      document.body.dataset.battled = document.getElementById('who').textContent;
      modal.hidden = true;
      const flee = document.createElement('button');
      flee.type = 'button';
      flee.textContent = 'Run Away';
      document.body.appendChild(flee);
    });
  </script>
</body></html>`;
}

describe('heal before battle when health is too low', () => {
  it('feeds tradable Cooked Cod, Max Health, Use, then Battle', async () => {
    const page = await load(lowHealthBattleHtml({ enemies: ['Duck'], use: 'enable' }));
    try {
      const { result, logs } = await captureLogs(() => configureAndBattle(page, 0, 1, 'Offensive'));
      assert.equal(result, 'battle_started');
      assert.equal(await page.locator('body').getAttribute('data-battled'), 'Duck');
      assert.equal(await page.locator('#quantity').inputValue(), '99');
      assert.equal(
        await page.locator('body').getAttribute('data-order'),
        'heal,cod,maxHealth,use,max,battle',
      );
      assert.equal(await page.locator('body').getAttribute('data-overlay-blocked'), null);
      assert.ok(logs.some((line) => line.includes('battle status CHARACTER_HEALTH_TOO_LOW')));
      assert.ok(logs.some((line) => line.includes('feeding 105 Cooked Cod +10 Health')));
      assert.equal(logs.some((line) => line.includes('Untradable')), false);
      assert.equal(logs.some((line) => line.includes('selected_battle_entity')), false);
      assert.equal(takeCookedCodSpentOnHeal(), 99);
    } finally {
      await page.close();
    }
  });

  it('does not feed when battle status is already AVAILABLE', async () => {
    const page = await load(
      lowHealthBattleHtml({
        enemies: ['Duck'],
        use: 'enable',
        status: 'AVAILABLE',
        battleDisabled: false,
      }),
    );
    try {
      const { result, logs } = await captureLogs(() => configureAndBattle(page, 0, 1, 'Offensive'));
      assert.equal(result, 'battle_started');
      assert.equal(await page.locator('body').getAttribute('data-order'), 'max,battle');
      assert.equal(logs.some((line) => line.includes('feeding')), false);
      assert.equal(logs.some((line) => line.includes('battle status')), false);
    } finally {
      await page.close();
    }
  });

  it('dismisses the quick-feed overlay with Escape after Use', async () => {
    const page = await load(lowHealthBattleHtml({ enemies: ['Duck'], use: 'leave_overlay' }));
    try {
      const result = await configureAndBattle(page, 0, 1, 'Offensive');
      assert.equal(result, 'battle_started');
      assert.equal(await page.locator('#dim').isHidden(), true);
      assert.equal(await page.locator('body').getAttribute('data-overlay-blocked'), null);
      const order = await page.locator('body').getAttribute('data-order');
      assert.match(order ?? '', /heal,cod,maxHealth,use,escape,max,battle/);
    } finally {
      await page.close();
    }
  });

  it('re-opens the enemy tile when feeding closes the battle modal', async () => {
    const page = await load(lowHealthBattleHtml({ enemies: ['Duck'], use: 'close_modal' }));
    try {
      const { result, logs } = await captureLogs(() => configureAndBattle(page, 0, 1, 'Offensive'));
      assert.equal(result, 'battle_started');
      assert.equal(await page.locator('body').getAttribute('data-opened'), 'Duck,Duck');
      assert.ok(logs.some((line) => line.includes('re-opening enemy tile after heal: Duck')));
    } finally {
      await page.close();
    }
  });

  it('returns health_too_low and does not walk other enemy tiles', async () => {
    const prev = process.env.COMBAT_BATTLE_ENABLE_MS;
    process.env.COMBAT_BATTLE_ENABLE_MS = '700';
    const page = await load(
      lowHealthBattleHtml({ enemies: ['Duck', 'Goblin'], use: 'stay_low' }),
    );
    try {
      const { result, logs } = await captureLogs(() => configureAndBattle(page, 0, 1, 'Offensive'));
      assert.equal(result, 'health_too_low');
      assert.equal(await page.locator('body').getAttribute('data-opened'), 'Duck');
      assert.equal(await page.locator('body').getAttribute('data-battled'), null);
      const order = await page.locator('body').getAttribute('data-order');
      assert.equal(order?.match(/use/g)?.length, 3);
      assert.ok(logs.some((line) => line.includes('health_too_low after heal retries')));
      assert.ok(logs.some((line) => line.includes('not walking other enemy tiles')));
      assert.equal(takeCookedCodSpentOnHeal(), 99 * 3);
      assert.equal(logs.some((line) => line.includes('Goblin')), false);
    } finally {
      if (prev === undefined) delete process.env.COMBAT_BATTLE_ENABLE_MS;
      else process.env.COMBAT_BATTLE_ENABLE_MS = prev;
      await page.close();
    }
  });

  it('returns heal_failed when the Heal control is missing', async () => {
    const prev = process.env.COMBAT_BATTLE_ENABLE_MS;
    process.env.COMBAT_BATTLE_ENABLE_MS = '700';
    const page = await load(
      lowHealthBattleHtml({
        enemies: ['Duck', 'Goblin'],
        use: 'stay_low',
        healButton: false,
      }),
    );
    try {
      const { result, logs } = await captureLogs(() => configureAndBattle(page, 0, 1, 'Offensive'));
      assert.equal(result, 'heal_failed');
      assert.equal(await page.locator('body').getAttribute('data-opened'), 'Duck');
      assert.equal(logs.some((line) => line.includes('Heal control missing')), true);
      assert.equal(logs.some((line) => line.includes('selected_battle_entity')), false);
      assert.equal(logs.some((line) => /token|api[_-]?key/i.test(line)), false);
    } finally {
      if (prev === undefined) delete process.env.COMBAT_BATTLE_ENABLE_MS;
      else process.env.COMBAT_BATTLE_ENABLE_MS = prev;
      await page.close();
    }
  });
});

describe('Stop Hunting confirm', () => {
  it('clicks the dialog Stop button and not Close', async () => {
    const page = await load(STOP_HUNTING_DIALOG);
    try {
      const result = await stopHunt(page);
      assert.equal(result, 'hunt_stopped');
      assert.equal(await page.locator('body').getAttribute('data-stopped'), '1');
      assert.equal(await page.locator('body').getAttribute('data-closed'), null);
    } finally {
      await page.close();
    }
  });

  it('confirms Stop after the panel control opens the dialog', async () => {
    const page = await load(STOP_OPENS_CONFIRM);
    try {
      const result = await stopHunt(page);
      assert.equal(result, 'hunt_stopped');
      assert.equal(await page.locator('body').getAttribute('data-stopped'), '1');
      assert.equal(await page.locator('body').getAttribute('data-closed'), null);
    } finally {
      await page.close();
    }
  });
});
