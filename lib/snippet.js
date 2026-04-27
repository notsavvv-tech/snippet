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
 * Fetch available Spotify devices for the user.
 */
export async function getDevices(accessToken) {
  const res = await fetch("https://api.spotify.com/v1/me/player/devices", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.devices || [])
    .filter((d) => !d.is_restricted)
    .map((d) => ({
      id: d.id,
      name: d.name,
      type: d.type,
      isActive: d.is_active,
    }));
}

/**
 * PUT /v1/me/player/play — playback only via Spotify; no audio storage.
 * Pass deviceId to start playback on a specific device when nothing is active.
 */
export async function playSnippet(accessToken, snippet) {
  const body = {
    uris: [snippet.trackUri],
    position_ms: snippet.positionMs,
  };

  const url = snippet.deviceId
    ? `https://api.spotify.com/v1/me/player/play?device_id=${snippet.deviceId}`
    : "https://api.spotify.com/v1/me/player/play";

  console.log("[playSnippet] request", {
    trackUri: snippet.trackUri,
    position_ms: snippet.positionMs,
    deviceId: snippet.deviceId ?? null,
  });

  const res = await fetch(url, {
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
    shuffle: data.shuffle_state,
    volumePercent: data.device?.volume_percent ?? null,
    deviceName: data.device?.name ?? null,
    deviceType: data.device?.type ?? null,
  };
}

/**
 * Seek to a position in the current track (ms).
 */
export async function seekToPosition(accessToken, positionMs) {
  return fetch(`https://api.spotify.com/v1/me/player/seek?position_ms=${positionMs}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

/**
 * Pause playback.
 */
export async function pausePlayback(accessToken) {
  return fetch("https://api.spotify.com/v1/me/player/pause", {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

/**
 * Resume playback.
 */
export async function resumePlayback(accessToken) {
  return fetch("https://api.spotify.com/v1/me/player/play", {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

/**
 * Set volume (0–100).
 */
export async function setVolume(accessToken, volumePercent) {
  return fetch(`https://api.spotify.com/v1/me/player/volume?volume_percent=${volumePercent}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

/**
 * Toggle shuffle on or off.
 */
export async function setShuffle(accessToken, state) {
  return fetch(`https://api.spotify.com/v1/me/player/shuffle?state=${state}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

/**
 * Fetch the user's liked songs (up to 50).
 */
export async function getLikedTracks(accessToken) {
  const tracks = [];
  let url = "https://api.spotify.com/v1/me/tracks?limit=50";

  while (url) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) break;
    const data = await res.json();
    const page = (data.items || [])
      .filter((item) => item.track?.id)
      .map((item) => ({
        id: item.track.id,
        name: item.track.name,
        uri: item.track.uri,
        artists: item.track.artists.map((a) => a.name).join(", "),
        durationMs: item.track.duration_ms,
        albumArt: item.track.album.images?.[0]?.url ?? null,
      }));
    tracks.push(...page);
    url = data.next ?? null;
  }

  return tracks;
}

/**
 * Fetch all of the user's playlists, paginating through every page.
 */
export async function getUserPlaylists(accessToken) {
  const playlists = [];
  let url = "https://api.spotify.com/v1/me/playlists";

  while (url) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn("[getUserPlaylists] failed", res.status, body);
      if (res.status === 401) throw new Error("TOKEN_EXPIRED");
      break;
    }
    const data = await res.json();
    (data.items || [])
      .filter((p) => p && p.id && p.owner?.id !== "spotify")
      .forEach((p) => {
        playlists.push({
          id: p.id,
          name: p.name,
          trackCount: p.tracks?.total ?? 0,
          coverArt: p.images?.[0]?.url ?? null,
        });
      });
    url = data.next ?? null;
  }

  return playlists;
}

/**
 * Fetch all tracks for a playlist, paginating through every page.
 */
export async function getPlaylistTracks(accessToken, playlistId) {
  const tracks = [];
  let url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks`;

  while (url) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn("[getPlaylistTracks] failed", playlistId, res.status, body);
      if (res.status === 401) throw new Error("TOKEN_EXPIRED");
      if (res.status === 403) return { tracks: [], forbidden: true };
      break;
    }
    const data = await res.json();
    (data.items || [])
      .filter((item) => item.track?.id)
      .forEach((item) => {
        tracks.push({
          id: item.track.id,
          name: item.track.name,
          uri: item.track.uri,
          artists: item.track.artists.map((a) => a.name).join(", "),
          durationMs: item.track.duration_ms,
          albumArt: item.track.album?.images?.[0]?.url ?? null,
        });
      });
    url = data.next ?? null;
  }

  return { tracks, forbidden: false };
}

/**
 * Search all of Spotify for tracks matching a query.
 */
export async function searchTracks(accessToken, query) {
  if (!query) return [];
  const params = new URLSearchParams({ q: query, type: "track" });
  const res = await fetch(
    `https://api.spotify.com/v1/search?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.warn("[searchTracks] failed", res.status, body);
    if (res.status === 401) throw new Error("TOKEN_EXPIRED");
    return [];
  }
  const data = await res.json();
  return (data.tracks?.items || [])
    .filter(Boolean)
    .map((t) => ({
      id: t.id,
      name: t.name,
      uri: t.uri,
      artists: t.artists.map((a) => a.name).join(", "),
      durationMs: t.duration_ms,
      albumArt: t.album.images?.[0]?.url ?? null,
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
