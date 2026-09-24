import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import {
  configureAndBattle,
  huntMore,
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
});

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
