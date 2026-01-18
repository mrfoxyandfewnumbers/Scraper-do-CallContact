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
        
        console.log('Otwieram stronę logowania...');
        await page.goto('https://callcontact.pl/panel/user/login', { 
            waitUntil: 'networkidle2',
            timeout: 30000 
        });
        
        // Czekamy na formularz logowania
        await page.waitForSelector('input[name="email"]', { timeout: 10000 });
        
        console.log('Wpisuję dane logowania...');
        await page.type('input[name="email"]', email, { delay: 50 });
        await page.type('input[name="password"]', password, { delay: 50 });
        
        // Klikamy przycisk logowania
        await page.click('button[type="submit"]');
        
        // Czekamy na stronę 2FA lub przekierowanie
        console.log('Czekam na stronę weryfikacji 2FA...');
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
        
        // Sprawdzamy czy jesteśmy na stronie 2FA
        const currentUrl = page.url();
        console.log('Obecny URL:', currentUrl);
        
        if (currentUrl.includes('2fa') || currentUrl.includes('verify')) {
            console.log('Wpisuję kod 2FA:', totpCode);
            
            // Szukamy pola na kod 2FA (może mieć różne nazwy)
            const totpInput = await page.$('input[name="totp"]') || 
                             await page.$('input[name="code"]') || 
                             await page.$('input[name="2fa"]') ||
                             await page.$('input[type="text"]');
            
            if (totpInput) {
                await totpInput.type(totpCode, { delay: 50 });
                
                // Klikamy przycisk weryfikacji
                const submitBtn = await page.$('button[type="submit"]') || 
                                  await page.$('input[type="submit"]');
                if (submitBtn) {
                    await submitBtn.click();
                }
                
                // Czekamy na przekierowanie po 2FA
                await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
            }
        }
        
        // Sprawdzamy czy logowanie się powiodło
        const afterLoginUrl = page.url();
        console.log('URL po logowaniu:', afterLoginUrl);
        
        // Pobieramy ciasteczka (w tym to ważne known_device)
        const cookies = await page.cookies();
        console.log('Pobrano ciasteczka:', cookies.map(c => c.name).join(', '));
        
        // Sprawdzamy czy mamy dostęp do panelu
        if (afterLoginUrl.includes('login') || afterLoginUrl.includes('2fa')) {
            // Robimy screenshot żeby zobaczyć co poszło nie tak
            const screenshot = await page.screenshot({ encoding: 'base64' });
            return {
                success: false,
                error: 'Logowanie nie powiodło się - nadal na stronie logowania',
                currentUrl: afterLoginUrl,
                screenshot: screenshot
            };
        }
        
        // SUKCES - jesteśmy zalogowani!
        console.log('Logowanie udane! Pobieram nagrania...');
        
        // Teraz przechodzimy do API po nagrania
        // Obliczamy zakres dat
        const now = new Date();
        const since = new Date(now.getTime() - (sinceMinutes * 60 * 1000));
        
        const dateFrom = since.toISOString().split('T')[0];
        const dateTo = now.toISOString().split('T')[0];
        
        console.log(`Pobieram nagrania od ${dateFrom} do ${dateTo}...`);
        
        // Przechodzimy do strony z nagraniami
        const recordingsUrl = `https://callcontact.pl/panel/calls?dateFrom=${dateFrom}&dateTo=${dateTo}`;
        await page.goto(recordingsUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        
        // Próbujemy pobrać dane z API
        const apiResponse = await page.evaluate(async () => {
            try {
                const response = await fetch('/panel/api/calls/list', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Requested-With': 'XMLHttpRequest'
                    },
                    body: JSON.stringify({
                        page: 1,
                        limit: 100
                    })
                });
                return await response.json();
            } catch (e) {
                return { error: e.message };
            }
        });
        
        return {
            success: true,
            message: 'Zalogowano pomyślnie',
            currentUrl: afterLoginUrl,
            cookies: cookies.map(c => ({ name: c.name, value: c.value })),
            recordings: apiResponse
        };
        
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
        timestamp: new Date().toISOString()
    });
});

// Endpoint główny - informacja
app.get('/', (req, res) => {
    res.json({
        name: 'CallContact Scraper',
        version: '1.0.0',
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
    console.log(`CallContact Scraper działa na porcie ${PORT}`);
});
