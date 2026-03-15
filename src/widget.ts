/**
 * QR code widget for NaughtBot captcha.
 * Renders a QR code, shows SAS words/emojis, handles lifecycle.
 *
 * Uses safe DOM APIs (createElement, textContent) instead of innerHTML.
 */

import { createSession, type CaptchaSession } from "./captcha.js";
import { createBLESession, isBLEAvailable } from "./ble.js";
import type {
  CaptchaWidgetOptions,
  CaptchaResult,
  CaptchaSessionState,
  SASDisplay,
} from "./types.js";

/** Widget instance that can be destroyed */
export interface CaptchaWidget {
  /** Destroy the widget and clean up */
  destroy(): void;

  /** Get the underlying session */
  readonly session: CaptchaSession | null;
}

// Track widget instances by container for destroyWidget()
const widgetsByContainer = new WeakMap<HTMLElement, CaptchaWidget>();

// Widget CSS class prefix
const CLS = "naughtbot";

/**
 * Create a captcha widget in the specified container.
 *
 * @param container - CSS selector or DOM element
 * @param options - Widget options
 * @returns Widget instance
 */
export async function createWidget(
  container: string | HTMLElement,
  options: CaptchaWidgetOptions,
): Promise<CaptchaWidget> {
  const maybeEl =
    typeof container === "string" ? document.querySelector<HTMLElement>(container) : container;

  if (!maybeEl) {
    throw new Error(`Container not found: ${container}`);
  }

  const el: HTMLElement = maybeEl;

  let session: CaptchaSession | null = null;
  let destroyed = false;

  const mode = options.mode ?? "qr";
  const bleAvailable = mode === "ble" || mode === "auto" ? await isBLEAvailable() : false;
  const useBLE = (mode === "ble" || mode === "auto") && bleAvailable;

  injectStyles();

  if (useBLE) {
    // BLE mode: show a connect button (Web Bluetooth requires user gesture)
    renderInto(
      el,
      buildBLEPrompt(() => startBLESession()),
    );
  } else if (mode === "ble") {
    // BLE explicitly requested but not available
    renderInto(el, buildBLEUnavailable());
    const err = new Error("Web Bluetooth is not available");
    err.name = "BLEUnavailableError";
    options.onError?.(err);
  } else {
    // QR mode: create relay session immediately
    renderInto(el, buildState("initializing", null, null));
    startQRSession();
  }

  function startBLESession() {
    renderInto(el, buildState("initializing", null, null));
    createBLESession(options)
      .then((bleSession) => {
        if (destroyed) return;
        session = bleSession;
        wireSession(bleSession);
      })
      .catch((error) => {
        if (destroyed) return;
        // In auto mode, fall back to QR if BLE fails (user cancelled picker, etc.)
        if (mode === "auto") {
          startQRSession();
          return;
        }
        renderInto(el, buildState("error", null, null));
        options.onError?.(error instanceof Error ? error : new Error(String(error)));
      });
  }

  function startQRSession() {
    createSession(options)
      .then((qrSession) => {
        if (destroyed) return;
        session = qrSession;
        wireSession(qrSession);
        renderInto(el, buildState("waiting_for_scan", qrSession.qrCodeUrl, null));
      })
      .catch((error) => {
        if (!destroyed) {
          renderInto(el, buildState("error", null, null));
          options.onError?.(error instanceof Error ? error : new Error(String(error)));
        }
      });
  }

  function wireSession(s: CaptchaSession) {
    s.onStateChange((state: CaptchaSessionState, sas: SASDisplay | null) => {
      if (destroyed) return;
      renderInto(el, buildState(state, s.qrCodeUrl, sas));
      options.onStateChange?.(state);
    });

    s.waitForResult()
      .then(async (result: CaptchaResult) => {
        if (!destroyed) {
          renderInto(el, buildState("verifying", null, null));
          try {
            await options.onVerified(result);
            if (!destroyed) {
              renderInto(el, buildState("verified", null, null));
            }
          } catch {
            if (!destroyed) {
              renderInto(el, buildState("error", null, null));
            }
          }
        }
      })
      .catch((error: unknown) => {
        if (!destroyed) {
          const err = error instanceof Error ? error : new Error(String(error));
          if (err.message.includes("expired")) {
            renderInto(el, buildState("expired", null, null));
            options.onExpired?.();
          } else {
            renderInto(el, buildState("error", null, null));
            options.onError?.(err);
          }
        }
      });
  }

  const widget: CaptchaWidget = {
    destroy() {
      destroyed = true;
      session?.cancel();
      while (el.firstChild) el.removeChild(el.firstChild);
      widgetsByContainer.delete(el);
    },
    get session() {
      return session;
    },
  };

  widgetsByContainer.set(el, widget);
  return widget;
}

/**
 * Destroy a widget previously created in the given container.
 *
 * @param container - CSS selector or DOM element that was passed to createWidget
 */
export function destroyWidget(container: string | HTMLElement): void {
  const el =
    typeof container === "string" ? document.querySelector<HTMLElement>(container) : container;
  if (!el) return;

  const widget = widgetsByContainer.get(el);
  if (widget) {
    widget.destroy();
  } else {
    // No tracked widget — just clear the container
    while (el.firstChild) el.removeChild(el.firstChild);
  }
}

// --- Safe DOM rendering helpers ---

/** Build a BLE connect prompt (button requires user gesture for Web Bluetooth) */
function buildBLEPrompt(onClick: () => void): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = `${CLS}-widget ${CLS}-ble-prompt`;

  wrapper.appendChild(buildBrand());

  const btn = document.createElement("button");
  btn.className = `${CLS}-ble-btn`;
  btn.textContent = "Connect via Bluetooth";
  btn.addEventListener("click", onClick);
  wrapper.appendChild(btn);

  const hint = document.createElement("p");
  hint.className = `${CLS}-hint`;
  hint.textContent = "Connects to nearby NaughtBot device";
  wrapper.appendChild(hint);

  return wrapper;
}

/** Build a "Bluetooth Unavailable" message for when BLE is explicitly requested but not available */
function buildBLEUnavailable(): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = `${CLS}-widget ${CLS}-ble-unavailable`;

  wrapper.appendChild(buildBrand());

  const heading = document.createElement("p");
  heading.className = `${CLS}-label`;
  heading.textContent = "Bluetooth Unavailable";
  wrapper.appendChild(heading);

  const hint = document.createElement("p");
  hint.className = `${CLS}-hint`;
  hint.textContent =
    "Web Bluetooth is not available. Check that Bluetooth is enabled in your browser settings.";
  wrapper.appendChild(hint);

  return wrapper;
}

/** Replace all children of a container with the given element */
function renderInto(container: HTMLElement, child: HTMLElement): void {
  while (container.firstChild) container.removeChild(container.firstChild);
  container.appendChild(child);
}

/** Build the widget DOM for a given state */
function buildState(
  state: CaptchaSessionState,
  qrCodeUrl: string | null,
  sas: SASDisplay | null,
): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = `${CLS}-widget ${CLS}-${state}`;

  switch (state) {
    case "initializing":
    case "verifying": {
      wrapper.appendChild(buildSpinner());
      const label = document.createElement("p");
      label.className = `${CLS}-label`;
      label.textContent = state === "initializing" ? "Initializing..." : "Verifying...";
      wrapper.appendChild(label);
      break;
    }

    case "waiting_for_scan": {
      wrapper.appendChild(buildBrand());
      if (qrCodeUrl) {
        wrapper.appendChild(buildQR(qrCodeUrl));
      }
      const hint = document.createElement("p");
      hint.className = `${CLS}-hint`;
      hint.textContent = "Scan with NaughtBot app";
      wrapper.appendChild(hint);
      break;
    }

    case "phone_connected":
    case "sas_verification": {
      wrapper.appendChild(buildBrand());
      const instruction = document.createElement("p");
      instruction.className = `${CLS}-hint`;
      instruction.textContent = "Verify this code matches your phone:";
      wrapper.appendChild(instruction);
      if (sas) {
        wrapper.appendChild(buildSASDisplay(sas));
      } else {
        const connecting = document.createElement("p");
        connecting.className = `${CLS}-label`;
        connecting.textContent = "Connecting...";
        wrapper.appendChild(connecting);
      }
      break;
    }

    case "verified": {
      const checkmark = document.createElement("div");
      checkmark.className = `${CLS}-checkmark`;
      // Use a Unicode checkmark rendered in a styled circle (no innerHTML)
      const icon = document.createElement("span");
      icon.textContent = "\u2713";
      icon.className = `${CLS}-checkmark-icon`;
      checkmark.appendChild(icon);
      wrapper.appendChild(checkmark);
      const label = document.createElement("p");
      label.className = `${CLS}-verified-label`;
      label.textContent = "Verified";
      wrapper.appendChild(label);
      break;
    }

    case "expired": {
      const label = document.createElement("p");
      label.className = `${CLS}-expired-label`;
      label.textContent = "Session expired";
      wrapper.appendChild(label);
      break;
    }

    case "error": {
      const label = document.createElement("p");
      label.className = `${CLS}-error-label`;
      label.textContent = "Verification failed";
      wrapper.appendChild(label);
      break;
    }
  }

  return wrapper;
}

function buildBrand(): HTMLElement {
  const brand = document.createElement("div");
  brand.className = `${CLS}-brand`;
  const naught = document.createElement("span");
  naught.className = `${CLS}-brand-naught`;
  naught.textContent = "Naught";
  const bot = document.createElement("span");
  bot.textContent = "Bot";
  brand.appendChild(naught);
  brand.appendChild(bot);
  return brand;
}

function buildSpinner(): HTMLElement {
  const spinner = document.createElement("div");
  spinner.className = `${CLS}-spinner`;
  return spinner;
}

function buildQR(url: string): HTMLElement {
  const container = document.createElement("div");
  container.className = `${CLS}-qr`;
  // Consumers should use this attribute with a real QR library (e.g., qrcode.js)
  // to render a scannable QR code over or in place of the placeholder
  container.dataset.naughtbotQrUrl = url;

  const canvas = document.createElement("canvas");
  canvas.width = 180;
  canvas.height = 180;
  canvas.className = `${CLS}-qr-canvas`;

  const ctx = canvas.getContext("2d");
  if (ctx) {
    drawQRPlaceholder(ctx, 180);
  }

  container.appendChild(canvas);

  // Dispatch a custom event so integrators can render a real QR code
  setTimeout(() => {
    container.dispatchEvent(
      new CustomEvent("naughtbot:qr-ready", { detail: { url }, bubbles: true }),
    );
  }, 0);

  return container;
}

/** Draw a simple QR-like finder pattern placeholder */
function drawQRPlaceholder(ctx: CanvasRenderingContext2D, size: number): void {
  const dark = "#172031";
  const accent = "#dd4541";
  const m = 10; // margin
  const fp = 40; // finder pattern size

  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, size, size);

  // Three finder patterns (top-left, top-right, bottom-left)
  for (const [x, y] of [
    [m, m],
    [size - m - fp, m],
    [m, size - m - fp],
  ]) {
    ctx.fillStyle = dark;
    roundRect(ctx, x, y, fp, fp, 4);
    ctx.fill();
    ctx.fillStyle = "white";
    roundRect(ctx, x + 7, y + 7, fp - 14, fp - 14, 2);
    ctx.fill();
    ctx.fillStyle = dark;
    roundRect(ctx, x + 13, y + 13, fp - 26, fp - 26, 1);
    ctx.fill();
  }

  // Accent center dot
  ctx.fillStyle = accent;
  roundRect(ctx, size / 2 - 10, size / 2 - 10, 20, 20, 3);
  ctx.fill();

  // Some timing pattern dots
  ctx.fillStyle = dark;
  for (let i = 0; i < 5; i++) {
    const dotX = 58 + i * 8;
    if (i % 2 === 0) {
      ctx.fillRect(dotX, 22, 6, 6);
      ctx.fillRect(22, dotX, 6, 6);
    }
  }

  // Label so it's clear this is a placeholder, not a scannable QR code
  ctx.fillStyle = "#94a3b8";
  ctx.font = "bold 10px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("QR PLACEHOLDER", size / 2, size - 6);
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function buildSASDisplay(sas: SASDisplay): HTMLElement {
  const container = document.createElement("div");
  container.className = `${CLS}-sas`;

  const emojis = document.createElement("div");
  emojis.className = `${CLS}-sas-emojis`;
  emojis.textContent = sas.emojis.join(" ");
  container.appendChild(emojis);

  const words = document.createElement("div");
  words.className = `${CLS}-sas-words`;
  words.textContent = sas.wordString;
  container.appendChild(words);

  return container;
}

// --- Stylesheet injection (once per page) ---

let stylesInjected = false;

function injectStyles(): void {
  if (stylesInjected || typeof document === "undefined") return;

  const existingStyle = document.getElementById("naughtbot-widget-styles");
  if (existingStyle) {
    stylesInjected = true;
    return;
  }

  stylesInjected = true;

  const style = document.createElement("style");
  style.id = "naughtbot-widget-styles";
  style.textContent = `
    .${CLS}-widget {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 16px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      min-height: 200px;
      border: 1px solid #e0e0e0;
      border-radius: 12px;
      background: #fafafa;
    }
    .${CLS}-spinner {
      width: 24px;
      height: 24px;
      border: 3px solid #ddd;
      border-top-color: #dd4541;
      border-radius: 50%;
      animation: ${CLS}-spin 0.8s linear infinite;
    }
    @keyframes ${CLS}-spin { to { transform: rotate(360deg); } }
    .${CLS}-label { margin: 12px 0 0; color: #666; font-size: 14px; }
    .${CLS}-hint { margin: 0 0 12px; color: #666; font-size: 13px; }
    .${CLS}-brand { font-weight: 600; font-size: 16px; color: #172031; margin-bottom: 12px; }
    .${CLS}-brand-naught { color: #dd4541; }
    .${CLS}-qr {
      width: 180px;
      height: 180px;
      background: white;
      border: 2px solid #e0e0e0;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .${CLS}-qr-canvas { display: block; }
    .${CLS}-sas { text-align: center; }
    .${CLS}-sas-emojis { font-size: 28px; letter-spacing: 4px; margin-bottom: 8px; }
    .${CLS}-sas-words { font-size: 14px; font-weight: 600; color: #172031; letter-spacing: 1px; font-family: monospace; }
    .${CLS}-checkmark {
      width: 48px; height: 48px; border-radius: 50%; background: #22c55e;
      display: flex; align-items: center; justify-content: center;
    }
    .${CLS}-checkmark-icon { color: white; font-size: 24px; font-weight: bold; }
    .${CLS}-verified-label { margin: 12px 0 0; color: #22c55e; font-size: 14px; font-weight: 600; }
    .${CLS}-expired-label { color: #94a3b8; font-size: 14px; }
    .${CLS}-error-label { color: #dd4541; font-size: 14px; }
    .${CLS}-ble-btn {
      padding: 10px 24px; border: none; border-radius: 8px;
      background: #dd4541; color: white; font-size: 14px; font-weight: 600;
      cursor: pointer; margin-bottom: 8px;
    }
    .${CLS}-ble-btn:hover { background: #c33b38; }
    .${CLS}-ble-unavailable .${CLS}-label { color: #94a3b8; font-weight: 600; }
  `;
  document.head.appendChild(style);
}
