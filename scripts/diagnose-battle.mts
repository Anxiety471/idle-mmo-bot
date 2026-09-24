/**
 * Headed diagnostic: IdleBocchi /combat/battle
 * Logs tiles/modal/Battle/STANCE, clicks Rabbit tile, clicks entity-modal Battle,
 * waits up to 15s for Run Away, screenshots.
 * No secrets. No membership spend.
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, type Page } from 'playwright';

const BASE = process.env.BASE_URL?.trim() || 'https://web.idle-mmo.com';
const STORAGE = process.env.STORAGE_STATE?.trim() || './storage-state.json';
const OUT =
  process.env.SHOT_OUT?.trim() || '/workspace/screenshots/bocchi-diagnose-battle.png';
const CHARACTER = process.env.CHARACTER_NAME?.trim() || 'IdleBocchi';
const MODAL = '[x-data*="show-battle-entity"]';

function log(msg: string) {
  console.log(`[diagnose-battle] ${msg}`);
}

async function logState(page: Page, label: string): Promise<void> {
  const enemiesNearby = await page
    .getByText(/ENEMIES NEARBY/i)
    .first()
    .isVisible()
    .catch(() => false);

  const heading = page.getByText(/ENEMIES NEARBY/i).first();
  const root = heading
    .locator('xpath=ancestor::*[self::div or self::section][position()<=4]')
    .first();
  const imgs = root.locator('img');
  const imgN = await imgs.count().catch(() => 0);
  const tileLines: string[] = [];
  for (let i = 0; i < Math.min(imgN, 12); i++) {
    const img = imgs.nth(i);
    if (!(await img.isVisible().catch(() => false))) continue;
    const alt = (await img.getAttribute('alt').catch(() => '')) || '';
    const src = ((await img.getAttribute('src').catch(() => '')) || '').slice(-80);
    const parentText = await img
      .locator('xpath=ancestor::*[@role="button" or self::button][1]')
      .innerText()
      .catch(() => '');
    tileLines.push(
      `img#${i} alt="${alt}" parent="${(parentText || '').replace(/\s+/g, ' ').trim().slice(0, 40)}" src=...${src}`,
    );
  }

  const modal = page.locator(MODAL);
  const modalVisible =
    (await modal.count()) > 0 && (await modal.first().isVisible().catch(() => false));
  const stance = await page.getByText(/^STANCE$/i).first().isVisible().catch(() => false);

  const battleBtns = page.getByRole('button', { name: 'Battle', exact: true });
  const battleCount = await battleBtns.count();
  let visibleBattle = 0;
  const battleLines: string[] = [];
  for (let i = 0; i < Math.min(battleCount, 8); i++) {
    const btn = battleBtns.nth(i);
    const vis = await btn.isVisible().catch(() => false);
    if (vis) visibleBattle += 1;
    const inModal = await btn
      .evaluate((node) => Boolean(node.closest('[x-data*="show-battle-entity"]')))
      .catch(() => false);
    const nearby = await btn
      .evaluate((node) => {
        const scope =
          (node.closest('[x-data*="show-battle-entity"], [role="dialog"]') as HTMLElement | null) ||
          node.parentElement;
        return (scope?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      })
      .catch(() => '');
    battleLines.push(`Battle#${i} visible=${vis} inModal=${inModal} nearby="${nearby}"`);
  }

  const detailOpen = modalVisible || (stance && visibleBattle > 0);
  const runAway = await page
    .getByRole('button', { name: 'Run Away', exact: true })
    .first()
    .isVisible()
    .catch(() => false);

  log(`=== ${label} ===`);
  log(`url=${page.url()}`);
  log(`ENEMIES NEARBY visible=${enemiesNearby}`);
  log(`enemy tiles (${tileLines.length}):`);
  for (const t of tileLines) log(`  ${t}`);
  log(`isEnemyDetailPanelOpen=${detailOpen}`);
  log(`show-battle-entity modal visible=${modalVisible}`);
  log(`STANCE visible=${stance}`);
  log(`visible Battle buttons: count=${visibleBattle} (total=${battleCount})`);
  for (const l of battleLines) log(`  ${l}`);
  log(`Run Away visible=${runAway}`);
}

async function clickRabbitTile(page: Page): Promise<boolean> {
  const modal = page.locator(MODAL);
  if ((await modal.count()) > 0 && (await modal.first().isVisible().catch(() => false))) {
    log('modal already open — skip tile click');
    return true;
  }

  const heading = page.getByText(/ENEMIES NEARBY/i).first();
  const root = heading
    .locator('xpath=ancestor::*[self::div or self::section][position()<=4]')
    .first();
  const imgs = root.locator('img');
  const n = await imgs.count();
  log(`nearby root imgs=${n}`);

  for (let i = 0; i < n; i++) {
    const img = imgs.nth(i);
    if (!(await img.isVisible().catch(() => false))) continue;
    const alt = (await img.getAttribute('alt').catch(() => '')) || '';
    const src = (await img.getAttribute('src').catch(() => '')) || '';
    if (!/rabbit/i.test(alt) && !/rabbit/i.test(src)) continue;
    log(`click Rabbit img#${i} alt=${alt}`);
    const tile = img.locator('xpath=ancestor::*[@role="button" or self::button][1]');
    if ((await tile.count()) > 0) {
      await tile
        .first()
        .click({ timeout: 5000 })
        .catch(async () => {
          await img.click({ force: true, timeout: 5000 });
        });
    } else {
      await img.click({ timeout: 5000 }).catch(async () => {
        await img.click({ force: true, timeout: 5000 });
      });
    }
    await page.waitForTimeout(1500);
    return true;
  }

  const buttons = root.getByRole('button');
  const bn = await buttons.count();
  for (let i = 0; i < bn; i++) {
    const b = buttons.nth(i);
    if (!(await b.isVisible().catch(() => false))) continue;
    const t = ((await b.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    if (!/^\d+$/.test(t) && !/rabbit/i.test(t)) continue;
    log(`click nearby button text="${t}"`);
    await b.click({ timeout: 5000 });
    await page.waitForTimeout(1500);
    return true;
  }

  for (let i = 0; i < n; i++) {
    const img = imgs.nth(i);
    if (!(await img.isVisible().catch(() => false))) continue;
    const alt = (await img.getAttribute('alt').catch(() => '')) || '';
    if (/IdleMMO|logo|avatar|portrait/i.test(alt)) continue;
    log(`click fallback nearby img#${i} alt=${alt}`);
    await img.click({ timeout: 5000 }).catch(async () => {
      await img.click({ force: true, timeout: 5000 });
    });
    await page.waitForTimeout(1500);
    return true;
  }

  log('NO rabbit/count tile found');
  return false;
}

async function clickModalBattle(page: Page): Promise<boolean> {
  await page
    .locator(MODAL)
    .getByRole('button', { name: 'Battle', exact: true })
    .first()
    .waitFor({ state: 'visible', timeout: 8_000 })
    .catch(() => undefined);

  const modalBattle = page
    .locator(MODAL)
    .getByRole('button', { name: 'Battle', exact: true })
    .first();
  if ((await modalBattle.count()) > 0 && (await modalBattle.isVisible().catch(() => false))) {
    log('click Battle inside show-battle-entity modal (NOT sidebar)');
    await modalBattle.scrollIntoViewIfNeeded().catch(() => undefined);
    await modalBattle.click({ timeout: 5000 });
    return true;
  }

  const btns = page.getByRole('button', { name: 'Battle', exact: true });
  const n = await btns.count();
  for (let i = 0; i < n; i++) {
    const btn = btns.nth(i);
    if (!(await btn.isVisible().catch(() => false))) continue;
    const nearby = await btn
      .evaluate((node) => {
        const scope = node.closest('[x-data], [role="dialog"], form, section') as HTMLElement | null;
        return (scope?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 100);
      })
      .catch(() => '');
    if (/STANCE|Combat EXP|FOOD/i.test(nearby)) {
      log(`click Battle#${i} with combat panel cues`);
      await btn.click({ timeout: 5000 });
      return true;
    }
  }
  log('NO combat Battle button found');
  return false;
}

async function main() {
  mkdirSync(dirname(OUT), { recursive: true });
  log(`DISPLAY=${process.env.DISPLAY ?? '(unset)'} HEADLESS=${process.env.HEADLESS ?? '(unset)'}`);
  log(`storage=${STORAGE} character=${CHARACTER} out=${OUT}`);

  const browser = await chromium.launch({
    headless: process.env.HEADLESS === 'true',
    args: ['--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({
    storageState: resolve(STORAGE),
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  try {
    const url = `${BASE}/combat/battle`;
    log(`goto ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(3000);

    if (/\/login|sign.?in|\/auth/i.test(page.url())) {
      await page.screenshot({ path: OUT, fullPage: true });
      throw new Error(`login_failed:${page.url()}`);
    }

    const body = await page.locator('body').innerText().catch(() => '');
    log(`${CHARACTER} confirmed: ${body.includes(CHARACTER)}`);

    await logState(page, 'initial');

    const tileOk = await clickRabbitTile(page);
    log(`tile click ok=${tileOk}`);
    await page.waitForTimeout(1500);
    await logState(page, 'after Rabbit tile click');

    const battleOk = await clickModalBattle(page);
    log(`combat Battle click ok=${battleOk}`);

    let runAway = false;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      runAway = await page
        .getByRole('button', { name: 'Run Away', exact: true })
        .first()
        .isVisible()
        .catch(() => false);
      if (runAway) break;
      await page.waitForTimeout(500);
    }

    await logState(page, 'after Battle + wait');
    await page.screenshot({ path: OUT, fullPage: true });
    log(`screenshot=${OUT}`);
    log(`FINAL: Run Away appeared=${runAway}`);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error('[diagnose-battle] FATAL', err instanceof Error ? err.message : err);
  process.exit(1);
});
