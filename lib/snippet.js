/**
 * Hardcoded MVP snippet. Later: load from API / user saves / slider UI.
 */
export const DEFAULT_SNIPPET = {
  id: "mvp-1",
  label: "Demo (Cut To The Feeling)",
  trackUri: "spotify:track:11dFghVXANMlKmJXsNCbNl",
  positionMs: 60000,
};

/**
 * Clone snippet with a new start time (ms). Useful for sliders / multiple snippets.
 */
export function snippetAtPositionMs(snippet, positionMs) {
  return { ...snippet, positionMs: Math.max(0, Math.floor(positionMs)) };
}

/**
 * PUT /v1/me/player/play — playback only via Spotify; no audio storage.
 */
export async function playSnippet(accessToken, snippet) {
  const body = {
    uris: [snippet.trackUri],
    position_ms: snippet.positionMs,
  };

  console.log("[playSnippet] request", {
    trackUri: snippet.trackUri,
    position_ms: snippet.positionMs,
  });

  const res = await fetch("https://api.spotify.com/v1/me/player/play", {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  console.log("[playSnippet] response status", res.status);

  if (!res.ok) {
    const text = await res.text();
    console.warn("[playSnippet] body", text);
  }

  return res;
}
