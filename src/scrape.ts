import {chromium} from 'playwright';
import {Response} from "playwright";

const TARGET_URL = 'https://us-store.msi.com/Motherboards/Intel-Platform-Motherboard/INTEL-Z890/MAG-Z890-TOMAHAWK-WIFI';

type Nullable<T> = T | null;

const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
});

const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/115 Safari/537.36',
    viewport: {width: 1536, height: 864},
});
const page = await context.newPage();

let response: Nullable<Response> = null
try {
    response = await page.goto(TARGET_URL, {waitUntil: 'networkidle'});
} catch {
    response = await page.goto(TARGET_URL, {waitUntil: 'domcontentloaded'});
}

await page.waitForTimeout(3000);

console.log('title:', await page.title());
console.log('status:', response?.status());

await browser.close();