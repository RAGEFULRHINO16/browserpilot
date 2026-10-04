import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { BrowserInteractions, browserElementIdentity } from "./interaction";

function field(attributes: Record<string, string> = {}, labels: string[] = [], references: Record<string, string> = {}, associatedForm?: { id: string; action: string; method: string }) {
  const document = { getElementById: (id: string) => references[id] === undefined ? null : { textContent: references[id] } };
  return {
    tagName: "INPUT", id: attributes.id || "field", type: attributes.type || "text", isContentEditable: false,
    getAttribute: (name: string) => attributes[name] ?? null,
    hasAttribute: (name: string) => name in attributes,
    labels: labels.map((textContent, index) => ({ id: `label-${index}`, htmlFor: attributes.id || "field", textContent })),
    ownerDocument: document, getRootNode: () => document, closest: () => null, form: associatedForm,
  } as unknown as Element;
}

test("ARIA reference order defines the name while every associated label protects sensitive fields", () => {
  const described = browserElementIdentity(field({ "aria-labelledby": "second first", "aria-label": "Fallback" }, ["CVV"], { first: " First ", second: "Second\npart" }));
  assert.equal(described.label, "Second part First");
  assert.equal(described.sensitive, true, "native CVV label is checked despite ARIA name precedence");
  assert.equal(browserElementIdentity(field({}, ["Account", "Verification code"])).sensitive, true);
  assert.equal(browserElementIdentity(field({ "aria-labelledby": "hint" }, [], { hint: "Security code" })).sensitive, true);
  assert.equal(browserElementIdentity(field({ "aria-label": "Color" })).sensitive, false);
});

test("standard payment autocomplete and concatenated OTP identities cannot bypass the sensitive guard", () => {
  const identities: Array<Record<string, string>> = [{ autocomplete: "cc-csc" }, { autocomplete: "cc-exp" }, { autocomplete: "one-time-code" }, { id: "otpInput" }];
  for (const attributes of identities) {
    assert.equal(browserElementIdentity(field(attributes)).sensitive, true, JSON.stringify(attributes));
  }
});

test("fingerprints bind full native and ARIA names, reference IDs and external form ownership", () => {
  const labels = ["A".repeat(180), "Initial"];
  const first = browserElementIdentity(field({}, labels));
  const second = browserElementIdentity(field({}, [labels[0], "Changed"]));
  assert.equal(first.label, second.label, "display preview remains bounded");
  assert.notEqual(first.fingerprint, second.fingerprint, "changes beyond preview limit invalidate the grant");
  const references = { one: "Same name", two: "Same name" };
  assert.notEqual(browserElementIdentity(field({ "aria-labelledby": "one" }, [], references)).fingerprint,
    browserElementIdentity(field({ "aria-labelledby": "two" }, [], references)).fingerprint);
  assert.notEqual(browserElementIdentity(field({ form: "owner" }, [], {}, { id: "owner", action: "https://example.com/first", method: "post" })).fingerprint,
    browserElementIdentity(field({ form: "owner" }, [], {}, { id: "owner", action: "https://example.com/second", method: "post" })).fingerprint);
});

test("Playwright backend blocks referenced secrets and binds focused elements in real Chromium", { skip: process.env.BROWSERPILOT_BROWSER_SECURITY_TEST !== "1" }, async () => {
  const browser = await chromium.launch({ channel: "chromium", headless: true, chromiumSandbox: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(`<label for="note">Note</label><input id="note">
      <div id="draft" contenteditable="true">Documentation about password policies</div>
      <span id="verification">Verification code</span><input id="referenced" aria-labelledby="verification">
      <label for="multiple">Details</label><label for="multiple">CVV</label><input id="multiple">
      <input id="payment" aria-label="Details" autocomplete="cc-csc">
      <form id="owner" action="https://example.com/first" method="post"></form><input id="external" form="owner" aria-label="External">`);
    const interactions = new BrowserInteractions(context, page);
    await interactions.interact({ action: "fill", target: { by: "label", value: "Note", exact: true }, text: "ordinary draft" });
    assert.equal(await page.locator("#note").inputValue(), "ordinary draft");
    await interactions.interact({ action: "fill", target: { by: "css", value: "#draft" }, text: "ordinary revised draft" });
    assert.equal(await page.locator("#draft").innerText(), "ordinary revised draft");
    for (const id of ["referenced", "multiple", "payment"]) {
      await assert.rejects(interactions.interact({ action: "fill", target: { by: "css", value: `#${id}` }, text: "123456" }), /sensitive sign-in and payment/);
      assert.equal(await page.locator(`#${id}`).inputValue(), "");
    }
    const before = await interactions.describeTarget({ by: "css", value: "#referenced" });
    assert.equal(before.label, "Verification code");
    await page.locator("#verification").evaluate((element) => { element.textContent = "Recovery code"; });
    assert.notEqual((await interactions.describeTarget({ by: "css", value: "#referenced" })).fingerprint, before.fingerprint);
    await page.locator("#external").focus();
    const focused = await interactions.focusedDescription();
    assert.equal(focused.tag, "form");
    await page.locator("#owner").evaluate((element) => { (element as HTMLFormElement).action = "https://example.com/second"; });
    assert.notEqual((await interactions.focusedDescription()).fingerprint, focused.fingerprint);
  } finally { await browser.close(); }
});
