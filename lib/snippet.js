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

/**
 * Get full player state — track, position, duration, album art, play/pause.
 */
export async function getPlayerState(accessToken) {
  const res = await fetch("https://api.spotify.com/v1/me/player", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 204 || !res.ok) return null;

  const data = await res.json();
  if (!data || !data.item) return null;

  return {
    id: data.item.id,
    name: data.item.name,
    uri: data.item.uri,
    artists: data.item.artists.map((a) => a.name).join(", "),
    albumArt: data.item.album.images[0]?.url ?? null,
    durationMs: data.item.duration_ms,
    positionMs: data.progress_ms,
    isPlaying: data.is_playing,
  };
}

/**
 * Fetch the user's liked songs (up to 50).
 */
export async function getLikedTracks(accessToken) {
  const res = await fetch("https://api.spotify.com/v1/me/tracks?limit=50", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.items || [])
    .filter((item) => item.track?.id)
    .map((item) => ({
      id: item.track.id,
      name: item.track.name,
      uri: item.track.uri,
      artists: item.track.artists.map((a) => a.name).join(", "),
      durationMs: item.track.duration_ms,
      albumArt: item.track.album.images?.[0]?.url ?? null,
    }));
}

/**
 * Fetch the user's playlists (up to 50).
 */
export async function getUserPlaylists(accessToken) {
  const res = await fetch("https://api.spotify.com/v1/me/playlists?limit=50", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.items || []).map((p) => ({
    id: p.id,
    name: p.name,
    trackCount: p.tracks.total,
    coverArt: p.images?.[0]?.url ?? null,
  }));
}

/**
 * Fetch tracks for a playlist (up to 100).
 */
export async function getPlaylistTracks(accessToken, playlistId) {
  const fields = "items(track(id,name,uri,duration_ms,artists(name),album(images)))";
  const res = await fetch(
    `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100&fields=${encodeURIComponent(fields)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) return [];
  const data = await res.json();
  return (data.items || [])
    .filter((item) => item.track?.id)
    .map((item) => ({
      id: item.track.id,
      name: item.track.name,
      uri: item.track.uri,
      artists: item.track.artists.map((a) => a.name).join(", "),
      durationMs: item.track.duration_ms,
      albumArt: item.track.album.images?.[0]?.url ?? null,
    }));
}

/**
 * Get the currently playing track from Spotify.
 */
export async function getCurrentlyPlaying(accessToken) {
  const res = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!res.ok) {
    console.warn("[getCurrentlyPlaying] failed", res.status);
    return null;
  }

  const data = await res.json();
  if (!data.item) {
    console.warn("[getCurrentlyPlaying] no item playing");
    return null;
  }

  return {
    id: data.item.id,
    name: data.item.name,
    uri: data.item.uri,
    artists: data.item.artists.map(a => a.name).join(", "),
  };
}
