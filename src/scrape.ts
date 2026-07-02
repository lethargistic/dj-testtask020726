import {chromium, Page} from 'playwright';
import {mkdirSync, writeFileSync} from 'node:fs';
import {Temporal} from "@js-temporal/polyfill";

const OUTPUT_PATH = 'output/product.json';
const TARGET_URL = 'https://us-store.msi.com/Motherboards/Intel-Platform-Motherboard/INTEL-Z890/MAG-Z890-TOMAHAWK-WIFI';

type Nullable<T> = T | null;
type CategoryTreeEntry = { name: string; url: Nullable<string> };

type SpecEntry = { name: string; value: Nullable<string> };
type ProductData = {
    url: string;
    item_id: Nullable<string>;
    title: Nullable<string>;
    brand: Nullable<string>;
    product_category: Nullable<string>;
    category_tree: CategoryTreeEntry[];
    description: Nullable<string>;
    price: Nullable<number>;
    sale_price: Nullable<number>;
    availability: Nullable<'in_stock' | 'out_of_stock' | 'pre_order'>;
    image_url: Nullable<string>;
    additional_image_urls: string[];
    specs: SpecEntry[];
    star_rating: Nullable<number>;
    review_count: Nullable<number>;
    gtin: Nullable<string>;
    mpn: Nullable<string>;
    scraped_at: string;
};

const safe =
    async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
        try {
            return await fn();
        } catch {
            return fallback;
        }
    };

const extractBreadcrumbActiveText = (page: Page): Promise<Nullable<string>> =>
    safe(() => page.locator('.breadcrumb .breadcrumb-item.active').first().textContent(), null);

const extractTitle = (page: Page): Promise<Nullable<string>> =>
    safe(() => page.locator('h2.title').first().textContent(), null);

const extractItemId = (url: string, breadcrumbActiveText: Nullable<string>): Nullable<string> => {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    return segments.at(-1) ?? breadcrumbActiveText ?? null;
};

const extractBrand = async (page: Page, productTitle: Nullable<string>): Promise<Nullable<string>> => {
    if (!productTitle) return null;
    const pageTitle = await safe(() => page.title(), '');

    const idx = pageTitle.toLowerCase().indexOf(productTitle.toLowerCase());
    if (idx <= 0) return null;

    return pageTitle.slice(0, idx).trim() || null;
};

// dropping home and current product as neither are really a category
const extractCategoryTree = (page: Page): Promise<CategoryTreeEntry[]> =>
    safe(
        () =>
            page.evaluate(() => {
                const items = Array.from(document.querySelectorAll('.breadcrumb .breadcrumb-item'));
                return items
                    .filter((li) => !li.classList.contains('active'))
                    .map((li) => {
                        const link = li.querySelector('a');
                        return {
                            name: (link?.textContent ?? li.textContent ?? '').trim(),
                            url: link?.getAttribute('href') ?? null,
                        };
                    })
                    .filter((entry) => entry.name.length > 0 && entry.name.toLowerCase() !== 'home');
            }),
        [] as CategoryTreeEntry[],
    );

// there's also the whole description-list of bullet points, but I just kept the summary since it's specified as string
const extractDescription = (page: Page): Promise<Nullable<string>> =>
    safe(
        () =>
            page.evaluate(() => {
                const container = document.querySelector('.container-fluid.product-detail');
                if (!container) return null;

                const summary = Array.from(container.querySelectorAll('p')).find(
                    (p) => !p.closest('#description-list') && !p.closest('.modal'),
                );
                return summary?.textContent?.trim() ?? null;
            }),
        null,
    );

const extractPriceRaw = (page: Page): Promise<Nullable<string>> =>
    safe(() => page.locator('#prices-wrapper #prices-new').first().textContent(), null);

const parsePrice = (raw: Nullable<string>): Nullable<number> => {
    if (!raw) return null;
    const value = Number(raw.replace(/[^0-9.]/g, ''));
    return Number.isFinite(value) ? value : null;
};

const extractAvailabilityRaw = (page: Page): Promise<string> =>
    safe(() => page.locator('#prices-wrapper').innerText(), '');

const parseAvailability = (raw: string): 'in_stock' | 'out_of_stock' | 'pre_order' | null => {
    const text = raw.toLowerCase();
    if (text.includes('out of stock')) return 'out_of_stock';
    if (text.includes('pre-order') || text.includes('pre order')) return 'pre_order';
    if (text.includes('in stock')) return 'in_stock';
    return null;
};

const extractImageUrl = (page: Page): Promise<Nullable<string>> =>
    safe(() => page.locator('#imagePopup').getAttribute('src'), null);

const extractAdditionalImageUrls = (page: Page, mainUrl: Nullable<string>): Promise<string[]> =>
    safe(
        () =>
            page.evaluate((mainUrl) => {
                const imgs = Array.from(document.querySelectorAll<HTMLImageElement>('.product-detail-thumb-bto'));
                const urls = imgs
                    .map((img) => img.getAttribute('popup_img') ?? img.getAttribute('src'))
                    .filter((src): src is string => Boolean(src));
                return Array.from(new Set(urls)).filter((url) => url !== mainUrl);
            }, mainUrl),
        [] as string[],
    );

const cleanText = (raw: string): string => raw.replace(/\s+/g, ' ').trim();
type RawSpecRow = { name: string; value: string };

const extractSpecs = async (page: import('playwright').Page): Promise<SpecEntry[]> =>
    safe(
        () =>
            page.evaluate((): RawSpecRow[] => {
                const rows = Array.from(document.querySelectorAll('table.table-borderless tr'));
                return rows
                    .map((row) => {
                        const name = row.querySelector('th')?.textContent ?? '';
                        const value = (row.querySelector('td') as HTMLElement | null)?.innerText ?? '';
                        return { name, value };
                    })
                    .filter((entry) => entry.name.trim().length > 0);
            }),
        [] as RawSpecRow[],
    ).then((rows) =>
        rows.map(({ name, value }) => {
            const cleanValue = cleanText(value);
            return { name: cleanText(name), value: cleanValue === '-' || cleanValue === '' ? null : cleanValue };
        }),
    );
const extractRating = async (
    page: import('playwright').Page,
): Promise<{ starRating: Nullable<number>; reviewCount: Nullable<number> }> => {
    const text = await safe(
        () =>
            page.evaluate(() => {
                const raw = document.querySelector('#average-rating-info')?.textContent ?? '';
                return raw.replace(/\u00a0/g, ' ').trim();
            }),
        '',
    );
    const match = text.match(/([\d.]+)\s*\((\d+)\)/);
    return {
        starRating: match ? Number(match[1]) : null,
        reviewCount: match ? Number(match[2]) : null,
    };
};

const main = async () => {
    const browser = await chromium.launch({headless: true, channel: 'chromium'});
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/115 Safari/537.36',
        viewport: {width: 1536, height: 864},
    });

    await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', {get: () => undefined});

        Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3, 4, 5]});
        Object.defineProperty(navigator, 'languages', {get: () => ['en-US', 'en']});

        (window as any).chrome = { runtime: {} };
    });

    const page = await context.newPage();

    try {
        await page.goto(TARGET_URL, {waitUntil: 'networkidle'});
    } catch {
        await page.goto(TARGET_URL, {waitUntil: 'domcontentloaded'});
    }

    const breadcrumbActiveText = await extractBreadcrumbActiveText(page);
    const itemId = extractItemId(page.url(), breadcrumbActiveText?.trim() ?? null);
    const title = await extractTitle(page);
    const brand = await extractBrand(page, title);
    const categoryTree = await extractCategoryTree(page);
    const priceRaw = await extractPriceRaw(page);
    const description = await extractDescription(page);
    const availabilityRaw = await extractAvailabilityRaw(page);
    const imageUrl = await extractImageUrl(page);
    const additionalImageUrls = await extractAdditionalImageUrls(page, imageUrl);
    const specs = await extractSpecs(page);
    const {starRating, reviewCount} = await extractRating(page);

    const data: ProductData = {
        url: page.url(),
        item_id: itemId,
        title: title?.trim() ?? null,
        // not entirely sure how reliable getting the brand from the page title is,
        // would require looking at the consistency in some other pages, but if not, it's just null
        brand: brand ?? null,
        product_category: categoryTree.length ? categoryTree.map((c) => c.name).join(' > ') : null,
        category_tree: categoryTree,
        description,
        price: parsePrice(priceRaw),
        sale_price: null, // not shown at all on this page in my region at least, so null
        availability: parseAvailability(availabilityRaw),
        image_url: imageUrl,
        additional_image_urls: additionalImageUrls,
        specs,
        star_rating: starRating,
        review_count: reviewCount,
        gtin: null, // it's not found on the page or the data
        mpn: null, // there is a manufacture number in the specs, but I googled what an MPN is and it doesn't look like one
        scraped_at: Temporal.Now.instant().toString(),
    };

    console.log(`done, see ${OUTPUT_PATH}`)
    mkdirSync('output', {recursive: true});
    writeFileSync(OUTPUT_PATH, JSON.stringify(data, null, 2));

    await browser.close();
};

main().then();
