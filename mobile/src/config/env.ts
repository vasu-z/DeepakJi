/**
 * Backend API configuration.
 *
 * NOTE: Never store Gemini or cloud API keys in the mobile application.
 * All AI and external requests must go through the backend server.
 */

// Candidate URLs in priority order:
// 1. 127.0.0.1:8000 (USB ADB reverse — zero latency, bypasses Wi-Fi router & firewall blocks)
// 2. 192.168.29.99:8000 (Computer's Wi-Fi LAN IP)
// 3. localhost:8000 (Device localhost)
// 4. 10.0.2.2:8000 (Android emulator host loopback)
export const CANDIDATE_BACKEND_URLS = [
  "http://127.0.0.1:8000",
  "http://192.168.29.99:8000",
  "http://localhost:8000",
  "http://10.0.2.2:8000",
];

export const DEFAULT_BACKEND_URL = "http://127.0.0.1:8000";

let currentBackendUrl = DEFAULT_BACKEND_URL;

export function getBackendBaseUrl(): string {
  return currentBackendUrl;
}

export function setBackendBaseUrl(newUrl: string): string {
  let cleaned = newUrl.trim();
  // Strip trailing slashes
  cleaned = cleaned.replace(/\/+$/, "");
  if (cleaned.length > 0) {
    if (!cleaned.startsWith("http://") && !cleaned.startsWith("https://")) {
      cleaned = `http://${cleaned}`;
    }
    currentBackendUrl = cleaned;
  }
  return currentBackendUrl;
}
