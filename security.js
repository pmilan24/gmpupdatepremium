// security.js - 24-Hour Passcode / PIN Protection for Dashboard Panel
(function() {
  "use strict";

  // SHA-256 hash of the valid PIN (Default: "9924")
  // Can be updated via node set-pin.js <NEW_PIN> or GitHub Actions secret PANEL_PIN
  const VALID_PIN_HASH = "__PANEL_PIN_HASH__"; // replaced at build or defaults below
  const DEFAULT_HASH = "9730f9c50a2e1e274f701a6a33c7c2d4b65588b4a411fd314c0f1dd008e72341"; // default PIN: 9924
  const ACTIVE_HASH = (VALID_PIN_HASH && !VALID_PIN_HASH.startsWith("__")) ? VALID_PIN_HASH : DEFAULT_HASH;

  const STORAGE_KEY = "panel_auth_session";
  const SESSION_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

  // Compute SHA-256 hash using Web Crypto API
  async function computeSha256(text) {
    const msgBuffer = new TextEncoder().encode(text);
    const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
  }

  // Check if active session exists and has not expired
  function isSessionValid() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const session = JSON.parse(raw);
      if (!session || !session.expiresAt) return false;
      return Date.now() < session.expiresAt;
    } catch (e) {
      return false;
    }
  }

  function getRemainingHours() {
    try {
      const session = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      if (!session.expiresAt) return 0;
      const ms = session.expiresAt - Date.now();
      if (ms <= 0) return 0;
      return Math.round(ms / (1000 * 60 * 60));
    } catch (e) {
      return 0;
    }
  }

  function saveSession() {
    const session = {
      unlockedAt: Date.now(),
      expiresAt: Date.now() + SESSION_DURATION_MS
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  }

  function clearSession() {
    localStorage.removeItem(STORAGE_KEY);
    location.reload();
  }

  // Inject Lock Styles
  function injectStyles() {
    const css = `
      #panelLockOverlay {
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        background: rgba(10, 15, 29, 0.96);
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 999999;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      .panel-lock-card {
        background: #131d32;
        border: 1px solid rgba(255, 255, 255, 0.12);
        box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7), 0 0 40px rgba(59, 130, 246, 0.15);
        border-radius: 18px;
        padding: 36px 32px;
        width: 100%;
        max-width: 400px;
        text-align: center;
        color: #f1f5f9;
        animation: lockFadeIn 0.3s ease-out;
      }
      @keyframes lockFadeIn {
        from { opacity: 0; transform: scale(0.95) translateY(10px); }
        to { opacity: 1; transform: scale(1) translateY(0); }
      }
      .panel-lock-icon {
        width: 60px;
        height: 60px;
        background: linear-gradient(135deg, #3b82f6, #1d4ed8);
        border-radius: 50%;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 28px;
        margin-bottom: 16px;
        box-shadow: 0 10px 25px rgba(59, 130, 246, 0.3);
      }
      .panel-lock-title {
        font-size: 1.35rem;
        font-weight: 700;
        margin: 0 0 6px 0;
        color: #fff;
      }
      .panel-lock-sub {
        font-size: 0.84rem;
        color: #94a3b8;
        margin: 0 0 24px 0;
        line-height: 1.4;
      }
      .panel-lock-input-group {
        position: relative;
        margin-bottom: 16px;
      }
      .panel-lock-input {
        width: 100%;
        box-sizing: border-box;
        padding: 13px 44px 13px 16px;
        background: #0b1120;
        border: 1.5px solid #334155;
        border-radius: 10px;
        color: #fff;
        font-size: 1.1rem;
        letter-spacing: 2px;
        text-align: center;
        outline: none;
        transition: border-color 0.2s, box-shadow 0.2s;
      }
      .panel-lock-input:focus {
        border-color: #3b82f6;
        box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.25);
      }
      .panel-lock-toggle-eye {
        position: absolute;
        right: 12px;
        top: 50%;
        transform: translateY(-50%);
        background: none;
        border: none;
        color: #94a3b8;
        cursor: pointer;
        font-size: 18px;
        padding: 4px;
      }
      .panel-lock-btn {
        width: 100%;
        padding: 13px;
        background: linear-gradient(135deg, #3b82f6, #2563eb);
        color: #fff;
        border: none;
        border-radius: 10px;
        font-size: 0.95rem;
        font-weight: 600;
        cursor: pointer;
        transition: transform 0.15s, background 0.2s;
      }
      .panel-lock-btn:hover {
        background: linear-gradient(135deg, #2563eb, #1d4ed8);
        transform: translateY(-1px);
      }
      .panel-lock-btn:active {
        transform: translateY(0);
      }
      .panel-lock-error {
        color: #f87171;
        font-size: 0.8rem;
        margin-top: 10px;
        min-height: 18px;
      }
      .panel-lock-footer {
        font-size: 0.74rem;
        color: #64748b;
        margin-top: 18px;
      }
      .panel-auth-badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        background: rgba(16, 185, 129, 0.12);
        border: 1px solid rgba(16, 185, 129, 0.3);
        color: #34d399;
        padding: 4px 10px;
        border-radius: 20px;
        font-size: 0.74rem;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.2s ease;
      }
      .panel-auth-badge:hover {
        background: rgba(239, 68, 68, 0.15);
        border-color: rgba(239, 68, 68, 0.4);
        color: #f87171;
      }
      @keyframes shakeInput {
        0%, 100% { transform: translateX(0); }
        20%, 60% { transform: translateX(-8px); }
        40%, 80% { transform: translateX(8px); }
      }
      .shake {
        animation: shakeInput 0.35s ease-in-out;
      }
    `;
    const style = document.createElement("style");
    style.id = "panelSecurityStyles";
    style.textContent = css;
    document.head.appendChild(style);
  }

  // Render Lock Screen UI
  function showLockScreen() {
    if (document.getElementById("panelLockOverlay")) return;

    const overlay = document.createElement("div");
    overlay.id = "panelLockOverlay";
    overlay.innerHTML = `
      <div class="panel-lock-card">
        <div class="panel-lock-icon">🔒</div>
        <h2 class="panel-lock-title">Access Protected</h2>
        <p class="panel-lock-sub">This private dashboard requires an authorized Security PIN to access.</p>
        
        <form id="panelLockForm" onsubmit="return false;">
          <div class="panel-lock-input-group">
            <input type="password" id="panelPinInput" class="panel-lock-input" placeholder="Enter PIN" autocomplete="off" autofocus />
            <button type="button" id="panelToggleEye" class="panel-lock-toggle-eye" title="Toggle visibility">👁️</button>
          </div>
          <button type="submit" id="panelUnlockBtn" class="panel-lock-btn">Unlock Panel</button>
          <div id="panelLockError" class="panel-lock-error"></div>
        </form>

        <div class="panel-lock-footer">
          ⏱️ Successful unlock stays active for <b>24 hours</b> on this device.
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const input = document.getElementById("panelPinInput");
    const eye = document.getElementById("panelToggleEye");
    const form = document.getElementById("panelLockForm");
    const err = document.getElementById("panelLockError");

    if (eye && input) {
      eye.addEventListener("click", () => {
        const isPwd = input.type === "password";
        input.type = isPwd ? "text" : "password";
        eye.textContent = isPwd ? "🙈" : "👁️";
      });
    }

    if (form) {
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const val = input.value.trim();
        if (!val) {
          err.textContent = "Please enter your PIN.";
          return;
        }

        const hashed = await computeSha256(val);
        if (hashed === ACTIVE_HASH) {
          err.textContent = "";
          saveSession();
          overlay.style.opacity = "0";
          overlay.style.transition = "opacity 0.25s ease";
          setTimeout(() => {
            overlay.remove();
            renderAuthBadge();
          }, 250);
        } else {
          err.textContent = "❌ Incorrect PIN. Access denied.";
          input.classList.add("shake");
          setTimeout(() => input.classList.remove("shake"), 400);
          input.value = "";
          input.focus();
        }
      });
    }
  }

  // Render Lock/Logout indicator in navigation or header
  function renderAuthBadge() {
    if (document.getElementById("panelAuthBadge")) return;
    const nav = document.querySelector(".nav-tabs") || document.querySelector(".header-actions");
    if (!nav) return;

    const remainingHrs = getRemainingHours();
    const badge = document.createElement("div");
    badge.id = "panelAuthBadge";
    badge.className = "panel-auth-badge";
    badge.title = "Authenticated for next " + remainingHrs + "h. Click to lock now.";
    badge.innerHTML = `<span>🔒 Active (${remainingHrs}h left)</span>`;
    badge.addEventListener("click", () => {
      if (confirm("Lock panel and sign out now?")) {
        clearSession();
      }
    });

    nav.appendChild(badge);
  }

  // Main Security Initialization
  function initSecurity() {
    injectStyles();

    if (!isSessionValid()) {
      showLockScreen();
    } else {
      renderAuthBadge();
      // Auto-lock when 24 hours expire
      const session = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      const msLeft = session.expiresAt - Date.now();
      if (msLeft > 0) {
        setTimeout(() => {
          clearSession();
        }, msLeft);
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initSecurity);
  } else {
    initSecurity();
  }
})();