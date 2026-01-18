/**
 * CallContact — browser login + 2FA + fetch connections (getList)
 * Wymaga: puppeteer
 *
 * ENV:
 *  CALLCONTACT_EMAIL
 *  CALLCONTACT_PASSWORD
 *  CALLCONTACT_TOTP          (kod 2FA z n8n albo generowany gdziekolwiek)
 *  DATE_FROM (YYYY-MM-DD)    (opcjonalnie)
 *  DATE_TO   (YYYY-MM-DD)    (opcjonalnie)
 *  PAGE      (opcjonalnie)
 *  PAGE_SIZE (opcjonalnie)
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const EMAIL = process.env.CALLCONTACT_EMAIL;
const PASSWORD = process.env.CALLCONTACT_PASSWORD;
const TOTP = process.env.CALLCONTACT_TOTP;

if (!EMAIL || !PASSWORD) {
  console.error('Brak ENV: CALLCONTACT_EMAIL lub CALLCONTACT_PASSWORD');
  process.exit(1);
}

const todayISO = () => new Date().toISOString().slice(0, 10);

const DATE_FROM = process.env.DATE_FROM || todayISO();
const DATE_TO = process.env.DATE_TO || todayISO();
const PAGE = Number(process.env.PAGE || 1);
const PAGE_SIZE = Number(process.env.PAGE_SIZE || 100);

const BASE = 'https://user.callcontact.eu';
const START_URL = `${BASE}/connections`;

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`${ts} ${msg}`);
}

async function safeScreenshot(page, name) {
  try {
    const dir = path.join(process.cwd(), 'debug');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}_${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    log(`Zapisano screenshot: ${file}`);
  } catch (e) {
    log(`Nie udało się zrobić screenshot: ${e?.message || e}`);
  }
}

async function clickAndWaitFor(page, clickSelector, waitSelector, timeout = 30000) {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) el.scrollIntoView({ block: 'center' });
  }, clickSelector);

  await Promise.all([
    page.waitForSelector(waitSelector, { timeout }),
    page.click(clickSelector),
  ]);
}

async function main() {
  log(`=== Start: logowanie i pobranie connections dla: ${EMAIL} ===`);

  const browser = await puppeteer.launch({
    headless: 'new', // Puppeteer >= 20
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1280,900',
    ],
  });

  const page = await browser.newPage();

  // Ustawienia “browser-like”
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  );
  await page.setViewport({ width: 1280, height: 900 });
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.8',
  });

  page.setDefaultTimeout(30000);

  try {
    log(`Otwieram: ${START_URL}`);
    await page.goto(START_URL, { waitUntil: 'domcontentloaded' });

    // Czasem SPA doczytuje zasoby — mała chwila pomaga stabilności
    await page.waitForTimeout(800);

    // 1) Kliknij "Zaloguj się" (na stronie głównej SPA)
    // Ten selector brałeś z UI — zostawiamy, ale czekanie robimy na pole email (odporne)
    const loginBtnSel = 'button.LoginRegisterView__column__button';

    // Pole email — odporne na język / placeholder
    const emailSel =
      'input[type="email"], input[autocomplete="username"], input[placeholder*="email" i]';

    log('Szukam przycisku "Zaloguj się"...');
    await page.waitForSelector(loginBtnSel, { timeout: 30000 });

    log('Klikam "Zaloguj się" i czekam aż pojawi się formularz...');
    await clickAndWaitFor(page, loginBtnSel, emailSel, 30000);

    log('Formularz logowania widoczny. Wpisuję email...');
    await page.click(emailSel);
    await page.keyboard.type(EMAIL, { delay: 35 });

    // 2) Hasło
    const passSel =
      'input[type="password"], input[autocomplete="current-password"], input[placeholder*="hasło" i], input[placeholder*="password" i]';

    log('Czekam na pole hasła...');
    await page.waitForSelector(passSel, { timeout: 30000 });
    await page.click(passSel);
    await page.keyboard.type(PASSWORD, { delay: 35 });

    // 3) Submit logowania (różne UI → kilka możliwych selectorów)
    const submitSelCandidates = [
      'button[type="submit"]',
      'button:has-text("Zaloguj")', // (Playwright-style — w Puppeteer nie działa)
      'button.LoginView__column__button',
      'button[class*="Login"]',
    ];

    // W Puppeteer nie ma :has-text, więc używamy bezpiecznego: najpierw button[type=submit], potem fallback
    log('Wysyłam formularz logowania...');
    const hasSubmit = await page.$('button[type="submit"]');
    if (hasSubmit) {
      await page.click('button[type="submit"]');
    } else {
      // Fallback: kliknij pierwszy widoczny button w formie
      await page.evaluate(() => {
        const btn =
          document.querySelector('form button') ||
          document.querySelector('button[type="button"]') ||
          document.querySelector('button');
        if (btn) btn.click();
      });
    }

    // 4) 2FA (TOTP) — czekamy na input one-time-code LUB na pojawienie się widoku /connections
    // Najczęstsze selektory: autocomplete="one-time-code", inputmode="numeric", name/code itp.
    const otpSel =
      'input[autocomplete="one-time-code"], input[inputmode="numeric"], input[placeholder*="kod" i], input[name*="code" i]';

    log('Sprawdzam czy pojawia się pole 2FA...');
    const otpAppeared = await page
      .waitForSelector(otpSel, { timeout: 12000 })
      .then(() => true)
      .catch(() => false);

    if (otpAppeared) {
      if (!TOTP) {
        throw new Error('Pojawiło się 2FA, ale brak ENV CALLCONTACT_TOTP');
      }

      log('Pole 2FA wykryte. Wpisuję kod TOTP...');
      await page.click(otpSel);
      await page.keyboard.type(String(TOTP).trim(), { delay: 35 });

      // Zatwierdź 2FA — znów różne UI
      log('Zatwierdzam 2FA...');
      const has2faSubmit = await page.$('button[type="submit"]');
      if (has2faSubmit) {
        await page.click('button[type="submit"]');
      } else {
        await page.keyboard.press('Enter');
      }
    } else {
      log('Nie wykryto pola 2FA (możliwe, że sesja już zaufana).');
    }

    // 5) Czekamy aż jesteśmy zalogowani: /connections + działa fetch API
    log('Czekam aż aplikacja będzie po logowaniu...');
    await page.waitForFunction(
      () => location.host.includes('user.callcontact.eu'),
      { timeout: 30000 }
    );

    // Mały bufor na ustawienie cookies typu known_device
    await page.waitForTimeout(1200);

    // 6) Pobranie getList przez fetch z przeglądarki (ważne: cookies same się dołączą)
    const url = `${BASE}/api/connections/getList?filtering_criteria[date_from]=${encodeURIComponent(
      DATE_FROM
    )}&filtering_criteria[date_to]=${encodeURIComponent(
      DATE_TO
    )}&page=${PAGE}&page_size=${PAGE_SIZE}&sorting_direction=2`;

    log(`Pobieram API getList: ${url}`);

    const result = await page.evaluate(async (apiUrl) => {
      const res = await fetch(apiUrl, {
        method: 'GET',
        credentials: 'include',
        headers: {
          accept: 'application/json, text/plain, */*',
          'x-requested-with': 'XMLHttpRequest',
        },
      });

      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch (e) {
        // nie JSON → zwróć tekst
      }

      return {
        status: res.status,
        ok: res.ok,
        text,
        json,
      };
    }, url);

    if (!result.ok) {
      log(`API getList nie OK. Status: ${result.status}`);
      await safeScreenshot(page, `getList_status_${result.status}`);
      // Wypisz minimalnie co dostał serwer
      console.log(
        JSON.stringify(
          { error: true, stage: 'getList', status: result.status, body: result.json || result.text },
          null,
          2
        )
      );
      await browser.close();
      process.exit(2);
    }

    log('SUKCES: getList OK. Wypisuję JSON na stdout...');
    console.log(JSON.stringify(result.json ?? result.text, null, 2));

    await browser.close();
    process.exit(0);
  } catch (err) {
    log(`BŁĄD: ${err?.message || err}`);
    await safeScreenshot(page, 'error');
    // Dodatkowo: HTML strony na debug (czasem pomaga zobaczyć czy inny layout/język)
    try {
      const dir = path.join(process.cwd(), 'debug');
      fs.mkdirSync(dir, { recursive: true });
      const html = await page.content();
      const file = path.join(dir, `${Date.now()}_page.html`);
      fs.writeFileSync(file, html, 'utf8');
      log(`Zapisano HTML: ${file}`);
    } catch (e) {}

    await browser.close();
    process.exit(1);
  }
}

main();
