(() => {
  if (globalThis.__browserPilotContentReady) return;
  globalThis.__browserPilotContentReady = true;

  const controlSelector = "a[href], button, input, textarea, select, [role='button'], [role='link']";
  const normalizeText = (value) => (value || "").replace(/\s+/g, " ").trim();
  const referencedLabelTexts = (element) => (element.getAttribute("aria-labelledby") || "").trim().split(/\s+/)
    .filter(Boolean).map((id) => normalizeText(document.getElementById(id)?.textContent)).filter(Boolean);
  const nativeLabelTexts = (element) => Array.from(element.labels || []).map((label) => normalizeText(label.textContent)).filter(Boolean);
  const labelTexts = (element) => {
    const referenced = referencedLabelTexts(element);
    if (referenced.length) return [referenced.join(" ")];
    const explicit = normalizeText(element.getAttribute("aria-label"));
    if (explicit) return [explicit];
    const native = nativeLabelTexts(element);
    return [...new Set([...native, native.join(" ")].filter(Boolean))];
  };
  const labelOf = (element) => labelTexts(element).at(-1) || normalizeText(
    element.innerText || element.placeholder || element.getAttribute("title") || ""
  );
  const labelTarget = (element) => {
    const tag = element.tagName.toLowerCase();
    if (tag === "input") return element.type !== "hidden";
    if (["button", "textarea", "select", "meter", "output", "progress"].includes(tag) || element.isContentEditable) return true;
    const role = (element.getAttribute("role") || "").trim().split(/\s+/)[0];
    return ["button", "checkbox", "combobox", "link", "listbox", "menuitem", "menuitemcheckbox", "menuitemradio",
      "option", "radio", "searchbox", "slider", "spinbutton", "switch", "textbox"].includes(role) ||
      (tag === "a" && element.hasAttribute("href"));
  };
  const cleanUrl = (raw) => {
    try {
      const url = new URL(raw, location.href);
      return /^https?:$/.test(url.protocol) ? `${url.origin}${url.pathname}` : undefined;
    } catch { return undefined; }
  };
  const implicitRole = (element) => {
    if (element.hasAttribute("role")) return element.getAttribute("role");
    const tag = element.tagName.toLowerCase();
    if (tag === "a" && element.hasAttribute("href")) return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "img") return "img";
    if (tag === "input") {
      const type = (element.type || "text").toLowerCase();
      if (["button", "submit", "reset"].includes(type)) return "button";
      if (["checkbox", "radio"].includes(type)) return type;
      if (type === "file") return "button";
      return "textbox";
    }
    return tag;
  };
  const matches = (input) => {
    if (input.by === "index") return [document.querySelectorAll(controlSelector)[input.index]].filter(Boolean);
    if (input.by === "css") return Array.from(document.querySelectorAll(input.value));
    const elements = Array.from(document.querySelectorAll("body *"));
    const needle = input.by === "role" ? input.name : input.value;
    const compare = (value) => input.exact ? value === needle : value.toLowerCase().includes((needle || "").toLowerCase());
    let found = elements.filter((element) => {
      if (input.by === "role") return implicitRole(element) === input.role && (!needle || compare(labelOf(element)));
      if (input.by === "label") return labelTarget(element) && labelTexts(element).some(compare);
      if (input.by === "placeholder") return compare(element.getAttribute("placeholder") || "");
      return compare((element.innerText || "").trim().slice(0, 500));
    });
    if (input.by === "text") found = found.filter((element) => !Array.from(element.children).some((child) => compare((child.innerText || "").trim().slice(0, 500))));
    return found;
  };
  const resolve = (input) => {
    let found = matches(input);
    if (input.matchIndex !== undefined) found = found.slice(input.matchIndex, input.matchIndex + 1);
    if (!found.length) throw new Error("Target not found. Take a fresh snapshot or use a different locator.");
    if (found.length > 1) throw new Error(`Target matches ${found.length} elements. Use matchIndex to select one.`);
    return found[0];
  };
  const details = (element) => ({
    label: labelOf(element).slice(0, 160),
    tag: element.tagName.toLowerCase(),
    type: element.getAttribute("type") || (element.tagName === "BUTTON" ? "submit" : undefined),
    href: element instanceof HTMLAnchorElement ? cleanUrl(element.href) : undefined,
    fingerprint: JSON.stringify({ tag: element.tagName.toLowerCase(), type: element.getAttribute("type"),
      id: element.id, name: element.getAttribute("name"), role: element.getAttribute("role"),
      formActionOverride: element.getAttribute("formaction"), formMethodOverride: element.getAttribute("formmethod"),
      formAssociation: element.getAttribute("form"), formOwnerId: element.form?.id,
      href: element instanceof HTMLAnchorElement ? element.href : null,
      formAction: (element.form || element.closest("form"))?.action, formMethod: (element.form || element.closest("form"))?.method,
      contentEditable: element.isContentEditable, label: labelOf(element),
      ariaLabel: element.getAttribute("aria-label"), labelledBy: element.getAttribute("aria-labelledby"),
      referencedLabels: referencedLabelTexts(element), nativeLabels: nativeLabelTexts(element) }),
  });
  const sensitive = (element) => {
    const identity = ["type", "name", "id", "autocomplete", "aria-label", "placeholder"].map((key) => element.getAttribute(key) || "").join(" ") +
      ` ${nativeLabelTexts(element).join(" ")} ${referencedLabelTexts(element).join(" ")}`;
    if (/password|passcode|one[-.\s]*time[-.\s]*(?:code|password)|otp|(?:verification|security|authentication|recovery|backup)[-.\s]*code|credit[-.\s]*card|\bcc-[a-z-]+\b|cc.number|cvv|cvc/i.test(identity)) {
      throw new Error("Complete sensitive sign-in and payment fields directly in Brave.");
    }
  };
  const visiblePoint = (element) => {
    element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (!rect.width || !rect.height || style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) === 0) {
      throw new Error("Target is not visible.");
    }
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const top = document.elementFromPoint(x, y);
    if (!top || (top !== element && !element.contains(top))) throw new Error("Target is obscured. Take a fresh snapshot before interacting.");
    return { x, y,
      rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height } };
  };
  const point = (element) => {
    if (element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type)) {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const hidden = !rect.width || !rect.height || style.visibility === "hidden" || style.visibility === "collapse" ||
        Number(style.opacity) === 0 || style.clip !== "auto" || style.clipPath !== "none";
      if (hidden) {
        for (const label of Array.from(element.labels || [])) {
          if (label.control !== element) continue;
          try { return visiblePoint(label); } catch { /* Try only another associated visible label. */ }
        }
        throw new Error("Hidden checkbox or radio has no visible associated label.");
      }
    }
    return visiblePoint(element);
  };
  const snapshot = () => ({
    url: cleanUrl(location.href) || location.href,
    title: document.title,
    text: (document.body?.innerText || "").slice(0, 18_000),
    controls: Array.from(document.querySelectorAll(controlSelector)).map((element, index) => {
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      return { index, role: implicitRole(element), label: labelOf(element).slice(0, 120),
        type: element.getAttribute("type") || undefined,
        href: element instanceof HTMLAnchorElement ? cleanUrl(element.href) : undefined };
    }).filter(Boolean).slice(0, 160),
  });
  const extract = (request) => {
    if (request.mode === "target") return { text: (resolve(request.target).innerText || "").slice(0, 10_000) };
    const limit = request.limit || 100;
    if (request.mode === "links") return Array.from(document.querySelectorAll("a[href]")).slice(0, limit)
      .map((a) => ({ text: labelOf(a).slice(0, 200), href: cleanUrl(a.href) }));
    if (request.mode === "images") return Array.from(document.images).slice(0, limit)
      .map((img) => ({ src: cleanUrl(img.currentSrc || img.src) || "", alt: img.alt.slice(0, 200), width: img.naturalWidth, height: img.naturalHeight }));
    if (request.mode === "tables") return Array.from(document.querySelectorAll("table")).slice(0, limit)
      .map((table) => Array.from(table.rows).slice(0, 100).map((row) => Array.from(row.cells).slice(0, 30)
        .map((cell) => (cell.innerText || "").trim().slice(0, 500))));
    const meta = Array.from(document.querySelectorAll("meta[name], meta[property]")).slice(0, 100)
      .map((element) => ({ name: (element.name || element.getAttribute("property") || "").slice(0, 100), content: element.content.slice(0, 500) }));
    return { title: document.title, description: document.querySelector('meta[name="description"]')?.content.slice(0, 500) || "",
      canonical: cleanUrl(document.querySelector('link[rel="canonical"]')?.href || "") || "", meta };
  };
  const siteExtract = ({ site, limit }) => {
    const sites = {
      pinterest: { domains: ["pinterest.com"], selector: 'a[href*="/pin/"]' },
      gmail: { domains: ["mail.google.com"], selector: '[role="row"]' },
      google_drive: { domains: ["drive.google.com"], selector: '[role="row"]' },
      linkedin: { domains: ["linkedin.com"], selector: "[data-urn], article" },
      shopify: { domains: ["admin.shopify.com", "myshopify.com"], selector: 'a[href*="/products/"], [role="row"]' },
    };
    const adapter = sites[site];
    if (!adapter || !adapter.domains.some((domain) => location.hostname === domain || location.hostname.endsWith(`.${domain}`))) {
      throw new Error(`The selected tab is not on ${site}.`);
    }
    const items = Array.from(document.querySelectorAll(adapter.selector)).slice(0, limit).map((element) => {
      const image = element.querySelector("img");
      const link = element instanceof HTMLAnchorElement ? element : element.querySelector("a[href]");
      return { text: labelOf(element).slice(0, 500), href: link ? cleanUrl(link.href) : undefined,
        image: image ? cleanUrl(image.currentSrc || image.src) : undefined, alt: image?.alt.slice(0, 200) };
    }).filter((item) => item.text || item.href || item.image);
    return { url: cleanUrl(location.href), title: document.title, items };
  };
  const run = (request) => {
    const { op, args = {} } = request;
    if (op === "snapshot") return snapshot();
    if (op === "mediaState") return Array.from(document.querySelectorAll("video")).slice(0, 5).map((video) => ({
      currentTime: video.currentTime, duration: Number.isFinite(video.duration) ? video.duration : null,
      paused: video.paused, readyState: video.readyState, width: video.videoWidth, height: video.videoHeight,
    }));
    if (op === "videoFrame") {
      const video = resolve(args.target);
      if (!(video instanceof HTMLVideoElement) || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
          !video.videoWidth || !video.videoHeight) {
        throw new Error("Target is not a ready video element.");
      }
      const canvas = document.createElement("canvas");
      canvas.width = Math.min(video.videoWidth, 640);
      canvas.height = Math.max(1, Math.round(canvas.width * video.videoHeight / video.videoWidth));
      canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", 0.65).split(",")[1];
    }
    if (op === "find") {
      const found = matches(args.target);
      return { count: found.length, matches: found.slice(0, args.limit || 20).map((element, matchIndex) => {
        const rect = element.getBoundingClientRect();
        const { fingerprint, ...visibleDetails } = details(element);
        return { matchIndex, ...visibleDetails, visible: rect.width > 0 && rect.height > 0 };
      }) };
    }
    if (op === "describe") return details(resolve(args.target));
    if (op === "point") return point(resolve(args.target));
    if (op === "focused") {
      const element = document.activeElement;
      return { label: element ? labelOf(element).slice(0, 120) : "", tag: element?.closest("form") ? "form" : element?.tagName.toLowerCase() || "",
        type: element?.getAttribute("type") || "", fingerprint: element ? details(element).fingerprint : "" };
    }
    if (op === "fill") {
      const element = resolve(args.target);
      sensitive(element);
      if (args.text.length > 4000) throw new Error("Text exceeds 4000 characters.");
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
        setter.call(element, args.text);
      } else if (element.isContentEditable) element.textContent = args.text;
      else throw new Error("Target is not editable.");
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: args.text }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return { filled: true };
    }
    if (op === "select") {
      const element = resolve(args.target);
      if (!(element instanceof HTMLSelectElement)) throw new Error("Target is not a select element.");
      const values = new Set(args.values);
      for (const option of element.options) option.selected = values.has(option.value) || values.has(option.label);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return { selected: true };
    }
    if (op === "scroll") { window.scrollBy({ top: args.direction === "down" ? args.pixels : -args.pixels, behavior: "instant" }); return { scrolled: true }; }
    if (op === "extract") return extract(args.request);
    if (op === "siteExtract") return siteExtract(args);
    if (op === "imageSource") {
      const image = document.images.item(args.index);
      if (!image) throw new Error("Image index is stale. Extract images again.");
      return { src: image.currentSrc || image.src, alt: image.alt.slice(0, 200) };
    }
    if (op === "state") {
      if (args.target) {
        const found = matches(args.target);
        const element = found[0];
        const rect = element?.getBoundingClientRect();
        return { exists: !!element, visible: !!rect?.width && !!rect?.height, url: location.href, readyState: document.readyState };
      }
      return { url: location.href, readyState: document.readyState };
    }
    if (op === "markUpload") {
      const element = resolve(args.target);
      sensitive(element);
      if (!(element instanceof HTMLInputElement) || element.type !== "file") throw new Error("Target is not a file input.");
      if (!/^[a-f0-9]{32}$/.test(args.marker)) throw new Error("Invalid upload marker.");
      element.setAttribute("data-browserpilot-upload", args.marker);
      return { marker: args.marker };
    }
    if (op === "clearUpload") {
      document.querySelector(`[data-browserpilot-upload="${args.marker}"]`)?.removeAttribute("data-browserpilot-upload");
      return { cleared: true };
    }
    throw new Error("Unsupported page operation.");
  };

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || request?.channel !== "browserpilot") return;
    try { sendResponse({ result: run(request) }); }
    catch (error) { sendResponse({ error: error instanceof Error ? error.message : "Page operation failed." }); }
  });
})();
