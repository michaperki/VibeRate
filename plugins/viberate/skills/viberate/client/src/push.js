import { redactBundle } from './redact.js';

// Push sink: upload a capture bundle to the hosted VibeRate. The bundle is
// redacted, then sent as the request body unchanged. v1 auth is anonymous/
// gist-style — the server mints an unlisted project id + share URL on first push
// and returns them; an optional token lets a later "claim your account" flow
// attach the project to an owner.
//
// Endpoint is configurable so the same client points at local dev or production.
export function apiBase() {
  return (process.env.VBRT_API_URL || '').replace(/\/+$/, '');
}

export async function pushBundle(bundle, { apiUrl = apiBase(), token = process.env.VBRT_TOKEN } = {}) {
  if (!apiUrl) {
    throw new Error(
      'No hosted endpoint configured. Set VBRT_API_URL (e.g. https://viberate.app) to push.',
    );
  }
  const safe = redactBundle(bundle); // scrub secrets before leaving the machine
  const res = await fetch(`${apiUrl}/api/projects`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(safe),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Upload failed: ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ''}`);
  }
  // Expected: { id, url } — the unlisted, link-shareable project page.
  return res.json();
}
