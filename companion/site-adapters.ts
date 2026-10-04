import type { Page } from "playwright";
import { z } from "zod";

export const siteSchema = z.enum(["pinterest", "gmail", "google_drive", "linkedin", "shopify"]);
export type Site = z.infer<typeof siteSchema>;

const config: Record<Site, { domains: string[]; selector: string }> = {
  pinterest: { domains: ["pinterest.com"], selector: 'a[href*="/pin/"]' },
  gmail: { domains: ["mail.google.com"], selector: '[role="row"]' },
  google_drive: { domains: ["drive.google.com"], selector: '[role="row"]' },
  linkedin: { domains: ["linkedin.com"], selector: '[data-urn], article' },
  shopify: { domains: ["admin.shopify.com", "myshopify.com"], selector: 'a[href*="/products/"], [role="row"]' },
};

export async function extractSite(page: Page, site: Site, limit: number) {
  const hostname = new URL(page.url()).hostname.toLowerCase();
  const adapter = config[site];
  if (!adapter.domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) {
    throw new Error(`The selected tab is not on ${site}.`);
  }
  return page.evaluate(({ selector, maximum }) => {
    const items = Array.from(document.querySelectorAll<HTMLElement>(selector)).slice(0, maximum).map((element) => {
      const image = element.querySelector<HTMLImageElement>("img");
      const link = element instanceof HTMLAnchorElement ? element : element.querySelector<HTMLAnchorElement>("a[href]");
      const linkUrl = link ? new URL(link.href, location.href) : null;
      const imageUrl = image ? new URL(image.currentSrc || image.src, location.href) : null;
      return {
        text: (element.innerText || element.getAttribute("aria-label") || "").trim().slice(0, 500),
        href: linkUrl && /^https?:$/.test(linkUrl.protocol) ? `${linkUrl.origin}${linkUrl.pathname}` : undefined,
        image: imageUrl && /^https?:$/.test(imageUrl.protocol) ? `${imageUrl.origin}${imageUrl.pathname}` : undefined,
        alt: image?.alt.slice(0, 200),
      };
    }).filter((item) => item.text || item.href || item.image);
    return { url: `${location.origin}${location.pathname}`, title: document.title, items };
  }, { selector: adapter.selector, maximum: limit });
}
