const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
app.use(express.json());

// Funkcja główna - logowanie do CallContact
async function loginAndGetRecordings(email, password, totpCode, sinceMinutes = 15) {
    let browser = null;
    
    try {
        console.log('Uruchamiam przeglądarkę...');
        
        browser = await puppeteer.launch({
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
        });
        
        const page = await browser.newPage();
        
        // Ustawiamy user-agent żeby wyglądać jak normalna przeglądarka
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // KROK 1: Otwórz stronę główną
        console.log('Otwieram stronę główną user.callcontact.eu...');
        await page.goto('https://user.callcontact.eu/', { 
            waitUntil: 'networkidle2',
            timeout: 30000 
        });
        
        // KROK 2: Kliknij przycisk "ZALOGUJ SIĘ"
        console.log('Szukam przycisku ZALOGUJ SIĘ...');
        await page.waitForSelector('button, a', { timeout: 10000 });
        
        // Szukamy przycisku z tekstem "ZALOGUJ SIĘ"
        const loginButton = await page.evaluateHandle(() => {
            const elements = [...document.querySelectorAll('button, a')];
            return elements.find(el => el.textContent.includes('ZALOGUJ SIĘ'));
        });
        
        if (loginButton) {
            console.log('Klikam przycisk ZALOGUJ SIĘ...');
            await loginButton.click();
        } else {
            throw new Error('Nie znaleziono przycisku ZALOGUJ SIĘ na stronie głównej');
        }
        
        // KROK 3: Czekamy na formularz logowania
        console.log('Czekam na formularz logowania...');
        await page.waitForSelector('input[placeholder="Adres email"]', { timeout: 15000 });
        
        // KROK 4: Wpisujemy email
        console.log('Wpisuję email...');
        await page.type('input[placeholder="Adres email"]', email, { delay: 50 });
        
        // KROK 5: Wpisujemy hasło (placeholder zawiera "8 znaków")
        console.log('Wpisuję hasło...');
        const passwordInput = await page.$('input[placeholder*="8 znaków"]');
        if (passwordInput) {
            await passwordInput.type(password, { delay: 50 });
        } else {
            // Alternatywnie - drugie pole input typu password
            const passField = await page.$('input[type="password"]');
            if (passField) {
                await passField.type(password, { delay: 50 });
            } else {
                throw new Error('Nie znaleziono pola hasła');
            }
        }
        
        // KROK 6: Klikamy ZALOGUJ SIĘ
        console.log('Klikam ZALOGUJ SIĘ (logowanie)...');
        const submitButton = await page.evaluateHandle(() => {
            const buttons = [...document.querySelectorAll('button')];
            return buttons.find(b => b.textContent.includes('ZALOGUJ SIĘ'));
        });
        
        if (submitButton) {
            await submitButton.click();
        } else {
            throw new Error('Nie znaleziono przycisku ZALOGUJ SIĘ');
        }
        
        // KROK 7: Czekamy na stronę 2FA
        console.log('Czekam na pola 2FA...');
        await page.waitForSelector('input.digit', { timeout: 15000 });
        
        // KROK 8: Wpisujemy kod 2FA (6 cyfr w 6 polach)
        console.log('Wpisuję kod 2FA:', totpCode);
        const digitInputs = await page.$$('input.digit');
        
        if (digitInputs.length !== 6) {
            throw new Error(`Oczekiwano 6 pól na kod 2FA, znaleziono: ${digitInputs.length}`);
        }
        
        // Wpisujemy każdą cyfrę osobno
        for (let i = 0; i < 6; i++) {
            await digitInputs[i].type(totpCode[i], { delay: 30 });
        }
        
        // KROK 9: Klikamy ZALOGUJ SIĘ (2FA)
        console.log('Klikam ZALOGUJ SIĘ (2FA)...');
        const submit2faButton = await page.evaluateHandle(() => {
            const buttons = [...document.querySelectorAll('button')];
            return buttons.find(b => b.textContent.includes('ZALOGUJ SIĘ'));
        });
        
        if (submit2faButton) {
            await submit2faButton.click();
        }
        
        // KROK 10: Czekamy na przekierowanie do panelu
        console.log('Czekam na przekierowanie do panelu...');
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
        
        const currentUrl = page.url();
        console.log('Obecny URL:', currentUrl);
        
        // Sprawdzamy czy jesteśmy zalogowani
        if (currentUrl.includes('connections') || currentUrl.includes('user.callcontact.eu')) {
            console.log('Zalogowano pomyślnie!');
            
            // Pobieramy ciasteczka
            const cookies = await page.cookies();
            console.log('Pobrano ciasteczka:', cookies.map(c => c.name).join(', '));
            
            // KROK 11: Pobieramy nagrania
            console.log('Pobieram listę nagrań...');
            
            // Ustawiamy zakres dat
            const now = new Date();
            const since = new Date(now.getTime() - (sinceMinutes * 60 * 1000));
            
            // Czekamy chwilę na załadowanie strony
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            // Pobieramy dane ze strony lub przez API
            const pageContent = await page.content();
            
            return {
                success: true,
                message: 'Zalogowano pomyślnie do CallContact',
                currentUrl: currentUrl,
                cookies: cookies.map(c => ({ name: c.name, value: c.value, domain: c.domain })),
                note: 'Scraper zalogowany - gotowy do pobierania nagrań'
            };
            
        } else {
            // Coś poszło nie tak - robimy screenshot
            const screenshot = await page.screenshot({ encoding: 'base64' });
            return {
                success: false,
                error: 'Nie udało się zalogować - nieoczekiwany URL po logowaniu',
                currentUrl: currentUrl,
                screenshot: screenshot
            };
        }
        
    } catch (error) {
        console.error('Błąd:', error.message);
        return {
            success: false,
            error: error.message
        };
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

// Endpoint główny - logowanie i pobieranie nagrań
app.post('/login', async (req, res) => {
    const { email, password, totp_code, since_minutes = 15 } = req.body;
    
    if (!email || !password || !totp_code) {
        return res.status(400).json({
            success: false,
            error: 'Brakuje wymaganych danych: email, password, totp_code'
        });
    }
    
    console.log(`\n=== Nowe żądanie logowania dla: ${email} ===`);
    
    const result = await loginAndGetRecordings(email, password, totp_code, since_minutes);
    res.json(result);
});

// Endpoint testowy - sprawdza czy serwis działa
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        message: 'CallContact Scraper działa',
        version: '2.0.0',
        timestamp: new Date().toISOString()
    });
});

// Endpoint główny - informacja
app.get('/', (req, res) => {
    res.json({
        name: 'CallContact Scraper',
        version: '2.0.0',
        endpoints: {
            'POST /login': 'Logowanie i pobieranie nagrań',
            'GET /health': 'Sprawdzenie czy serwis działa'
        },
        required_params: {
            email: 'Adres email do logowania',
            password: 'Hasło',
            totp_code: 'Kod 2FA (6 cyfr)',
            since_minutes: 'Opcjonalnie - nagrania z ostatnich X minut (domyślnie 15)'
        }
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`CallContact Scraper v2.0 działa na porcie ${PORT}`);
});
