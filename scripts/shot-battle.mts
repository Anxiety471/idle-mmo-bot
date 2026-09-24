/**
 * One-shot: headed screenshot after clicking Battle (Lv. 2) into hunting UI.
 * IdleBocchi only. No membership spend. No secrets printed.
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL?.trim() || 'https://web.idle-mmo.com';
const STORAGE = process.env.STORAGE_STATE?.trim() || './storage-state.json';
const OUT = process.env.SHOT_OUT?.trim() || '/workspace/screenshots/bocchi-battle-clicked.png';
const CHARACTER = process.env.CHARACTER_NAME?.trim() || 'IdleBocchi';

function log(msg: string) {
  console.log(`[shot-battle] ${msg}`);
}

async function main() {
  mkdirSync(dirname(OUT), { recursive: true });

  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-dev-shm-usage'],
  });

  const context = await browser.newContext({
    storageState: resolve(STORAGE),
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  let confirmed = false;
  let finalUrl = '';
  let uiDesc = '';

  try {
    log(`goto ${BASE}/battle`);
    await page.goto(`${BASE}/battle`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(2500);

    const urlNow = page.url();
    if (/\/login|sign.?in|\/auth/i.test(urlNow)) {
      log(`LOGIN FAILED — redirected to ${urlNow}`);
      await page.screenshot({ path: OUT, fullPage: true });
      throw new Error(`login_failed:${urlNow}`);
    }

    let body = await page.locator('body').innerText().catch(() => '');
    confirmed = body.includes(CHARACTER);
    if (!confirmed) {
      const nameLoc = page.getByText(CHARACTER, { exact: false }).first();
      if ((await nameLoc.count()) > 0) {
        confirmed = await nameLoc.isVisible().catch(() => false);
      }
    }
    log(`IdleBocchi confirmed: ${confirmed}`);
    log(`hub url: ${page.url()}`);

    // Sidebar Combat entry: "Battle (Lv. 2)" / "Battle Lv. 2" — NOT Slayer/Dungeons/World Bosses
    const battleNav = page
      .getByRole('link', { name: /Battle\s*\(?\s*Lv\.?\s*2\s*\)?/i })
      .or(page.getByRole('button', { name: /Battle\s*\(?\s*Lv\.?\s*2\s*\)?/i }))
      .or(page.locator('a, button').filter({ hasText: /^Battle\s*\(?\s*Lv\.?\s*2\s*\)?$/i }))
      .or(page.getByText(/^Battle\s*\(?\s*Lv\.?\s*2\s*\)?$/i));

    let clicked = false;
    const n = await battleNav.count().catch(() => 0);
    log(`battle nav candidates: ${n}`);
    for (let i = 0; i < Math.min(n, 8); i++) {
      const el = battleNav.nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      const txt = ((await el.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
      if (/Slayer|Dungeon|World\s*Boss/i.test(txt)) continue;
      if (!/Battle/i.test(txt) || !/Lv\.?\s*2|Level\s*2/i.test(txt)) continue;
      // Prefer compact nav label
      if (txt.length > 40) continue;
      log(`clicking nav: "${txt}"`);
      await el.click({ timeout: 10_000 });
      clicked = true;
      break;
    }

    if (!clicked) {
      // Direct href fallback
      const hrefBattle = page.locator('a[href="/combat/battle"], a[href*="/combat/battle"]').first();
      if ((await hrefBattle.count()) > 0 && (await hrefBattle.isVisible().catch(() => false))) {
        const txt = ((await hrefBattle.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
        log(`clicking href /combat/battle: "${txt.slice(0, 60)}"`);
        await hrefBattle.click({ timeout: 10_000 });
        clicked = true;
      }
    }

    if (!clicked) {
      const labels = await page.evaluate(() => {
        const nodes = Array.from(document.querySelectorAll('a, button, nav *'));
        return nodes
          .map((n) => (n.textContent || '').replace(/\s+/g, ' ').trim())
          .filter((t) => t.length > 0 && t.length < 40 && /Battle|Slayer|Dungeon|World/i.test(t))
          .filter((t, i, a) => a.indexOf(t) === i)
          .slice(0, 30);
      });
      log(`no Battle Lv.2 nav; labels=${JSON.stringify(labels)}`);
      log('fallback: goto /combat/battle');
      await page.goto(`${BASE}/combat/battle`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    }

    await page.waitForTimeout(2000);

    const huntReady = page
      .getByRole('button', { name: 'Start Hunt', exact: true })
      .or(page.getByRole('button', { name: 'Hunt More', exact: true }))
      .or(page.getByText(/ENEMIES\s+NEARBY/i))
      .or(page.getByText(/^Hunting$/i))
      .or(page.getByText(/Total Enemies Found/i))
      .or(page.getByRole('button', { name: 'Stop', exact: true }))
      .or(page.getByRole('button', { name: 'Cancel Hunt', exact: true }));

    try {
      await huntReady.first().waitFor({ state: 'visible', timeout: 25_000 });
      log('hunting UI visible');
    } catch {
      log('hunting UI wait timed out — screenshotting anyway');
    }

    await page.waitForTimeout(1000);
    finalUrl = page.url();
    body = await page.locator('body').innerText().catch(() => '');
    if (!confirmed && body.includes(CHARACTER)) confirmed = true;

    const markers: string[] = [];
    for (const m of [
      'Start Hunt',
      'Hunt More',
      'ENEMIES NEARBY',
      'Hunting',
      'Total Enemies Found',
      'Stop',
      'Cancel Hunt',
      'Power Hunt',
    ]) {
      if (new RegExp(m.replace(/\s+/g, '\\s+'), 'i').test(body)) markers.push(m);
    }
    uiDesc = markers.length ? `hunting markers: ${markers.join(', ')}` : 'no hunt markers detected';

    await page.screenshot({ path: OUT, fullPage: true });
    log(`screenshot → ${OUT}`);
    log(`finalUrl=${finalUrl}`);
    log(`ui=${uiDesc}`);
    log(`confirmed=${confirmed}`);

    await page.waitForTimeout(20_000);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  console.log(
    JSON.stringify({
      ok: true,
      screenshot: OUT,
      confirmed,
      finalUrl,
      uiDesc,
    }),
  );
}

main().catch((err) => {
  console.error(`[shot-battle] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  console.log(
    JSON.stringify({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      screenshot: OUT,
    }),
  );
  process.exitCode = 1;
});
