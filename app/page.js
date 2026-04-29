"use client";

import { startTransition, useCallback, useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  playSnippet,
  getPlayerState,
  getUserPlaylists,
  getPlaylistTracks,
  getLikedTracks,
  getRecentlyPlayed,
  setShuffle,
  setRepeatMode,
  skipToNext,
  skipToPrevious,
  getQueue,
  pausePlayback,
  resumePlayback,
  setVolume,
  seekToPosition,
  getDevices,
  transferPlayback,
  searchTracks,
} from "../lib/snippet";
import {
  fetchAllTimestamps,
  saveTimestamp,
  deleteTimestamp,
  updateTimestamp,
  formatMs,
} from "../lib/timestamps";

const STORAGE_KEY = "spotify_access_token";
const STORAGE_REFRESH = "spotify_refresh_token";
const STORAGE_EXPIRES = "spotify_token_expires_at";
const STORAGE_SNIPPET_MODE = "snippet_playback_mode";
const MAX_SNIPPETS_PER_TRACK = 3;

function getStoredToken() {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(STORAGE_KEY);
}

function getStoredRefreshToken() {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(STORAGE_REFRESH);
}

function getStoredExpiry() {
  if (typeof window === "undefined") return null;
  const v = localStorage.getItem(STORAGE_EXPIRES);
  return v ? Number(v) : null;
}

function getNativeSpotifyBridge() {
  if (typeof window === "undefined") return null;
  const capacitor = window.Capacitor;
  const isNative =
    typeof capacitor?.isNativePlatform === "function"
      ? capacitor.isNativePlatform()
      : false;
  if (!isNative) return null;
  return capacitor?.Plugins?.SpotifyBridge ?? null;
}

function polarToCartesian(cx, cy, r, angleDeg) {
  const angleRad = ((angleDeg - 90) * Math.PI) / 180;
  return {
    x: cx + r * Math.cos(angleRad),
    y: cy + r * Math.sin(angleRad),
  };
}

function describeArcPath(cx, cy, r, startAngleDeg, endAngleDeg) {
  const start = polarToCartesian(cx, cy, r, startAngleDeg);
  const end = polarToCartesian(cx, cy, r, endAngleDeg);
  const angleDiff = ((endAngleDeg - startAngleDeg) % 360 + 360) % 360;
  const largeArcFlag = angleDiff > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArcFlag} 1 ${end.x} ${end.y}`;
}

function trackFromPlayerSnapshot(state) {
  if (!state?.id || !state?.uri) return null;
  return {
    id: state.id,
    name: state.name,
    uri: state.uri,
    artists: state.artists,
    albumArt: state.albumArt,
    durationMs: state.durationMs,
  };
}

function ThemedLoader({ size = 1, label = null, inline = false }) {
  const clipId = useId().replace(/:/g, "");
  return (
    <div
      style={{
        display: "flex",
        flexDirection: inline ? "row" : "column",
        alignItems: "center",
        justifyContent: "center",
        gap: inline ? "0.65rem" : "0.9rem",
      }}
      role="status"
      aria-live="polite"
    >
      <div className="snippet-loader" style={{ "--size": size }}>
        <div className="box" style={{ mask: `url(#${clipId})`, WebkitMask: `url(#${clipId})` }} />
        <svg width="0" height="0" aria-hidden="true">
          <defs>
            <mask id={clipId}>
              <g className="snippet-loader-clipping">
                <polygon points="50,10 62,38 90,50 62,62 50,90 38,62 10,50 38,38" fill="white" />
                <polygon points="50,2 66,34 98,50 66,66 50,98 34,66 2,50 34,34" fill="white" />
                <polygon points="50,8 60,30 84,40 66,58 58,82 40,68 16,60 30,38" fill="white" />
                <polygon points="50,18 72,34 82,56 62,74 42,78 24,58 28,34" fill="white" />
                <polygon points="50,12 70,24 78,48 70,74 44,86 24,70 20,42" fill="white" />
                <polygon points="50,16 64,28 72,48 64,70 44,80 28,64 24,40" fill="white" />
                <polygon points="50,22 60,34 66,50 60,68 44,74 34,62 30,44" fill="white" />
              </g>
            </mask>
          </defs>
        </svg>
      </div>
      {label ? <span style={{ color: "#a99bb9", fontSize: "0.8rem" }}>{label}</span> : null}
    </div>
  );
}

export default function Home() {
  const [token, setToken] = useState(null);
  const [hydrated, setHydrated] = useState(false);
  const [urlError, setUrlError] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const [activeTab, setActiveTab] = useState("home");
  const [pressedTab, setPressedTab] = useState(null);

  // Web Playback SDK — browser is the Spotify device
  const [webPlayerId, setWebPlayerId] = useState(null);
  const webPlayerIdRef = useRef(null);
  const sdkPlayerRef = useRef(null);
  const [webPlayerError, setWebPlayerError] = useState(null);

  // Device selection fallback (when SDK isn't available)
  const [devices, setDevices] = useState([]);
  const [deviceId, setDeviceId] = useState(null);
  const [loadingDevices, setLoadingDevices] = useState(false);

  // Now Playing
  const [playerState, setPlayerState] = useState(null);
  const [previousPlayerTrack, setPreviousPlayerTrack] = useState(null);
  const [labelInput, setLabelInput] = useState("");
  const [estimatedPos, setEstimatedPos] = useState(0);
  const lastPollRef = useRef(null);
  const lastPlayerTrackIdRef = useRef(null);
  const isSeekingRef = useRef(false);
  const modalRingSeekRef = useRef({ active: false });

  // All timestamps for the logged-in user, keyed by trackId
  const [allTimestamps, setAllTimestamps] = useState({});

  // Library
  const [playlists, setPlaylists] = useState([]);
  const [openPlaylistId, setOpenPlaylistId] = useState(null);
  const [playlistTracks, setPlaylistTracks] = useState({}); // playlistId → track[]
  const [loadingPlaylistId, setLoadingPlaylistId] = useState(null);
  const [playlistErrors, setPlaylistErrors] = useState({});

  // Liked Songs
  const [likedOpen, setLikedOpen] = useState(false);
  const [likedTracks, setLikedTracks] = useState(null); // null = not yet loaded
  const [recentlyPlayedTracks, setRecentlyPlayedTracks] = useState([]);

  // Track detail modal
  const [selectedTrack, setSelectedTrack] = useState(null);
  const [queueTracks, setQueueTracks] = useState([]);

  // Snippet editing
  const [editingSnippet, setEditingSnippet] = useState(null); // { trackId, index, label }
  const [editLabel, setEditLabel] = useState("");
  const [selectedSnippetIndexByTrack, setSelectedSnippetIndexByTrack] = useState({});
  const [openSnippetTracks, setOpenSnippetTracks] = useState({});
  const [snippetModeEnabled, setSnippetModeEnabled] = useState(false);
  const [snippetsOpen, setSnippetsOpen] = useState(true);
  const [playlistsOpen, setPlaylistsOpen] = useState(false);
  const [recentlyPlayedOpen, setRecentlyPlayedOpen] = useState(false);
  const [modalClipPressed, setModalClipPressed] = useState(false);
  const [modalClipSaved, setModalClipSaved] = useState(false);
  const [modalClipNotice, setModalClipNotice] = useState("");
  const [modalMenuOpen, setModalMenuOpen] = useState(false);
  const [modalMenuSnippetsOpen, setModalMenuSnippetsOpen] = useState(false);

  // Spotify global search
  const [spotifyResults, setSpotifyResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const nativeSpotifyBridge = getNativeSpotifyBridge();
  const isNativeApp = Boolean(nativeSpotifyBridge);

  useEffect(() => {
    webPlayerIdRef.current = webPlayerId;
  }, [webPlayerId]);

  // ── Token refresh ───────────────────────────────────────────────────────────

  const doRefresh = useCallback(async () => {
    const refreshToken = getStoredRefreshToken();
    if (!refreshToken) return null;

    const res = await fetch("/api/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    if (!res.ok) {
      console.warn("[doRefresh] refresh failed", res.status);
      return null;
    }

    const data = await res.json();
    const newToken = data.access_token;
    const expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;

    localStorage.setItem(STORAGE_KEY, newToken);
    localStorage.setItem(STORAGE_EXPIRES, String(expiresAt));
    if (data.refresh_token) {
      localStorage.setItem(STORAGE_REFRESH, data.refresh_token);
    }

    setToken(newToken);
    console.log("[doRefresh] token refreshed, expires in", data.expires_in, "s");
    return newToken;
  }, []);

  const withFreshToken = useCallback(
    async (requestFn) => {
      let currentToken = getStoredToken();
      if (!currentToken) return null;

      try {
        return await requestFn(currentToken);
      } catch (err) {
        if (err.message !== "TOKEN_EXPIRED") throw err;
        const newToken = await doRefresh();
        if (!newToken) return null;
        return requestFn(newToken);
      }
    },
    [doRefresh]
  );

  const refreshPlayerSnapshot = useCallback(async () => {
    const t = getStoredToken();
    if (!t) return { state: null, queue: [] };
    const [state, queue] = await Promise.all([
      withFreshToken((accessToken) => getPlayerState(accessToken)).catch(() => null),
      withFreshToken((accessToken) => getQueue(accessToken)).catch(() => []),
    ]);
    if (state) {
      setPlayerState(state);
      if (!isSeekingRef.current) {
        setEstimatedPos(state.positionMs);
      }
      lastPollRef.current = {
        time: Date.now(),
        positionMs: state.positionMs,
        isPlaying: state.isPlaying,
      };
    }
    setQueueTracks(queue || []);
    return { state, queue: queue || [] };
  }, [withFreshToken]);

  // Proactive refresh: fire 5 minutes before expiry
  useEffect(() => {
    if (!token) return;
    const expiry = getStoredExpiry();
    if (!expiry) return;

    const msUntilRefresh = expiry - Date.now() - 5 * 60 * 1000;
    if (msUntilRefresh <= 0) {
      doRefresh();
      return;
    }

    const id = setTimeout(() => doRefresh(), msUntilRefresh);
    return () => clearTimeout(id);
  }, [token, doRefresh]);

  // ── Init ────────────────────────────────────────────────────────────────────

  useEffect(() => {
    setHydrated(true);
    const t = getStoredToken();
    setToken(t);
    if (t) setUrlError(null);
    const storedSnippetMode = localStorage.getItem(STORAGE_SNIPPET_MODE);
    if (storedSnippetMode === "true") setSnippetModeEnabled(true);

    const params = new URLSearchParams(window.location.search);
    const err = params.get("error");
    const detail = params.get("detail");
    if (err) {
      if (!t) setUrlError(detail || err);
      window.history.replaceState({}, "", "/");
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    localStorage.setItem(STORAGE_SNIPPET_MODE, String(snippetModeEnabled));
  }, [snippetModeEnabled]);

  // ── Web Playback SDK ────────────────────────────────────────────────────────

  useEffect(() => {
    if (!token || typeof window === "undefined") return;

    const initPlayer = () => {
      if (!window.Spotify || sdkPlayerRef.current) return;
      const player = new window.Spotify.Player({
        name: "Snippet",
        getOAuthToken: (cb) => cb(getStoredToken()),
        volume: 0.8,
      });
      player.addListener("ready", ({ device_id }) => {
        console.log("[webPlayer] ready", device_id);
        setWebPlayerError(null);
        setWebPlayerId(device_id);
      });
      player.addListener("not_ready", ({ device_id }) => {
        console.warn("[webPlayer] not_ready", device_id);
        setWebPlayerId(null);
      });
      player.addListener("initialization_error", ({ message }) => {
        console.warn("[webPlayer] initialization_error", message);
        setWebPlayerError({
          type: "initialization_error",
          message,
        });
      });
      player.addListener("authentication_error", ({ message }) => {
        console.warn("[webPlayer] authentication_error", message);
        setWebPlayerError({
          type: "authentication_error",
          message,
        });
      });
      player.addListener("account_error", ({ message }) => {
        console.warn("[webPlayer] account_error", message);
        setWebPlayerError({
          type: "account_error",
          message,
        });
      });
      player.addListener("playback_error", ({ message }) => {
        console.warn("[webPlayer] playback_error", message);
        setWebPlayerError({
          type: "playback_error",
          message,
        });
      });
      player.connect();
      sdkPlayerRef.current = player;
    };

    if (window.Spotify) {
      initPlayer();
    } else {
      window.onSpotifyWebPlaybackSDKReady = initPlayer;
      if (!document.querySelector('script[src="https://sdk.scdn.co/spotify-player.js"]')) {
        const script = document.createElement("script");
        script.src = "https://sdk.scdn.co/spotify-player.js";
        script.async = true;
        document.body.appendChild(script);
      }
    }

    return () => {
      if (sdkPlayerRef.current) {
        sdkPlayerRef.current.disconnect();
        sdkPlayerRef.current = null;
        setWebPlayerId(null);
      }
    };
  }, [token]);

  // ── Spotify polling ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (!token) return;
    const poll = async () => {
      const state = await withFreshToken((accessToken) => getPlayerState(accessToken)).catch((err) => {
        console.warn("[playerPoll] failed", err);
        return null;
      });
      if (state) {
        setPlayerState(state);
        if (!isSeekingRef.current) {
          setEstimatedPos(state.positionMs);
        }
        lastPollRef.current = {
          time: Date.now(),
          positionMs: state.positionMs,
          isPlaying: state.isPlaying,
        };
      } else {
        setPlayerState(null);
        lastPollRef.current = null;
      }
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => clearInterval(id);
  }, [token, withFreshToken]);

  // Fetch available devices whenever playerState is null (nothing active)
  const fetchDevices = useCallback(async () => {
    if (isNativeApp) return;
    const t = getStoredToken();
    if (!t) return;
    setLoadingDevices(true);
    try {
      const list = await withFreshToken((accessToken) => getDevices(accessToken)).catch((err) => {
        console.warn("[devices] failed to load", err);
        return [];
      });
      setDevices(list || []);
      if ((list || []).length === 1 && !deviceId) setDeviceId(list[0].id);
    } finally {
      setLoadingDevices(false);
    }
  }, [deviceId, isNativeApp, withFreshToken]);

  // Initial fetch + auto-poll every 5s while nothing is playing
  useEffect(() => {
    if (!token || playerState) return;
    fetchDevices();
    const id = setInterval(fetchDevices, 5000);
    return () => clearInterval(id);
  }, [token, playerState]);

  useEffect(() => {
    if (!token || !playerState) {
      setQueueTracks([]);
      return;
    }
    const loadQueue = async () => {
      const tracks = await withFreshToken((accessToken) => getQueue(accessToken))
        .catch((err) => {
          console.warn("[queue] failed to load", err);
          return [];
        });
      setQueueTracks(tracks || []);
    };
    loadQueue();
    const id = setInterval(loadQueue, 5000);
    return () => clearInterval(id);
  }, [token, playerState?.id, withFreshToken]);

  useEffect(() => {
    if (!playerState?.id) return;
    if (lastPlayerTrackIdRef.current && lastPlayerTrackIdRef.current !== playerState.id) {
      const priorTrack = trackLookup[lastPlayerTrackIdRef.current];
      if (priorTrack) {
        setPreviousPlayerTrack(priorTrack);
      }
    }
    lastPlayerTrackIdRef.current = playerState.id;
  }, [playerState?.id]);

  // Smooth position estimate between polls
  useEffect(() => {
    const id = setInterval(() => {
      if (isSeekingRef.current) return;
      if (!lastPollRef.current?.isPlaying) return;
      const elapsed = Date.now() - lastPollRef.current.time;
      setEstimatedPos(lastPollRef.current.positionMs + elapsed);
    }, 100);
    return () => clearInterval(id);
  }, []);

  // ── Timestamps (DB) ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (!token) { setAllTimestamps({}); return; }
    fetchAllTimestamps(token).then(setAllTimestamps);
  }, [token]);

  // ── Library ─────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!token || playlists.length > 0) return;
    withFreshToken((accessToken) => getUserPlaylists(accessToken))
      .then((items) => {
        if (items) {
          startTransition(() => setPlaylists(items));
        }
      })
      .catch((err) => console.warn("[playlists] failed to load", err));
  }, [token, playlists.length, withFreshToken]);

  useEffect(() => {
    if (!token || likedTracks !== null) return;
    withFreshToken((accessToken) => getLikedTracks(accessToken))
      .then((tracks) => {
        if (tracks) {
          startTransition(() => setLikedTracks(tracks));
        }
      })
      .catch((err) => console.warn("[likedTracks] failed to load", err));
  }, [token, likedTracks, withFreshToken]);

  useEffect(() => {
    if (!token) {
      setRecentlyPlayedTracks([]);
      return;
    }
    withFreshToken((accessToken) => getRecentlyPlayed(accessToken))
      .then((tracks) => {
        if (tracks) {
          startTransition(() => setRecentlyPlayedTracks(tracks));
        }
      })
      .catch((err) => console.warn("[recentlyPlayed] failed to load", err));
  }, [token, withFreshToken]);

  // Spotify global search — fires when on Search tab, debounced 350ms
  useEffect(() => {
    if (activeTab !== "search" || !deferredSearchQuery) {
      setSpotifyResults([]);
      setSearchLoading(false);
      return;
    }
    setSearchLoading(true);
    const id = setTimeout(async () => {
      try {
        let t = getStoredToken();
        if (!t) { setSearchLoading(false); return; }
        let results = await searchTracks(t, deferredSearchQuery);
        startTransition(() => setSpotifyResults(results));
      } catch (err) {
        if (err.message === "TOKEN_EXPIRED") {
          const newToken = await doRefresh();
          if (newToken) {
            const results = await searchTracks(newToken, deferredSearchQuery).catch(() => []);
            startTransition(() => setSpotifyResults(results));
          }
        }
      } finally {
        setSearchLoading(false);
      }
    }, 350);
    return () => clearTimeout(id);
  }, [deferredSearchQuery, activeTab, doRefresh]);

  // When searching, eagerly load liked tracks and all playlist tracks
  useEffect(() => {
    if (!searchQuery) return;
    if (likedTracks === null) {
        withFreshToken((accessToken) => getLikedTracks(accessToken))
          .then((tracks) => {
            if (tracks) {
              startTransition(() => setLikedTracks(tracks));
            }
          })
        .catch((err) => console.warn("[likedTracks] failed to load", err));
    }
    playlists.forEach((pl) => {
      if (!playlistTracks[pl.id]) {
        withFreshToken((accessToken) => getPlaylistTracks(accessToken, pl.id))
          .then((result) => {
            if (!result) return;
            startTransition(() => {
              setPlaylistTracks((prev) => ({ ...prev, [pl.id]: result.tracks }));
            });
            if (result.forbidden) {
              setPlaylistErrors((prev) => ({
                ...prev,
                [pl.id]: "This playlist can't be accessed. It may be private or managed by Spotify.",
              }));
            }
          })
          .catch((err) => console.warn("[playlistTracks] failed to preload", pl.id, err));
      }
    });
  }, [searchQuery, playlists, likedTracks, playlistTracks, withFreshToken]);

  const handleToggleLiked = useCallback(async () => {
    setLikedOpen((o) => !o);
    if (likedTracks !== null) return; // already loaded
    const tracks = await withFreshToken((accessToken) => getLikedTracks(accessToken)).catch((err) => {
      console.warn("[likedTracks] failed to toggle-load", err);
      return null;
    });
    if (tracks) setLikedTracks(tracks);
  }, [likedTracks, withFreshToken]);

  const handleTogglePlaylist = useCallback(
    async (playlistId) => {
      if (openPlaylistId === playlistId) {
        setOpenPlaylistId(null);
        return;
      }
      setOpenPlaylistId(playlistId);
      if (playlistTracks[playlistId]) return; // already cached
      setLoadingPlaylistId(playlistId);
      try {
        const result = await withFreshToken((accessToken) => getPlaylistTracks(accessToken, playlistId))
          .catch((err) => {
            console.warn("[playlistTracks] failed to load", playlistId, err);
            return null;
          });
        if (result) {
          startTransition(() => {
            setPlaylistTracks((prev) => ({ ...prev, [playlistId]: result.tracks }));
          });
          if (result.forbidden) {
            setPlaylistErrors((prev) => ({ ...prev, [playlistId]: "This playlist can't be accessed. It may be private or managed by Spotify." }));
          }
        }
      } finally {
        setLoadingPlaylistId(null);
      }
    },
    [openPlaylistId, playlistTracks, withFreshToken]
  );

  // ── Playback ─────────────────────────────────────────────────────────────────

  const ensureBrowserPlaybackDevice = useCallback(async () => {
    if (isNativeApp || typeof window === "undefined") return null;
    if (webPlayerIdRef.current) return webPlayerIdRef.current;

    if (window.Spotify && !sdkPlayerRef.current) {
      window.onSpotifyWebPlaybackSDKReady?.();
    }

    const waitUntil = Date.now() + 3500;
    while (!webPlayerIdRef.current && Date.now() < waitUntil) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    if (webPlayerIdRef.current) return webPlayerIdRef.current;

    const t = getStoredToken();
    if (!t) return null;
    const list = await withFreshToken((accessToken) => getDevices(accessToken)).catch((err) => {
      console.warn("[ensureBrowserPlaybackDevice] failed", err);
      return [];
    });
    const snippetDevice =
      list.find((device) => device.name === "Snippet") ??
      list.find((device) => device.id === webPlayerIdRef.current) ??
      null;
    if (snippetDevice) {
      setDeviceId(snippetDevice.id);
      return snippetDevice.id;
    }

    return null;
  }, [isNativeApp, withFreshToken]);

  const jump = useCallback(async (trackOrUri, positionMs, playbackContext = null) => {
    const trackUri = typeof trackOrUri === "string" ? trackOrUri : trackOrUri?.uri;
    const contextSource =
      typeof trackOrUri === "object" && trackOrUri
        ? trackOrUri
        : playbackContext;
    if (!trackUri || trackUri.startsWith("spotify:local:")) return;
    const nativeSpotifyBridge = getNativeSpotifyBridge();
    if (nativeSpotifyBridge?.connectAndPlay) {
      try {
        await nativeSpotifyBridge.connectAndPlay({ uri: trackUri, positionMs });
        lastPollRef.current = { time: Date.now(), positionMs, isPlaying: true };
        setEstimatedPos(positionMs);
        return;
      } catch (err) {
        const message = String(err?.message || err || "");
        console.warn("[nativeSpotifyBridge.connectAndPlay] failed", message);
        if (message.includes("SPOTIFY_NOT_INSTALLED")) {
          alert("Open the Spotify app on this phone first, then try again.");
          return;
        }
        if (message.includes("SPOTIFY_NOT_PREMIUM")) {
          alert("Spotify Premium is required for playback control.");
          return;
        }
      }
    }

    const t = getStoredToken();
    if (!t) return;
    const browserDeviceId = await ensureBrowserPlaybackDevice();
    // Always prefer the device running this app before falling back to Spotify's active player.
    const targetDevice = browserDeviceId || webPlayerIdRef.current || deviceId || null;
    if ((browserDeviceId || webPlayerIdRef.current) && sdkPlayerRef.current?.activateElement) {
      try {
        await sdkPlayerRef.current.activateElement();
      } catch (err) {
        console.warn("[webPlayer.activateElement] failed", err);
      }
    }
    if (browserDeviceId || webPlayerIdRef.current) {
      try {
        await transferPlayback(t, browserDeviceId || webPlayerIdRef.current, false);
      } catch (err) {
        console.warn("[transferPlayback] failed", err);
      }
    }
    const request = {
      trackUri,
      positionMs,
      deviceId: targetDevice,
      contextUri: contextSource?.contextUri ?? null,
      offsetUri: contextSource?.offsetUri ?? null,
      offsetPosition: contextSource?.offsetPosition,
    };
    const res = await playSnippet(t, request);
    if (res.status === 204 || res.ok) {
      lastPollRef.current = { time: Date.now(), positionMs, isPlaying: true };
      setEstimatedPos(positionMs);
      return;
    }
    if (res.status === 401) {
      const newToken = await doRefresh();
      if (!newToken) {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(STORAGE_REFRESH);
        localStorage.removeItem(STORAGE_EXPIRES);
        setToken(null);
        return;
      }
      // Retry once with the new token
      if (browserDeviceId || webPlayerIdRef.current) {
        try {
          await transferPlayback(newToken, browserDeviceId || webPlayerIdRef.current, false);
        } catch (err) {
          console.warn("[transferPlayback retry] failed", err);
        }
      }
      const retry = await playSnippet(newToken, request);
      if (retry.status === 204 || retry.ok) {
        lastPollRef.current = { time: Date.now(), positionMs, isPlaying: true };
        setEstimatedPos(positionMs);
      }
      return;
    }
    if (res.status === 404) {
      setDeviceId(null);
      fetchDevices();
      return;
    }
    if (res.status === 403) {
      alert("Spotify Premium is required for playback control.");
    }
  }, [deviceId, doRefresh, ensureBrowserPlaybackDevice, fetchDevices]);

  // ── Volume (local optimistic state) ─────────────────────────────────────────

  const [volume, setVolumeState] = useState(null);

  // Sync volume from player state on first load and when it changes externally
  useEffect(() => {
    if (playerState?.volumePercent != null && volume === null) {
      setVolumeState(playerState.volumePercent);
    }
  }, [playerState?.volumePercent, volume]);

  const handlePlayPause = useCallback(async () => {
    if (!playerState) return;
    const nativeSpotifyBridge = getNativeSpotifyBridge();
    if (nativeSpotifyBridge) {
      if (playerState.isPlaying && nativeSpotifyBridge.pause) {
        await nativeSpotifyBridge.pause().catch((err) => {
          console.warn("[nativeSpotifyBridge.pause] failed", err);
        });
      } else if (!playerState.isPlaying && nativeSpotifyBridge.resume) {
        await nativeSpotifyBridge.resume().catch((err) => {
          console.warn("[nativeSpotifyBridge.resume] failed", err);
        });
      }
    } else {
      const t = getStoredToken();
      if (!t) return;
      if (playerState.isPlaying) {
        await pausePlayback(t);
      } else {
        await resumePlayback(t);
      }
    }
    if (playerState.isPlaying) {
      setPlayerState((prev) => prev ? { ...prev, isPlaying: false } : prev);
      if (lastPollRef.current) lastPollRef.current.isPlaying = false;
    } else {
      setPlayerState((prev) => prev ? { ...prev, isPlaying: true } : prev);
      if (lastPollRef.current) {
        lastPollRef.current.isPlaying = true;
        lastPollRef.current.time = Date.now();
      }
    }
  }, [playerState]);

  const handleSeekChange = useCallback((e) => {
    isSeekingRef.current = true;
    setEstimatedPos(Number(e.target.value));
  }, []);

  const handleSeekCommit = useCallback(async (e) => {
    const posMs = Number(e.target.value);
    const nativeSpotifyBridge = getNativeSpotifyBridge();
    if (nativeSpotifyBridge?.seek) {
      await nativeSpotifyBridge.seek({ positionMs: posMs }).catch((err) => {
        console.warn("[nativeSpotifyBridge.seek] failed", err);
      });
    } else {
      const t = getStoredToken();
      if (t) await seekToPosition(t, posMs);
    }
    if (lastPollRef.current) {
      lastPollRef.current.positionMs = posMs;
      lastPollRef.current.time = Date.now();
    }
    isSeekingRef.current = false;
  }, []);

  const commitSeekPosition = useCallback(async (posMs) => {
    const clamped = Math.max(0, Math.floor(posMs));
    const nativeSpotifyBridge = getNativeSpotifyBridge();
    if (nativeSpotifyBridge?.seek) {
      await nativeSpotifyBridge.seek({ positionMs: clamped }).catch((err) => {
        console.warn("[nativeSpotifyBridge.seek] failed", err);
      });
    } else {
      const t = getStoredToken();
      if (t) await seekToPosition(t, clamped);
    }
    if (lastPollRef.current) {
      lastPollRef.current.positionMs = clamped;
      lastPollRef.current.time = Date.now();
    }
    setEstimatedPos(clamped);
    isSeekingRef.current = false;
  }, []);

  const readRingSeekPosition = useCallback((event, durationMs) => {
    const svg = event.currentTarget;
    const rect = svg.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const dx = x - cx;
    const dy = y - cy;
    const angle = Math.atan2(dy, dx) * (180 / Math.PI);
    const normalized = (angle + 360 + 90) % 360;
    const progress = normalized / 360;
    return progress * Math.max(durationMs || 1, 1);
  }, []);

  const handleModalRingPointerDown = useCallback((event, durationMs) => {
    if (!durationMs) return;
    modalRingSeekRef.current.active = true;
    isSeekingRef.current = true;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    setEstimatedPos(readRingSeekPosition(event, durationMs));
  }, [readRingSeekPosition]);

  const handleModalRingPointerMove = useCallback((event, durationMs) => {
    if (!modalRingSeekRef.current.active || !durationMs) return;
    setEstimatedPos(readRingSeekPosition(event, durationMs));
  }, [readRingSeekPosition]);

  const handleModalRingPointerUp = useCallback(async (event, durationMs) => {
    if (!modalRingSeekRef.current.active || !durationMs) return;
    modalRingSeekRef.current.active = false;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    await commitSeekPosition(readRingSeekPosition(event, durationMs));
  }, [commitSeekPosition, readRingSeekPosition]);

  const handleVolumeChange = useCallback(async (e) => {
    const vol = Number(e.target.value);
    setVolumeState(vol);
    const t = getStoredToken();
    if (!t) return;
    await setVolume(t, vol);
  }, []);

  // ── Timestamps ───────────────────────────────────────────────────────────────

  const handleShuffle = useCallback(async () => {
    const t = getStoredToken();
    if (!t || !playerState) return;
    const next = !playerState.shuffle;
    await setShuffle(t, next);
    setPlayerState((prev) => prev ? { ...prev, shuffle: next } : prev);
    setTimeout(() => refreshPlayerSnapshot(), 250);
  }, [playerState, refreshPlayerSnapshot]);

  const playbackTargetDevice = webPlayerId || deviceId || null;

  const transitionIntoSnippetIfNeeded = useCallback(async ({ previousTrackId = null, startPlayback }) => {
    const restoreVolumePercent =
      snippetModeEnabled && Number.isFinite(playerState?.volumePercent)
        ? playerState.volumePercent
        : null;
    const shouldMuteTransition = restoreVolumePercent != null;

    if (shouldMuteTransition) {
      await withFreshToken((accessToken) => setVolume(accessToken, 0)).catch(() => null);
    }

    try {
      await startPlayback();

      let nextState = null;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const snapshot = await refreshPlayerSnapshot();
        nextState = snapshot?.state ?? null;
        if (nextState?.id && (!previousTrackId || nextState.id !== previousTrackId)) break;
        await new Promise((resolve) => setTimeout(resolve, 180));
      }

      if (!nextState?.id || !snippetModeEnabled) return;

      const snippets = allTimestamps[nextState.id] || [];
      const selectedIndex = Math.min(
        selectedSnippetIndexByTrack[nextState.id] ?? 0,
        Math.max(0, snippets.length - 1)
      );
      const snippetPositionMs = snippets[selectedIndex]?.positionMs ?? 0;
      if (snippetPositionMs <= 0) return;

      await withFreshToken((accessToken) => seekToPosition(accessToken, snippetPositionMs)).catch(() => null);

      setPlayerState((prev) => (
        prev && prev.id === nextState.id
          ? { ...prev, positionMs: snippetPositionMs }
          : prev
      ));
      lastPollRef.current = {
        time: Date.now(),
        positionMs: snippetPositionMs,
        isPlaying: true,
      };
      setEstimatedPos(snippetPositionMs);
    } finally {
      if (shouldMuteTransition) {
        await withFreshToken((accessToken) => setVolume(accessToken, restoreVolumePercent)).catch(() => null);
        setPlayerState((prev) => (prev ? { ...prev, volumePercent: restoreVolumePercent } : prev));
      }
      setTimeout(() => refreshPlayerSnapshot(), 250);
    }
  }, [
    allTimestamps,
    playerState?.volumePercent,
    refreshPlayerSnapshot,
    selectedSnippetIndexByTrack,
    snippetModeEnabled,
    withFreshToken,
  ]);

  const handleRepeatCycle = useCallback(async () => {
    const t = getStoredToken();
    if (!t || !playerState) return;
    const nextRepeatMode =
      playerState.repeatMode === "off"
        ? "context"
        : playerState.repeatMode === "context"
          ? "track"
          : "off";
    await setRepeatMode(t, nextRepeatMode, playbackTargetDevice);
    setPlayerState((prev) => prev ? { ...prev, repeatMode: nextRepeatMode } : prev);
    setTimeout(() => refreshPlayerSnapshot(), 250);
  }, [playerState, playbackTargetDevice, refreshPlayerSnapshot]);

  const handleSkipNext = useCallback(async () => {
    const t = getStoredToken();
    if (!t) return;
    await transitionIntoSnippetIfNeeded({
      previousTrackId: playerState?.id ?? null,
      startPlayback: () => skipToNext(t, playbackTargetDevice),
    });
  }, [playbackTargetDevice, playerState?.id, transitionIntoSnippetIfNeeded]);

  const handleSkipPrevious = useCallback(async () => {
    const t = getStoredToken();
    if (!t) return;
    await skipToPrevious(t, playbackTargetDevice);
    setTimeout(() => refreshPlayerSnapshot(), 350);
  }, [playbackTargetDevice, refreshPlayerSnapshot]);

  const handleQuickPlayPlaylist = useCallback(async (playlist) => {
    const t = getStoredToken();
    if (!t || !playlist?.id) return;
    const browserDeviceId = await ensureBrowserPlaybackDevice();
    const targetDevice = browserDeviceId || webPlayerIdRef.current || deviceId || null;
    if ((browserDeviceId || webPlayerIdRef.current) && sdkPlayerRef.current?.activateElement) {
      try {
        await sdkPlayerRef.current.activateElement();
      } catch (err) {
        console.warn("[webPlayer.activateElement] failed", err);
      }
    }
    if (browserDeviceId || webPlayerIdRef.current) {
      try {
        await transferPlayback(t, browserDeviceId || webPlayerIdRef.current, false);
      } catch (err) {
        console.warn("[transferPlayback] failed", err);
      }
    }

    await transitionIntoSnippetIfNeeded({
      previousTrackId: playerState?.id ?? null,
      startPlayback: async () => {
        await setShuffle(t, true);
        setPlayerState((prev) => prev ? { ...prev, shuffle: true } : prev);

        const request = {
          trackUri: `${playlist.uri}:seed`,
          positionMs: 0,
          deviceId: targetDevice,
          contextUri: playlist.uri ?? `spotify:playlist:${playlist.id}`,
        };

        const res = await playSnippet(t, request);
        if (res.status === 401) {
          const newToken = await doRefresh();
          if (!newToken) return;
          if (browserDeviceId || webPlayerIdRef.current) {
            try {
              await transferPlayback(newToken, browserDeviceId || webPlayerIdRef.current, false);
            } catch (err) {
              console.warn("[transferPlayback retry] failed", err);
            }
          }
          await setShuffle(newToken, true);
          await playSnippet(newToken, { ...request });
        }
      },
    });
  }, [deviceId, doRefresh, ensureBrowserPlaybackDevice, playerState?.id, transitionIntoSnippetIfNeeded]);

  const handleSaveTimestamp = useCallback(async () => {
    if (!playerState) return false;
    const t = getStoredToken();
    if (!t) return false;
    const label = labelInput.trim() || null;
    try {
      const updated = await saveTimestamp(t, playerState.id, Math.floor(estimatedPos), label);
      if (updated) {
        setAllTimestamps((prev) => ({ ...prev, [playerState.id]: updated }));
        setSelectedSnippetIndexByTrack((prev) => ({
          ...prev,
          [playerState.id]: updated.length - 1,
        }));
      }
      setLabelInput("");
      return true;
    } catch (err) {
      if (err.message === "MAX_SNIPPETS_REACHED") {
        alert(err.detail || `You can save up to ${MAX_SNIPPETS_PER_TRACK} snippets per song.`);
        return false;
      }
      console.warn("[saveTimestamp] failed", err);
      return false;
    }
  }, [playerState, estimatedPos, labelInput]);

  const handleModalClip = useCallback(async () => {
    const saved = await handleSaveTimestamp();
    if (!saved) {
      setModalClipNotice("Clip couldn't be saved");
      window.setTimeout(() => setModalClipNotice(""), 1200);
      return;
    }
    setModalClipSaved(true);
    setModalClipNotice(`Clip saved at ${formatMs(estimatedPos)}`);
    window.setTimeout(() => {
      setModalClipSaved(false);
      setModalClipNotice("");
    }, 1100);
  }, [estimatedPos, handleSaveTimestamp]);

  const handleSelectSnippet = useCallback((trackId, index) => {
    setSelectedSnippetIndexByTrack((prev) => ({ ...prev, [trackId]: index }));
  }, []);

  const handleToggleSnippetTrack = useCallback((trackId) => {
    setOpenSnippetTracks((prev) => ({
      ...prev,
      [trackId]: !prev[trackId],
    }));
  }, []);

  const resolvePlaybackPosition = useCallback((trackId, fallbackPositionMs = 0) => {
    if (!snippetModeEnabled || !trackId) return fallbackPositionMs;
    const snippets = allTimestamps[trackId] || [];
    if (snippets.length === 0) return fallbackPositionMs;
    const selectedIndex = Math.min(
      selectedSnippetIndexByTrack[trackId] ?? 0,
      Math.max(0, snippets.length - 1)
    );
    return snippets[selectedIndex]?.positionMs ?? fallbackPositionMs;
  }, [allTimestamps, selectedSnippetIndexByTrack, snippetModeEnabled]);

  const playTrackWithMode = useCallback((track) => {
    if (!track?.uri || !track?.id) return;
    jump(track, resolvePlaybackPosition(track.id, 0), track);
  }, [jump, resolvePlaybackPosition]);

  const handleDelete = useCallback(async (trackId, index) => {
    const t = getStoredToken();
    if (!t) return;
    const updated = await deleteTimestamp(t, trackId, index);
    setAllTimestamps((prev) => {
      const next = { ...prev };
      if (updated && updated.length > 0) {
        next[trackId] = updated;
      } else {
        delete next[trackId];
      }
      return next;
    });
    setSelectedSnippetIndexByTrack((prev) => {
      const current = prev[trackId] ?? 0;
      const next = { ...prev };
      if (!updated || updated.length === 0) {
        delete next[trackId];
        return next;
      }
      if (current === index) {
        next[trackId] = Math.max(0, Math.min(index, updated.length - 1));
        return next;
      }
      if (current > index) {
        next[trackId] = current - 1;
      }
      return next;
    });
  }, []);

  const handleUpdateTimestamp = useCallback(async (trackId, index, label) => {
    const t = getStoredToken();
    if (!t) return;
    const updated = await updateTimestamp(t, trackId, index, label);
    if (updated) {
      setAllTimestamps((prev) => ({ ...prev, [trackId]: updated }));
    }
    setEditingSnippet(null);
  }, []);

  // ── Auth ─────────────────────────────────────────────────────────────────────

  const goLogin = async () => {
    const { generateCodeVerifier, generateCodeChallenge } = await import("../lib/pkce-browser");
    const verifier = generateCodeVerifier();
    const challenge = await generateCodeChallenge(verifier);
    // Pass verifier as state — Spotify echoes it back in the callback URL,
    // so no cross-origin storage (sessionStorage/cookies) is needed.
    window.location.href = `/api/login?code_challenge=${encodeURIComponent(challenge)}&verifier=${encodeURIComponent(verifier)}`;
  };

  const handleLogout = () => {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(STORAGE_REFRESH);
    localStorage.removeItem(STORAGE_EXPIRES);
    setToken(null);
    setPlayerState(null);
    setPlaylists([]);
    setOpenPlaylistId(null);
    setPlaylistTracks({});
    setLikedTracks(null);
    setRecentlyPlayedTracks([]);
    setLikedOpen(false);

    lastPollRef.current = null;
  };

  const handleTabPress = useCallback((tab) => {
    setPressedTab(tab);
    setActiveTab(tab);
    setTimeout(() => setPressedTab(null), 150);
  }, []);

  const nowPlayingTimestamps = useMemo(
    () => (playerState ? (allTimestamps[playerState.id] || []) : []),
    [allTimestamps, playerState]
  );
  const selectedNowPlayingSnippetIndex = playerState
    ? Math.min(selectedSnippetIndexByTrack[playerState.id] ?? 0, Math.max(0, nowPlayingTimestamps.length - 1))
    : 0;
  const selectedNowPlayingSnippet = nowPlayingTimestamps[selectedNowPlayingSnippetIndex] ?? null;
  const flattenedPlaylistTracks = useMemo(
    () => Object.values(playlistTracks).flat(),
    [playlistTracks]
  );
  const trackLookup = useMemo(() => {
    const lookup = {};
    (likedTracks || []).forEach((t) => { lookup[t.id] = t; });
    flattenedPlaylistTracks.forEach((t) => { lookup[t.id] = t; });
    if (playerState) {
      lookup[playerState.id] = {
        id: playerState.id,
        name: playerState.name,
        uri: playerState.uri,
        artists: playerState.artists,
        albumArt: playerState.albumArt,
        durationMs: playerState.durationMs,
      };
    }
    return lookup;
  }, [flattenedPlaylistTracks, likedTracks, playerState]);
  const snippetTracks = useMemo(
    () => Object.entries(allTimestamps)
      .map(([trackId, tss]) => ({
        trackId,
        track: trackLookup[trackId] ?? null,
        tss,
        latestCreatedAt: Math.max(
          ...tss.map((ts) => {
            const created = ts.createdAt ? Date.parse(ts.createdAt) : 0;
            return Number.isNaN(created) ? 0 : created;
          })
        ),
      }))
      .sort((a, b) => b.latestCreatedAt - a.latestCreatedAt),
    [allTimestamps, trackLookup]
  );
  const recentPlaylists = useMemo(
    () => [...playlists].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [playlists]
  );
  const prioritizedPlaylists = useMemo(() => recentPlaylists.slice(0, 6), [recentPlaylists]);
  const remainingPlaylists = useMemo(() => recentPlaylists.slice(6), [recentPlaylists]);
  const prioritizedRecentlyPlayed = useMemo(() => recentlyPlayedTracks.slice(0, 6), [recentlyPlayedTracks]);
  const remainingRecentlyPlayed = useMemo(() => recentlyPlayedTracks.slice(6), [recentlyPlayedTracks]);
  const fallbackUpcomingTracks = useMemo(() => {
    for (const tracks of Object.values(playlistTracks)) {
      const currentIndex = tracks.findIndex((track) => track.id === selectedTrack?.id);
      if (currentIndex >= 0) {
        return tracks.slice(currentIndex + 1, currentIndex + 7);
      }
    }
    return [];
  }, [playlistTracks, selectedTrack?.id]);
  const browserPlaybackHelp = useMemo(() => {
    if (webPlayerId) {
      return {
        title: "This browser is ready for playback",
        body: "Snippet can play directly on this computer now.",
      };
    }
    if (webPlayerError?.type === "initialization_error") {
      return {
        title: "This browser can’t play Spotify locally",
        body:
          "Spotify’s browser player could not start here, so playback falls back to your phone or another active device. Open Snippet in full Chrome or Safari on this computer, or use the Spotify desktop app on this Mac.",
      };
    }
    if (webPlayerError?.type === "authentication_error") {
      return {
        title: "Spotify browser player couldn’t authenticate",
        body: "Log out and back in so Snippet can create a fresh browser playback device.",
      };
    }
    if (webPlayerError?.type === "account_error") {
      return {
        title: "Spotify Premium is required for browser playback",
        body: "Spotify only allows Web Playback SDK streaming for Premium accounts.",
      };
    }
    if (webPlayerError?.type === "playback_error") {
      return {
        title: "Spotify browser playback hit an error",
        body: webPlayerError.message || "Spotify rejected browser playback on this machine.",
      };
    }
    return {
      title: "Connect a playback device",
      body:
        "Snippet hasn’t been able to create its browser playback device on this machine yet, so Spotify is falling back to other active devices like your phone.",
    };
  }, [webPlayerError, webPlayerId]);

  const landingFeatures = [
    {
      title: "Skip to the best part",
      body: "Jump instantly to what matters",
    },
    {
      title: "Build highlight reels",
      body: "Save your favorite moments",
    },
    {
      title: "Bring your library with you",
      body: "Your playlists and songs carry over, so listening never restarts from scratch",
    },
    {
      title: "Built for real listening",
      body: "No more skipping around manually",
    },
  ];

  // ── Render ───────────────────────────────────────────────────────────────────

  if (!hydrated) {
    return (
      <main style={{ ...s.main, ...s.centeredLoaderScreen }}>
        <ThemedLoader size={0.78} label="Loading Snippet" />
      </main>
    );
  }

  return (
    <main style={s.main}>
      <header style={s.header}>
        <div style={s.brandLockup}>
          <img src="/snippet-logo.png" alt="Snippet" style={s.brandIcon} />
          <div style={s.brandTextWrap}>
            <p style={s.brandTitle}>Snippet</p>
            <p style={s.brandSubtitle}>Jump to the best parts</p>
          </div>
        </div>
        {token ? (
          <button style={s.headerIconBtn} onClick={() => handleTabPress("search")} aria-label="Open search">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="7.5" />
              <line x1="21" y1="21" x2="16.5" y2="16.5" />
            </svg>
          </button>
        ) : (
          <div style={s.headerProfilePlaceholder} aria-hidden="true">
            <div style={s.headerProfileInner} />
          </div>
        )}
      </header>

      {urlError && <p style={s.error}>Login issue: {urlError}</p>}

      {!token ? (
        <div style={s.landingWrap}>
          <section style={{ ...s.landingHero, animationDelay: "0ms" }} className="landingFadeUp">
            <div style={s.landingHeroGlow} />
            <p
              style={{
                ...s.landingHeadline,
                background: GRAD,
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
                backgroundClip: "text",
              }}
            >
              Jump to the best parts.
            </p>
            <p style={s.landingSubheadline}>
              Play any song and skip straight to what hits.
            </p>
            <button style={s.btnPrimaryLg} onClick={goLogin}>Connect Spotify</button>
            <p style={s.landingCtaMeta}>Takes 5 seconds • No data stored</p>
            <p style={s.landingMicroText}>No account needed</p>
          </section>

          <section style={{ ...s.landingSection, animationDelay: "90ms" }} className="landingFadeUp">
            <p style={s.landingSectionTitle}>Music, but edited for you.</p>
            <p style={s.landingSectionBody}>
              Save and replay the best moments of any song — the drop, the verse, the part that actually hits.
            </p>
          </section>

          <section style={{ ...s.landingSection, animationDelay: "140ms" }} className="landingFadeUp">
            <p style={s.landingSectionTitle}>What Snippet does</p>
            <div style={s.landingFeatureGrid}>
              {landingFeatures.map((feature) => (
                <article key={feature.title} style={s.landingFeatureCard}>
                  <p style={s.landingFeatureTitle}>{feature.title}</p>
                  <p style={s.landingFeatureBody}>{feature.body}</p>
                </article>
              ))}
            </div>
          </section>

          <section style={{ ...s.landingSection, animationDelay: "190ms" }} className="landingFadeUp">
            <p style={s.landingSectionTitle}>Built with privacy in mind</p>
            <p style={s.landingSectionBody}>
              Snippet does not store your Spotify login or personal data. We use Spotify’s official authentication — nothing is saved on our servers.
            </p>
          </section>

          <section style={{ ...s.landingSection, animationDelay: "240ms" }} className="landingFadeUp">
            <p style={s.landingSectionTitle}>Powered by listeners, not algorithms</p>
            <p style={s.landingSectionBody}>
              The best parts are discovered by people, not decided for you.
            </p>
          </section>

          <section style={{ ...s.landingSection, ...s.landingFinalCta, animationDelay: "290ms" }} className="landingFadeUp">
            <p style={s.landingSectionTitle}>Start in seconds</p>
            <button style={s.btnPrimaryLg} onClick={goLogin}>Connect Spotify</button>
            <p style={s.landingCtaMeta}>Start in seconds</p>
          </section>

          <section style={{ ...s.landingDisclaimer, animationDelay: "340ms" }} className="landingFadeUp">
            <p style={s.landingDisclaimerTitle}>Built by a two-person team</p>
            <p style={s.landingDisclaimerBody}>
              We&apos;re a two man army trying to make our dream real. Snippet is still in development, and we&apos;re shaping it in public. If you have feedback, ideas, or something feels off, please let us know.
            </p>
          </section>
        </div>
      ) : (
        <>
          {/* ── Home Tab ── */}
          {activeTab === "home" && (<>
            {!playerState && !isNativeApp && !webPlayerId && devices.length === 0 ? (
              <div style={s.devicePicker}>
                <p style={s.devicePickerHeading}>{browserPlaybackHelp.title}</p>
                <p style={{ ...s.muted, fontSize: "0.82rem" }}>
                  {browserPlaybackHelp.body}
                </p>
                {webPlayerError?.type === "initialization_error" ? (
                  <p style={{ ...s.muted, fontSize: "0.78rem", marginTop: "0.6rem", color: "#d9c8f1" }}>
                    Best next test: open Snippet in full Chrome or Safari on this computer and make sure protected content / DRM playback is allowed.
                  </p>
                ) : null}
                <button style={{ ...s.btnGhost, marginTop: "0.9rem" }} onClick={fetchDevices}>
                  {loadingDevices ? <ThemedLoader size={0.28} label="Refreshing" inline /> : "Refresh devices"}
                </button>
              </div>
            ) : (
            <div style={s.card}>
              <div style={s.cardGradientBar} />
              <div style={s.cardInner}>
              {playerState ? (
                <div style={s.nowPlaying}>
                  {playerState.albumArt && (
                    <img src={playerState.albumArt} alt="Album art" style={s.albumArt} />
                  )}
                  <div style={s.trackInfo}>
                    <div style={s.trackNameRow}>
                      <p style={s.trackName}>{playerState.name}</p>
                      <button style={s.saveIconBtn} onClick={handleSaveTimestamp} title={`Save moment at ${formatMs(estimatedPos)}`}>
                        <img src="/Snippet-S.png" alt="Save moment" width="19" height="19" style={{ display: "block", objectFit: "contain", filter: "brightness(0) invert(1)" }} />
                      </button>
                    </div>
                    <p style={s.artist}>{playerState.artists}</p>
                    <input
                      type="range"
                      min={0}
                      max={playerState.durationMs}
                      value={estimatedPos}
                      onChange={handleSeekChange}
                      onMouseUp={handleSeekCommit}
                      onTouchEnd={handleSeekCommit}
                      style={{...s.seekSlider, background: `linear-gradient(to right, transparent 0%, transparent ${playerState.durationMs ? (estimatedPos / playerState.durationMs) * 100 : 0}%, #2a2a3a ${playerState.durationMs ? (estimatedPos / playerState.durationMs) * 100 : 0}%, #2a2a3a 100%), ${GRAD}`}}
                    />
                    <div style={s.times}>
                      <span>{formatMs(estimatedPos)}</span>
                      <button
                        style={playerState.shuffle ? s.shuffleOn : s.shuffleOff}
                        onClick={handleShuffle}
                        title={playerState.shuffle ? "Shuffle on" : "Shuffle off"}
                      >
                        ⇄
                      </button>
                      <span>{formatMs(playerState.durationMs)}</span>
                    </div>
                  </div>
                </div>
              ) : (
                <div style={{ ...s.empty, minHeight: "unset", padding: "1.25rem 0 0.4rem", alignItems: "flex-start" }}>
                  <p style={{ ...s.emptyTitle, fontSize: "1.05rem" }}>Start playing something in Spotify</p>
                  <p style={{ ...s.muted, maxWidth: "32rem" }}>
                    Snippet is connected, but there isn&apos;t an active track yet. Play a song and your now playing controls and save-snippet actions will appear here.
                  </p>
                </div>
              )}

            <section style={s.sectionBlock}>
              <button style={s.sectionHeader} onClick={() => setSnippetsOpen((v) => !v)}>
                <div>
                  <p style={s.sectionTitle}>Your Snippets</p>
                  <p style={s.sectionSubtle}>Organized by most recent moments</p>
                </div>
                <div style={s.sectionHeaderRight}>
                  <span style={s.sectionMeta}>{snippetTracks.length}</span>
                  <span style={{ ...s.chevron, fontSize: "0.85rem" }}>{snippetsOpen ? "▲" : "▼"}</span>
                </div>
              </button>

              {snippetsOpen && (nowPlayingTimestamps.length > 0 ? (
                <ul style={s.list}>
                  {nowPlayingTimestamps.map((ts, i) => (
                    <li key={i} style={s.listItem}>
                      <label
                        className={`snippet-option${!snippetModeEnabled ? " snippet-option-dormant" : ""}`}
                        style={{ flex: 1, padding: 0, background: "transparent", border: 0, boxShadow: "none" }}
                      >
                        <input
                          type="radio"
                          name={`home-snippet-${playerState.id}`}
                          className="snippet-radio-input"
                          checked={selectedNowPlayingSnippetIndex === i}
                          onChange={() => handleSelectSnippet(playerState.id, i)}
                        />
                        <span className="snippet-label">
                          {ts.label || `Snippet ${i + 1}`}
                          <span className="snippet-meta">{formatMs(ts.positionMs)}</span>
                        </span>
                      </label>
                      <button
                        style={s.homeSnippetPlayBtn}
                        onClick={() => jump(playerState.uri, ts.positionMs)}
                        title="Play snippet"
                      >
                        ▶
                      </button>
                      <span style={s.tsTime}>{formatMs(ts.positionMs)}</span>
                      <button
                        style={s.deleteBtn}
                        onClick={() => handleDelete(playerState.id, i)}
                        title="Remove"
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p style={{ ...s.muted, marginTop: "0.5rem", fontSize: "0.82rem" }}>
                  No saved moments for this song yet.
                </p>
              ))}
            </section>
              </div>{/* cardInner */}
            </div>
            )}

          {/* ── Your Snippets ── */}

            <section style={s.sectionBlock}>
              <button style={s.sectionHeader} onClick={() => setPlaylistsOpen((v) => !v)}>
                <div>
                  <p style={s.sectionTitle}>Playlists</p>
                  <p style={s.sectionSubtle}>Most recent playlists first</p>
                </div>
                <div style={s.sectionHeaderRight}>
                  <span style={s.sectionMeta}>{playlists.length}</span>
                  <span style={{ ...s.chevron, fontSize: "0.85rem" }}>{playlistsOpen ? "▲" : "▼"}</span>
                </div>
              </button>
              {prioritizedPlaylists.length === 0 ? (
                <p style={{ ...s.muted, padding: "0.25rem 0.35rem 0.4rem" }}>
                  {playlists.length === 0 ? "No playlists found yet." : "Loading playlists…"}
                </p>
              ) : (
                <>
                  <div style={s.playlistGrid}>
                    {[...prioritizedPlaylists, ...(playlistsOpen ? remainingPlaylists : [])].map((pl) => {
                      const loadedTrackCount = playlistTracks[pl.id]?.length;
                      const displayTrackCount = typeof loadedTrackCount === "number" && loadedTrackCount > 0
                        ? loadedTrackCount
                        : pl.trackCount ?? 0;
                      return (
                        <div
                          key={pl.id}
                          style={{ ...s.playlistGridCard, ...(openPlaylistId === pl.id ? s.playlistGridCardActive : {}) }}
                        >
                          <button
                            style={s.playlistGridMain}
                            onClick={() => handleTogglePlaylist(pl.id)}
                          >
                            {pl.coverArt ? (
                              <img src={pl.coverArt} alt="" style={s.playlistGridArt} />
                            ) : (
                              <div style={s.playlistGridArtFallback} />
                            )}
                            <div style={s.playlistGridMeta}>
                              <span style={s.playlistGridName}>{pl.name}</span>
                            </div>
                          </button>
                          <button
                            style={s.playlistQuickPlayBtn}
                            onClick={() => handleQuickPlayPlaylist(pl)}
                            title="Shuffle play playlist"
                            aria-label={`Shuffle play ${pl.name}`}
                          >
                            <svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor">
                              <path d="M8 5v14l11-7z" />
                            </svg>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                  {openPlaylistId && (() => {
                    const currentPlaylist = playlists.find((pl) => pl.id === openPlaylistId);
                    const tracks = playlistTracks[openPlaylistId] || [];
                    const loading = loadingPlaylistId === openPlaylistId;
                    return (
                      <div style={s.expandedPlaylistPanel}>
                        <p style={s.expandedPlaylistTitle}>{currentPlaylist?.name ?? "Playlist"}</p>
                        {loading ? (
                          <div style={s.sectionLoader}>
                            <ThemedLoader size={0.34} label="Loading playlist" inline />
                          </div>
                        ) : playlistErrors[openPlaylistId] ? (
                          <p style={s.muted}>{playlistErrors[openPlaylistId]}</p>
                        ) : tracks.length === 0 ? (
                          <p style={s.muted}>No tracks found.</p>
                        ) : (
                          <div style={s.compactTrackList}>
                            {tracks.map((track) => (
                              <div key={track.id} style={s.compactTrackRow}>
                                <div style={s.compactTrackMeta} onClick={() => playTrackWithMode(track)}>
                                  {track.albumArt ? (
                                    <img src={track.albumArt} alt="" style={s.compactTrackArt} />
                                  ) : (
                                    <div style={s.compactTrackArtFallback} />
                                  )}
                                  <div style={{ minWidth: 0 }}>
                                    <span style={s.compactTrackName}>{track.name}</span>
                                    <span style={s.compactTrackArtist}>{track.artists}</span>
                                  </div>
                                </div>
                                <button
                                  style={s.trackOptionsBtn}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                  }}
                                  title="Track options"
                                  aria-label="Track options"
                                >
                                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                                    <circle cx="12" cy="5" r="1.8" />
                                    <circle cx="12" cy="12" r="1.8" />
                                    <circle cx="12" cy="19" r="1.8" />
                                  </svg>
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </>
              )}
            </section>

            <section style={s.sectionBlock}>
              <button style={s.sectionHeader} onClick={() => setRecentlyPlayedOpen((v) => !v)}>
                <div>
                  <p style={s.sectionTitle}>Recently Played</p>
                  <p style={s.sectionSubtle}>Jump back into your latest tracks</p>
                </div>
                <div style={s.sectionHeaderRight}>
                  <span style={s.sectionMeta}>{recentlyPlayedTracks.length}</span>
                  <span style={{ ...s.chevron, fontSize: "0.85rem" }}>{recentlyPlayedOpen ? "▲" : "▼"}</span>
                </div>
              </button>
              {recentlyPlayedTracks.length === 0 ? (
                <p style={{ ...s.muted, padding: "0.25rem 0.35rem 0.4rem" }}>Start listening and your recent songs will appear here.</p>
              ) : (
                <div style={s.recentlyPlayedGrid}>
                  {[...prioritizedRecentlyPlayed, ...(recentlyPlayedOpen ? remainingRecentlyPlayed : [])].map((track) => (
                    <button key={track.id} style={s.recentCard} onClick={() => setSelectedTrack(track)}>
                      {track.albumArt ? (
                        <img src={track.albumArt} alt="" style={s.recentCardArt} />
                      ) : (
                        <div style={s.recentCardArtFallback} />
                      )}
                      <div style={s.recentCardMeta}>
                        <span style={s.recentCardName}>{track.name}</span>
                        <span style={s.recentCardArtist}>{track.artists}</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </section>
          </>)}

          {/* ── Search Tab ── */}
          {activeTab === "search" && (
            <div style={s.searchTab}>
              <p style={s.tabHeading}>Search</p>
              <div style={s.searchOrbWrap}>
                <div className="search-orb-container">
                  <div className="gooey-background-layer">
                    <div className="blob blob-1" />
                    <div className="blob blob-2" />
                    <div className="blob blob-3" />
                    <div className="blob-bridge" />
                  </div>
                  <div className="input-overlay">
                    <div className="search-icon-wrapper">
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="search-icon"
                      >
                        <circle cx={11} cy={11} r={8} />
                        <line x1={21} y1={21} x2="16.65" y2="16.65" />
                      </svg>
                    </div>
                    <input
                      type="text"
                      className="modern-input"
                      placeholder="Search songs or artists on Spotify"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      autoFocus
                    />
                    <div className="focus-indicator" />
                  </div>
                  <svg className="gooey-svg-filter" xmlns="http://www.w3.org/2000/svg">
                    <defs>
                      <filter id="enhanced-goo">
                        <feGaussianBlur in="SourceGraphic" stdDeviation={12} result="blur" />
                        <feColorMatrix
                          in="blur"
                          mode="matrix"
                          values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -10"
                          result="goo"
                        />
                        <feComposite in="SourceGraphic" in2="goo" operator="atop" />
                      </filter>
                    </defs>
                  </svg>
                </div>
              </div>
              {!searchQuery ? null : searchLoading ? (
                <div style={{ ...s.sectionLoader, marginTop: "3rem" }}>
                  <ThemedLoader size={0.38} label="Searching Spotify" />
                </div>
              ) : spotifyResults.length === 0 ? (
                <p style={{ ...s.muted, textAlign: "center", marginTop: "3rem" }}>No results for "{searchQuery}"</p>
              ) : (
                <div style={s.libraryBody}>
                  {spotifyResults.map((track) => {
                    const tss = allTimestamps[track.id] || [];
                    return (
                      <div key={track.id} style={s.trackRow}>
                        <div style={{ ...s.trackLeft, cursor: "pointer" }} onClick={() => setSelectedTrack(track)}>
                          {track.albumArt ? (
                            <img src={track.albumArt} alt="" style={s.trackArt} />
                          ) : (
                            <div style={s.trackArtFallback} />
                          )}
                          <div style={s.trackMeta}>
                            <span style={s.trackRowName}>{track.name}</span>
                            <span style={s.trackRowArtist}>{track.artists}</span>
                            {tss.length > 0 && (
                              <div style={s.chipRow}>
                                {tss.map((ts, i) => (
                                  <button key={i} style={s.chip} onClick={() => jump(track, ts.positionMs, track)} title={ts.label}>
                                    {ts.label}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                        <div style={s.trackRight}>
                          <span style={s.trackDuration}>{formatMs(track.durationMs)}</span>
                          <button
                            style={s.playTrackBtn}
                            onClick={() => playTrackWithMode(track)}
                            title={snippetModeEnabled ? "Play selected snippet" : "Play from start"}
                          >
                            <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* ── Profile Tab ── */}
          {activeTab === "profile" && (
            <div style={s.profileTab}>
              <div style={s.profileAvatarWrap}>
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="8" r="4" />
                  <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
                </svg>
              </div>
              <p style={s.profileTitle}>Your Account</p>
              <p style={{ ...s.muted, marginBottom: "2.5rem" }}>Connected via Spotify</p>
              <button style={{ ...s.btnGhost, padding: "0.6rem 1.75rem" }} onClick={handleLogout}>
                Log out of Spotify
              </button>
            </div>
          )}
        </>
      )}

      {/* ── Track Detail Modal ── */}
      {selectedTrack && (() => {
        const activeModalTrack = playerState
          ? (trackLookup[playerState.id] ?? {
              id: playerState.id,
              name: playerState.name,
              uri: playerState.uri,
              artists: playerState.artists,
              albumArt: playerState.albumArt,
              durationMs: playerState.durationMs,
            })
          : selectedTrack;
        const isCurrentTrack = playerState?.id === activeModalTrack.id;
        const tss = allTimestamps[activeModalTrack.id] || [];
        const selectedSnippetIndex = Math.min(
          selectedSnippetIndexByTrack[activeModalTrack.id] ?? 0,
          Math.max(0, tss.length - 1)
        );
        const selectedSnippet = tss[selectedSnippetIndex] ?? null;
        const surroundingTracks = (() => {
          for (const tracks of Object.values(playlistTracks)) {
            const currentIndex = tracks.findIndex((track) => track.id === activeModalTrack.id);
            if (currentIndex >= 0) {
              return {
                previous: tracks[currentIndex - 1] ?? null,
                next: tracks[currentIndex + 1] ?? null,
              };
            }
          }
          return { previous: null, next: null };
        })();
        const upcomingTracks = (
          queueTracks.length > 0
            ? queueTracks
            : surroundingTracks.next
              ? [surroundingTracks.next, ...fallbackUpcomingTracks.filter((track) => track.id !== surroundingTracks.next.id)]
              : fallbackUpcomingTracks
        )
          .slice(0, 6)
          .map((track) => trackLookup[track.id] ?? track);
        const previousTrack =
          surroundingTracks.previous ??
          previousPlayerTrack ??
          (selectedTrack?.id && selectedTrack.id !== activeModalTrack.id ? selectedTrack : null);
        const nextTrack = queueTracks[0] ?? surroundingTracks.next ?? null;
        const modalProgressMs = isCurrentTrack
          ? estimatedPos
          : (selectedSnippet?.positionMs ?? 0) || activeModalTrack.durationMs || 0;
        const modalDurationMs = activeModalTrack.durationMs || playerState?.durationMs || 1;
        const modalProgressPercent = Math.max(
          0,
          Math.min(100, (modalProgressMs / Math.max(modalDurationMs, 1)) * 100)
        );
        const modalArcStart = 0.1;
        const modalArcEnd = 359.9;
        const modalProgressArcPath = describeArcPath(50, 50, 45, modalArcStart, modalArcEnd);
        return (
          <div
            style={s.modalOverlay}
            onClick={() => {
              setModalMenuOpen(false);
              setModalMenuSnippetsOpen(false);
              setSelectedTrack(null);
            }}
          >
            <div style={s.modalSheet} onClick={e => e.stopPropagation()}>
              <div style={s.modalAura} />
              <div style={s.modalViewport}>
                <div style={s.modalHeader}>
                  <button
                    style={s.modalClose}
                    onClick={() => {
                      setModalMenuOpen(false);
                      setModalMenuSnippetsOpen(false);
                      setSelectedTrack(null);
                    }}
                    aria-label="Close player"
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="m6 9 6 6 6-6" />
                    </svg>
                  </button>
                  <div style={s.modalHandle} />
                  <div style={s.modalHeaderActions}>
                    <button
                      className={[
                        "modal-clip-btn",
                        modalClipPressed ? "is-pressed" : "",
                        modalClipSaved ? "is-saved" : "",
                      ].filter(Boolean).join(" ")}
                      onClick={handleModalClip}
                      onPointerDown={() => setModalClipPressed(true)}
                      onPointerUp={() => setModalClipPressed(false)}
                      onPointerLeave={() => setModalClipPressed(false)}
                      onPointerCancel={() => setModalClipPressed(false)}
                      aria-label={`Save clip at ${formatMs(estimatedPos)}`}
                      title={`Save clip at ${formatMs(estimatedPos)}`}
                    >
                      <span className="modal-clip-btn__icon-wrap">
                        <img src="/snippet-logo.png" alt="" className="modal-clip-btn__icon" />
                      </span>
                      <span className="modal-clip-btn__text">Clip</span>
                    </button>
                    <div style={s.modalClipNoticeWrap}>
                      <span
                        style={{
                          ...s.modalClipNotice,
                          opacity: modalClipNotice ? 1 : 0,
                          transform: modalClipNotice ? "translateY(0)" : "translateY(-2px)",
                        }}
                      >
                        {modalClipNotice || "\u00A0"}
                      </span>
                    </div>
                  </div>
                </div>

                <div style={s.modalHero}>
                  <div style={s.modalMetaRow}>
                    <div>
                      <p style={s.modalTrackName}>{activeModalTrack.name}</p>
                      <p style={s.modalArtist}>{activeModalTrack.artists}</p>
                    </div>
                  </div>

                  <div style={s.modalDiscStage}>
                    <div style={{ ...s.modalSideArt, ...s.modalSideArtLeft }}>
                      {previousTrack?.albumArt ? (
                        <>
                          <img src={previousTrack.albumArt} alt="" style={s.modalSideArtImage} />
                          <div style={{ ...s.modalSideArtGlass, ...s.modalSideArtGlassLeft }} />
                        </>
                      ) : (
                        <div style={s.modalSideArtFallback} />
                      )}
                    </div>
                    <div style={{ ...s.modalSideArt, ...s.modalSideArtRight }}>
                      {nextTrack?.albumArt ? (
                        <>
                          <img src={nextTrack.albumArt} alt="" style={s.modalSideArtImage} />
                          <div style={{ ...s.modalSideArtGlass, ...s.modalSideArtGlassRight }} />
                        </>
                      ) : (
                        <div style={s.modalSideArtFallback} />
                      )}
                    </div>
                    <div style={s.modalDiscOuter}>
                      {isCurrentTrack && (
                        <div
                          style={s.modalProgressHitArea}
                          onPointerDown={(event) => handleModalRingPointerDown(event, activeModalTrack.durationMs)}
                          onPointerMove={(event) => handleModalRingPointerMove(event, activeModalTrack.durationMs)}
                          onPointerUp={(event) => handleModalRingPointerUp(event, activeModalTrack.durationMs)}
                          onPointerCancel={(event) => handleModalRingPointerUp(event, activeModalTrack.durationMs)}
                        />
                      )}
                      <svg
                        viewBox="0 0 100 100"
                        style={s.modalProgressRing}
                        aria-hidden="true"
                      >
                        <path
                          d={modalProgressArcPath}
                          fill="none"
                          stroke="rgba(255,255,255,0.14)"
                          strokeWidth="1.8"
                        />
                        <path
                          d={modalProgressArcPath}
                          fill="none"
                          stroke="rgba(146, 196, 255, 0.98)"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          pathLength="100"
                          strokeDasharray={`${modalProgressPercent} 100`}
                          style={s.modalProgressActive}
                        />
                      </svg>
                      <div style={s.modalDiscInner}>
                        <div style={s.modalDiscCenter}>
                          {activeModalTrack.albumArt ? (
                            <img src={activeModalTrack.albumArt} alt="" style={s.modalArt} />
                          ) : (
                            <div style={s.modalArtFallback} />
                          )}
                        </div>
                      </div>
                      <div style={s.modalDiscTime}>
                        {formatMs(modalProgressMs)}
                      </div>
                    </div>
                  </div>

                  <div style={s.modalTransport}>
                    <button
                      style={{
                        ...s.modalTransportBtn,
                        ...(playerState?.shuffle ? s.modalTransportBtnActive : {}),
                      }}
                      onClick={handleShuffle}
                      aria-label="Shuffle"
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M4 7h2.5l9 10H20" />
                        <path d="M20 17l-2.8 2.8" />
                        <path d="M20 17l-2.8-2.8" />
                        <path d="M4 17h2.5l3.3-3.7" />
                        <path d="M20 7h-4.5l-2.2 2.4" />
                        <path d="M20 7l-2.8 2.8" />
                        <path d="M20 7l-2.8-2.8" />
                      </svg>
                    </button>
                    <button
                      style={s.modalTransportBtn}
                      onClick={handleSkipPrevious}
                      aria-label="Previous track"
                    >
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M6 5h2v14H6zM18 5 8.5 12 18 19z" />
                      </svg>
                    </button>
                    <button
                      className={!isCurrentTrack || !playerState?.isPlaying ? "play-pulse" : undefined}
                      style={s.modalTransportPrimary}
                      onClick={() => {
                        if (isCurrentTrack) {
                          handlePlayPause();
                          return;
                        }
                        jump(activeModalTrack, resolvePlaybackPosition(activeModalTrack.id, 0), activeModalTrack);
                      }}
                      aria-label={isCurrentTrack && playerState?.isPlaying ? "Pause" : "Play"}
                    >
                      {isCurrentTrack && playerState?.isPlaying ? (
                        <span style={{ letterSpacing: "3px", fontSize: "1.45rem" }}>❙❙</span>
                      ) : (
                        <svg viewBox="0 0 512 512" width="26" height="26" fill="currentColor" style={{ marginLeft: 4 }}>
                          <path d="M424.4 214.7L72.4 6.6C43.8-10.3 0 6.1 0 47.9V464c0 37.5 40.7 60.1 72.4 41.3l352-208c31.4-18.5 31.5-64.1 0-82.6z" />
                        </svg>
                      )}
                    </button>
                    <button
                      style={s.modalTransportBtn}
                      onClick={handleSkipNext}
                      aria-label="Next track"
                    >
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M16 5h2v14h-2zM6 5l9.5 7L6 19z" />
                      </svg>
                    </button>
                    <button
                      style={{
                        ...s.modalTransportBtn,
                        ...(playerState?.repeatMode !== "off" ? s.modalTransportBtnActive : {}),
                      }}
                      onClick={handleRepeatCycle}
                      aria-label={`Repeat mode ${playerState?.repeatMode ?? "off"}`}
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M17 3v4h4" />
                        <path d="M20.5 7H9a5 5 0 0 0-5 5" />
                        <path d="M7 21v-4H3" />
                        <path d="M3.5 17H15a5 5 0 0 0 5-5" />
                      </svg>
                      {playerState?.repeatMode === "track" && <span style={s.repeatBadge}>1</span>}
                    </button>
                  </div>
                </div>
              </div>
              {upcomingTracks.length > 0 && (
                <div style={s.modalQueuePanel}>
                  <div style={s.modalQueueHeader}>
                    <p style={s.modalQueueHeading}>Up Next</p>
                    <button
                      style={s.modalQueueMenuBtn}
                      aria-label="More options"
                      onClick={() => {
                        setModalMenuOpen((value) => {
                          if (value) {
                            setModalMenuSnippetsOpen(false);
                            return false;
                          }
                          return true;
                        });
                      }}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <circle cx="12" cy="5" r="1.8" />
                        <circle cx="12" cy="12" r="1.8" />
                        <circle cx="12" cy="19" r="1.8" />
                      </svg>
                    </button>
                  </div>
                  <div style={s.modalQueueList}>
                    {upcomingTracks.map((track, index) => (
                      <button
                        key={`${track.id}-${index}`}
                        style={s.modalQueueRow}
                        onClick={() => {
                          setSelectedTrack(track);
                          playTrackWithMode(track);
                        }}
                      >
                        {track.albumArt ? (
                          <img src={track.albumArt} alt="" style={s.modalQueueArt} />
                        ) : (
                          <div style={s.modalQueueArtFallback} />
                        )}
                        <div style={s.modalQueueMeta}>
                          <span style={s.modalQueueName}>{track.name}</span>
                          <span style={s.modalQueueArtist}>{track.artists}</span>
                        </div>
                        <span style={s.modalQueueDuration}>{formatMs(track.durationMs)}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {modalMenuOpen && (
                <div
                  style={s.modalMenuBackdrop}
                  onClick={() => {
                    setModalMenuOpen(false);
                    setModalMenuSnippetsOpen(false);
                  }}
                >
                  <div style={s.modalMenuSheet} onClick={(e) => e.stopPropagation()}>
                    <div style={s.modalMenuHandle} />
                    <div style={s.modalMenuHeader}>
                      {activeModalTrack.albumArt ? (
                        <img src={activeModalTrack.albumArt} alt="" style={s.modalMenuTrackArt} />
                      ) : (
                        <div style={s.modalMenuTrackArtFallback} />
                      )}
                      <div style={{ minWidth: 0 }}>
                        <p style={s.modalMenuTrackName}>{activeModalTrack.name}</p>
                        <p style={s.modalMenuTrackArtist}>{activeModalTrack.artists}</p>
                      </div>
                    </div>

                    <div style={s.modalMenuActions}>
                      <button
                        style={s.modalMenuAction}
                        onClick={() => setSnippetModeEnabled((value) => !value)}
                      >
                        <div style={s.modalMenuActionCopy}>
                          <span style={s.modalMenuActionTitle}>
                            {snippetModeEnabled ? "Disable snippet mode" : "Enable snippet mode"}
                          </span>
                          <span style={s.modalMenuActionSubtle}>
                            {snippetModeEnabled
                              ? "Play songs from the beginning"
                              : "Jump straight to your selected snippet"}
                          </span>
                        </div>
                        <span
                          style={{
                            ...s.modalMenuTogglePill,
                            ...(snippetModeEnabled ? s.modalMenuTogglePillActive : {}),
                          }}
                        >
                          {snippetModeEnabled ? "On" : "Off"}
                        </span>
                      </button>

                      <button
                        style={s.modalMenuAction}
                        onClick={() => setModalMenuSnippetsOpen((value) => !value)}
                      >
                        <div style={s.modalMenuActionCopy}>
                          <span style={s.modalMenuActionTitle}>Select snippet</span>
                          <span style={s.modalMenuActionSubtle}>
                            Choose which saved moment snippet mode should use
                          </span>
                        </div>
                        <span style={s.modalMenuChevron}>{modalMenuSnippetsOpen ? "−" : "+"}</span>
                      </button>
                    </div>

                    {modalMenuSnippetsOpen && (
                      <div style={s.modalMenuSnippetSection}>
                        {tss.length > 0 ? (
                          <div className="snippet-radio-group">
                            {tss.map((ts, i) => (
                              <label key={i} className="snippet-option">
                                <input
                                  type="radio"
                                  name={`menu-snippet-${activeModalTrack.id}`}
                                  className="snippet-radio-input"
                                  checked={selectedSnippetIndex === i}
                                  onChange={() => handleSelectSnippet(activeModalTrack.id, i)}
                                />
                                <span className="snippet-label">
                                  {ts.label || `Snippet ${i + 1}`}
                                  <span className="snippet-meta">{formatMs(ts.positionMs)}</span>
                                </span>
                              </label>
                            ))}
                          </div>
                        ) : (
                          <p style={s.modalMenuEmpty}>No saved snippets for this song yet.</p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
              {(isCurrentTrack || tss.length > 0) && (
                <div style={s.modalSnippetPanel}>
                  {isCurrentTrack && (
                    <div style={s.modalSaveRow}>
                      <input
                        style={s.input}
                        placeholder={`Label (optional) — at ${formatMs(estimatedPos)}`}
                        value={labelInput}
                        onChange={(e) => setLabelInput(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && handleSaveTimestamp()}
                      />
                      <button style={s.btnPrimary} onClick={handleSaveTimestamp}>Save</button>
                    </div>
                  )}
                  <div style={s.modalTimestamps}>
                    <p style={s.modalTsHeading}>
                      {tss.length > 0 ? "Saved Snippets" : "No saved snippets yet"}
                    </p>
                    <div className="snippet-radio-group">
                      {tss.map((ts, i) => (
                        <label
                          key={i}
                          className={`snippet-option${!snippetModeEnabled ? " snippet-option-dormant" : ""}`}
                        >
                          <input
                            type="radio"
                            name={`modal-snippet-${activeModalTrack.id}`}
                            className="snippet-radio-input"
                            checked={selectedSnippetIndex === i}
                            onChange={() => handleSelectSnippet(activeModalTrack.id, i)}
                          />
                          <span className="snippet-label">
                            {ts.label || `Snippet ${i + 1}`}
                            <span className="snippet-meta">{formatMs(ts.positionMs)}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                    {tss.length > 0 && (
                      <button
                        style={{ ...s.btnPrimary, width: "100%", marginTop: "1rem" }}
                        onClick={() => {
                          if (!selectedSnippet) return;
                          jump(activeModalTrack, selectedSnippet.positionMs, activeModalTrack);
                          setSelectedTrack(null);
                        }}
                      >
                        Play selected snippet
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })()}
      {token && playerState && (
        <div style={s.miniPlayerShell}>
          <div style={s.miniPlayerBar}>
            <button
              style={s.miniModeToggle}
              onClick={() => setSnippetModeEnabled((value) => !value)}
              aria-label={snippetModeEnabled ? "Disable snippet mode" : "Enable snippet mode"}
              title={snippetModeEnabled ? "Snippet Mode On" : "Snippet Mode Off"}
            >
              <span style={s.miniModeToggleInner} aria-hidden="true">
                <span
                  style={{
                    ...s.miniModeBar,
                    ...(snippetModeEnabled ? s.miniModeBarTopActive : s.miniModeBarTop),
                  }}
                />
                <span
                  style={{
                    ...s.miniModeBar,
                    ...(snippetModeEnabled ? s.miniModeBarMiddleActive : s.miniModeBarMiddle),
                  }}
                />
                <span
                  style={{
                    ...s.miniModeBar,
                    ...(snippetModeEnabled ? s.miniModeBarBottomActive : s.miniModeBarBottom),
                  }}
                />
              </span>
            </button>
            <button style={s.miniPlayerMeta} onClick={() => setSelectedTrack(trackLookup[playerState.id] ?? playerState)}>
              {playerState.albumArt ? (
                <img src={playerState.albumArt} alt="" style={s.miniPlayerArt} />
              ) : (
                <div style={s.miniPlayerArtFallback} />
              )}
              <div style={{ minWidth: 0 }}>
                <span style={s.miniPlayerTrack}>{playerState.name}</span>
                <span style={s.miniPlayerArtist}>
                  {snippetModeEnabled && selectedNowPlayingSnippet
                    ? `Snippet ${selectedNowPlayingSnippet.label ? `• ${selectedNowPlayingSnippet.label}` : `• ${formatMs(selectedNowPlayingSnippet.positionMs)}`}`
                    : playerState.artists}
                </span>
              </div>
            </button>
            <div style={s.miniPlayerActions}>
              <div style={s.miniControlCluster}>
                {snippetModeEnabled && selectedNowPlayingSnippet && (
                  <button
                    style={s.miniSecondaryControl}
                    onClick={() => jump(trackLookup[playerState.id] ?? playerState, selectedNowPlayingSnippet.positionMs, trackLookup[playerState.id] ?? playerState)}
                    aria-label="Jump to selected snippet"
                    title="Jump to selected snippet"
                  >
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 4v16" />
                      <path d="M19 12 9 19V5l10 7Z" fill="currentColor" stroke="none" />
                    </svg>
                  </button>
                )}
                <button
                  style={s.miniPrimaryControl}
                  onClick={handlePlayPause}
                  aria-label={playerState.isPlaying ? "Pause" : "Play"}
                >
                  {playerState.isPlaying ? (
                    <span style={{ letterSpacing: "2px", fontSize: "0.96rem" }}>❙❙</span>
                  ) : (
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  )}
                </button>
                <button
                  style={s.miniSecondaryControl}
                  onClick={handleSkipNext}
                  aria-label="Next track"
                  title="Next track"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M16 5h2v14h-2zM6 5l9.5 7L6 19z" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {/* ── Bottom Nav ── */}
      {token && (() => {
        const tabs = [
          {
            id: "home",
            label: "Home",
            icon: (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 10.5L12 3l9 7.5V20a1 1 0 01-1 1H4a1 1 0 01-1-1V10.5z" />
                <path d="M9 21V13h6v8" />
              </svg>
            ),
          },
          {
            id: "search",
            label: "Search",
            icon: (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="7.5" />
                <line x1="21" y1="21" x2="16.5" y2="16.5" />
              </svg>
            ),
          },
          {
            id: "profile",
            label: "Profile",
            icon: (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="8" r="4" />
                <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
              </svg>
            ),
          },
        ];
        return (
          <nav
            style={{
              ...s.bottomNav,
              ...(playerState ? s.bottomNavWithMiniPlayer : {}),
            }}
          >
            <div
              style={{
                ...s.bottomNavSheen,
                ...(playerState ? s.bottomNavSheenWithMiniPlayer : {}),
              }}
            />
            {tabs.map(({ id, label, icon }) => (
              <button
                key={id}
                aria-label={label}
                style={{
                  ...s.navBtn,
                  ...(activeTab === id ? s.navBtnActive : {}),
                  transform: pressedTab === id ? "scale(0.8)" : "scale(1)",
                }}
                onClick={() => handleTabPress(id)}
              >
                {icon}
              </button>
            ))}
          </nav>
        );
      })()}
    </main>
  );
}

const ORANGE = "#E0AAFF";
const GRAD = "linear-gradient(135deg, #E0AAFF 0%, #9D4EDD 34%, #5A189A 72%, #3c096c 100%)";

const s = {
  main: {
    padding: "1.5rem", maxWidth: 600, margin: "0 auto",
    paddingBottom: "7rem",
  },
  centeredLoaderScreen: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  sectionLoader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "0.6rem 0",
  },

  // ── Header ──
  header: {
    display: "flex", alignItems: "center",
    gap: "0.75rem", marginBottom: "2rem",
    padding: "1rem 1.25rem",
    background: "rgba(18, 8, 24, 0.82)",
    borderRadius: 16,
    border: "1px solid rgba(224,170,255,0.08)",
    backdropFilter: "blur(16px)",
    boxShadow: "0 14px 40px rgba(0,0,0,0.32)",
  },
  brandLockup: {
    display: "flex",
    alignItems: "center",
    gap: "0.18rem",
    minWidth: 0,
    flex: 1,
  },
  brandIcon: {
    width: 56,
    height: 56,
    objectFit: "contain",
    opacity: 0.96,
    filter: "brightness(0) invert(1) drop-shadow(0 0 10px rgba(255,255,255,0.08))",
    flexShrink: 0,
  },
  brandTextWrap: {
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: "0.12rem",
    marginLeft: "-0.22rem",
  },
  brandTitle: {
    margin: 0,
    color: "#f5f1fa",
    fontSize: "1.02rem",
    fontWeight: 700,
    letterSpacing: "-0.015em",
  },
  brandSubtitle: {
    margin: 0,
    color: "#91859f",
    fontSize: "0.74rem",
    lineHeight: 1.35,
  },
  headerIconBtn: {
    width: 38,
    height: 38,
    borderRadius: 9999,
    border: "1px solid rgba(224,170,255,0.12)",
    background: "rgba(255,255,255,0.03)",
    color: "#f2eaff",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.03)",
  },
  headerProfilePlaceholder: {
    width: 42,
    height: 42,
    borderRadius: 999,
    border: "1px solid rgba(224,170,255,0.14)",
    background: "linear-gradient(180deg, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0.02) 100%)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.07), 0 10px 24px rgba(0,0,0,0.18)",
    backdropFilter: "blur(18px)",
    WebkitBackdropFilter: "blur(18px)",
  },
  headerProfileInner: {
    width: 15,
    height: 15,
    borderRadius: 999,
    background: "radial-gradient(circle at 35% 35%, rgba(255,255,255,0.9), rgba(224,170,255,0.75) 60%, rgba(157,78,221,0.5) 100%)",
    boxShadow: "0 0 18px rgba(224,170,255,0.28)",
  },
  headerRight: { display: "flex", gap: "0.5rem", flexShrink: 0 },
  landingWrap: {
    display: "flex",
    flexDirection: "column",
    gap: "1rem",
    paddingBottom: "2rem",
  },
  landingHero: {
    position: "relative",
    minHeight: "60vh",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    textAlign: "center",
    gap: "0.85rem",
    padding: "2.8rem 1.4rem 2.4rem",
    borderRadius: 30,
    border: "1px solid rgba(224,170,255,0.1)",
    background:
      "radial-gradient(circle at 50% 0%, rgba(157,78,221,0.22), transparent 48%), linear-gradient(180deg, rgba(20,9,28,0.94) 0%, rgba(11,7,16,0.98) 100%)",
    boxShadow: "0 28px 72px rgba(0,0,0,0.42), inset 0 1px 0 rgba(255,255,255,0.05)",
    backdropFilter: "blur(22px)",
    WebkitBackdropFilter: "blur(22px)",
    overflow: "hidden",
  },
  landingHeroGlow: {
    position: "absolute",
    inset: "-15% 18% auto",
    height: 180,
    background: "radial-gradient(circle, rgba(224,170,255,0.18), rgba(157,78,221,0.08) 45%, transparent 72%)",
    filter: "blur(18px)",
    pointerEvents: "none",
  },
  landingHeadline: {
    position: "relative",
    zIndex: 1,
    margin: 0,
    fontSize: "clamp(2.35rem, 8vw, 4.2rem)",
    lineHeight: 0.95,
    fontWeight: 850,
    letterSpacing: "-0.05em",
    maxWidth: "10ch",
  },
  landingSubheadline: {
    position: "relative",
    zIndex: 1,
    margin: 0,
    maxWidth: 420,
    color: "#d2c7df",
    fontSize: "0.97rem",
    lineHeight: 1.55,
  },
  landingCtaMeta: {
    position: "relative",
    zIndex: 1,
    margin: "0.1rem 0 0",
    color: "#c9b9dd",
    fontSize: "0.74rem",
    fontWeight: 600,
    letterSpacing: "0.01em",
  },
  landingMicroText: {
    position: "relative",
    zIndex: 1,
    margin: 0,
    color: "#8e81a0",
    fontSize: "0.72rem",
  },
  landingSection: {
    padding: "1.35rem 1.2rem",
    borderRadius: 26,
    border: "1px solid rgba(224,170,255,0.08)",
    background: "linear-gradient(180deg, rgba(17,10,22,0.84) 0%, rgba(11,7,15,0.96) 100%)",
    boxShadow: "0 18px 44px rgba(0,0,0,0.28), inset 0 1px 0 rgba(255,255,255,0.03)",
    backdropFilter: "blur(18px)",
    WebkitBackdropFilter: "blur(18px)",
  },
  landingSectionTitle: {
    margin: 0,
    color: "#fbf8ff",
    fontSize: "1.18rem",
    fontWeight: 760,
    letterSpacing: "-0.03em",
  },
  landingSectionBody: {
    margin: "0.5rem 0 0",
    color: "#b3a8c2",
    fontSize: "0.9rem",
    lineHeight: 1.65,
    maxWidth: 470,
  },
  landingFeatureGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap: "0.8rem",
    marginTop: "1rem",
  },
  landingFeatureCard: {
    padding: "1rem 0.95rem",
    borderRadius: 20,
    border: "1px solid rgba(224,170,255,0.08)",
    background: "linear-gradient(180deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.015) 100%)",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.03)",
    backdropFilter: "blur(16px)",
    WebkitBackdropFilter: "blur(16px)",
  },
  landingFeatureTitle: {
    margin: 0,
    color: "#f5effd",
    fontSize: "0.95rem",
    fontWeight: 700,
    letterSpacing: "-0.02em",
  },
  landingFeatureBody: {
    margin: "0.38rem 0 0",
    color: "#9f93b2",
    fontSize: "0.8rem",
    lineHeight: 1.55,
  },
  landingFinalCta: {
    alignItems: "center",
    textAlign: "center",
    display: "flex",
    flexDirection: "column",
    gap: "0.85rem",
  },
  landingDisclaimer: {
    padding: "0.35rem 0.3rem 0",
    textAlign: "center",
  },
  landingDisclaimerTitle: {
    margin: 0,
    color: "#d9ccea",
    fontSize: "0.8rem",
    fontWeight: 650,
    letterSpacing: "0.01em",
  },
  landingDisclaimerBody: {
    margin: "0.45rem auto 0",
    color: "#897d98",
    fontSize: "0.76rem",
    lineHeight: 1.65,
    maxWidth: 480,
  },
  modeBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "1rem",
    marginBottom: "1rem",
    padding: "0.9rem 1.1rem",
    borderRadius: 16,
    background: "rgba(10, 7, 14, 0.88)",
    border: "1px solid rgba(224,170,255,0.08)",
    boxShadow: "0 10px 28px rgba(0,0,0,0.26)",
  },
  modeCopy: {
    display: "flex",
    flexDirection: "column",
    gap: "0.15rem",
    minWidth: 0,
  },
  modeTitle: {
    margin: 0,
    fontSize: "0.9rem",
    fontWeight: 700,
    color: "#f3eef8",
    letterSpacing: "-0.01em",
  },
  modeText: {
    margin: 0,
    fontSize: "0.76rem",
    color: "#a89ab8",
    lineHeight: 1.45,
  },
  searchInput: {
    width: "100%", boxSizing: "border-box", padding: "0.45rem 0.85rem", borderRadius: 10,
    border: "1px solid rgba(255,255,255,0.08)",
    background: "rgba(255,255,255,0.05)",
    color: "#f0f0f5", fontSize: "0.82rem", outline: "none",
    minWidth: 0,
    transition: "border-color 0.2s",
  },

  muted: { color: "#6b6b88", fontSize: "0.88rem", lineHeight: 1.6, margin: 0 },
  error: { color: "#ff8a8a", marginBottom: "1rem", fontSize: "0.85rem" },

  // ── Empty / Login ──
  empty: {
    marginTop: "5rem", textAlign: "center",
    display: "flex", flexDirection: "column", alignItems: "center", gap: "0.75rem",
  },
  emptyTitle: {
    fontSize: "1.6rem", fontWeight: 800, margin: 0,
    letterSpacing: "-0.03em",
  },

  // ── Now Playing card ──
  card: {
    background: "#0f0915",
    borderRadius: 18,
    border: "1px solid rgba(224,170,255,0.08)",
    marginBottom: "1.5rem",
    overflow: "hidden",
    boxShadow: "0 18px 44px rgba(0,0,0,0.34)",
  },
  cardGradientBar: {
    height: 0,
    background: "transparent",
  },
  cardInner: {
    padding: "1.25rem",
  },
  nowPlaying: { display: "flex", gap: "1rem", marginBottom: "1.25rem" },
  albumArt: {
    width: 80, height: 80, borderRadius: 12,
    flexShrink: 0, objectFit: "cover",
    background: "#1e1e2e",
    boxShadow: "0 4px 20px rgba(0,0,0,0.5)",
  },
  trackInfo: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", justifyContent: "center" },
  trackNameRow: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    gap: "0.5rem", marginBottom: "0.2rem",
  },
  trackName: {
    margin: 0, fontWeight: 700, fontSize: "1rem",
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
    letterSpacing: "-0.01em", flex: 1, minWidth: 0,
  },
  saveIconBtn: {
    background: "linear-gradient(180deg, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0.02) 100%)",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: 10,
    width: 34,
    height: 34,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    flexShrink: 0,
    transition: "transform 0.15s, opacity 0.15s, border-color 0.15s ease",
    backdropFilter: "blur(18px)",
    WebkitBackdropFilter: "blur(18px)",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08), 0 10px 22px rgba(0,0,0,0.18)",
  },
  artist: { margin: "0 0 0.3rem", color: "#8888aa", fontSize: "0.82rem" },
  deviceBadge: {
    margin: "0 0 0.5rem",
    fontSize: "0.7rem",
    color: "#4a4a68",
    display: "flex",
    alignItems: "center",
    gap: "0.25rem",
  },
  seekSlider: {
    width: "100%", cursor: "pointer",
    marginBottom: "0.3rem", display: "block",
    accentColor: ORANGE,
  },
  times: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    fontSize: "0.7rem", color: "#5a5a78",
  },
  shuffleOn: {
    background: GRAD, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
    backgroundClip: "text", border: "none", cursor: "pointer",
    fontSize: "0.9rem", padding: 0, lineHeight: 1,
  },
  shuffleOff: {
    background: "none", border: "none", cursor: "pointer",
    fontSize: "0.9rem", color: "#3a3a58", padding: 0, lineHeight: 1,
  },

  controls: {
    display: "flex", alignItems: "center", gap: "1rem",
    marginBottom: "1rem",
    padding: "0.75rem 1rem",
    background: "rgba(255,255,255,0.025)",
    borderRadius: 12,
    border: "1px solid rgba(224,170,255,0.05)",
  },
  playPauseBtn: {
    background: GRAD,
    border: "none", borderRadius: "50%",
    width: 40, height: 40, display: "flex", alignItems: "center",
    justifyContent: "center", cursor: "pointer", fontSize: "0.95rem",
    color: "#fff", flexShrink: 0,
    transition: "transform 0.15s",
  },
  volumeRow: {
    display: "flex", alignItems: "center", gap: "0.5rem", flex: 1,
  },
  volumeIcon: { fontSize: "0.85rem", flexShrink: 0, color: "#5a5a78" },
  volumeSlider: { flex: 1, accentColor: ORANGE, cursor: "pointer" },
  volumeLabel: { fontSize: "0.7rem", color: "#5a5a78", flexShrink: 0, minWidth: "2.5rem", textAlign: "right" },

  saveRow: { display: "flex", gap: "0.5rem", marginBottom: "1rem" },
  input: {
    flex: 1, padding: "0.55rem 0.85rem", borderRadius: 10,
    border: "1px solid rgba(255,255,255,0.08)",
    background: "rgba(255,255,255,0.05)",
    color: "#f0f0f5", fontSize: "0.82rem", outline: "none",
  },

  // ── Saved moments list ──
  list: {
    listStyle: "none", padding: 0, margin: 0,
    display: "flex", flexDirection: "column", gap: "0.35rem",
  },
  listItem: {
    display: "flex", alignItems: "center", gap: "0.5rem",
    background: "rgba(255,255,255,0.028)",
    borderRadius: 10, padding: "0.55rem 0.85rem",
    border: "1px solid rgba(224,170,255,0.05)",
    transition: "background 0.15s",
  },
  jumpBtn: {
    flex: 1, display: "flex", alignItems: "center", gap: "0.5rem",
    background: "none", border: "none", color: "#f0f0f5",
    cursor: "pointer", fontSize: "0.88rem", padding: 0, textAlign: "left", minWidth: 0,
  },
  homeSnippetPlayBtn: {
    background: "none",
    border: "none",
    color: "#dcaeff",
    cursor: "pointer",
    fontSize: "0.95rem",
    padding: "0 0.2rem",
    flexShrink: 0,
    lineHeight: 1,
  },
  playIcon: { color: ORANGE, fontSize: "0.65rem", flexShrink: 0 },
  tsLabel: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  tsTime: { color: "#5a5a78", fontSize: "0.75rem", flexShrink: 0 },
  deleteBtn: {
    background: "none", border: "none", color: "#3a3a58",
    cursor: "pointer", fontSize: "0.8rem", padding: "0 0.15rem",
    flexShrink: 0, lineHeight: 1,
    transition: "color 0.15s",
  },

  // ── Library ──
  librarySection: { marginTop: "0.25rem" },
  libraryLabel: {
    fontSize: "0.7rem", fontWeight: 700, letterSpacing: "0.1em",
    textTransform: "uppercase", color: "#f3eef8",
    padding: "0 0.25rem", marginBottom: "0.6rem",
  },
  chevron: { fontSize: "0.6rem", color: "#5a5a78" },
  libraryBody: { display: "flex", flexDirection: "column", gap: "0.4rem" },
  sectionBlock: {
    marginBottom: "1.15rem",
    padding: "1.1rem 1rem 1rem",
    borderRadius: 24,
    border: "1px solid rgba(224,170,255,0.08)",
    background: "linear-gradient(180deg, rgba(17,10,22,0.92) 0%, rgba(11,7,15,0.96) 100%)",
    backdropFilter: "blur(20px)",
    boxShadow: "0 18px 46px rgba(0,0,0,0.34), inset 0 1px 0 rgba(255,255,255,0.03)",
  },
  sectionHeader: {
    width: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "1rem",
    padding: 0,
    marginBottom: "0.95rem",
    background: "none",
    border: "none",
    textAlign: "left",
    cursor: "pointer",
    color: "inherit",
  },
  sectionHeaderStatic: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "1rem",
    marginBottom: "0.95rem",
  },
  sectionHeaderRight: {
    display: "flex",
    alignItems: "center",
    gap: "0.65rem",
    flexShrink: 0,
  },
  sectionMeta: {
    minWidth: 28,
    height: 28,
    padding: "0 0.55rem",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
    background: "rgba(224,170,255,0.07)",
    border: "1px solid rgba(224,170,255,0.12)",
    color: "#d9c6ea",
    fontSize: "0.72rem",
    fontWeight: 700,
  },
  sectionTitle: {
    margin: 0,
    color: "#f7f4fb",
    fontSize: "1.15rem",
    fontWeight: 750,
    letterSpacing: "-0.025em",
  },
  sectionSubtle: {
    margin: "0.18rem 0 0",
    color: "#8f82a0",
    fontSize: "0.75rem",
    lineHeight: 1.45,
  },
  snippetDropdown: {
    display: "flex",
    flexDirection: "column",
    gap: "0.85rem",
  },
  playlistGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: "0.75rem",
  },
  playlistGridCard: {
    display: "flex",
    alignItems: "center",
    gap: "0.25rem",
    minWidth: 0,
    padding: "0.4rem 0.45rem 0.4rem 0.4rem",
    borderRadius: 18,
    border: "1px solid rgba(224,170,255,0.06)",
    background: "linear-gradient(180deg, rgba(255,255,255,0.032) 0%, rgba(255,255,255,0.02) 100%)",
    color: "#f2edf8",
    textAlign: "left",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.02)",
  },
  playlistGridMain: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    alignItems: "center",
    gap: "0.7rem",
    padding: "0.3rem",
    background: "transparent",
    border: 0,
    color: "inherit",
    textAlign: "left",
    cursor: "pointer",
  },
  playlistGridCardActive: {
    border: "1px solid rgba(224,170,255,0.18)",
    background: "linear-gradient(180deg, rgba(60,9,108,0.22) 0%, rgba(15,9,21,0.94) 100%)",
    boxShadow: "0 12px 30px rgba(0,0,0,0.28), 0 0 0 1px rgba(224,170,255,0.04) inset",
  },
  playlistGridArt: {
    width: 50,
    height: 50,
    borderRadius: 12,
    objectFit: "cover",
    flexShrink: 0,
  },
  playlistGridArtFallback: {
    width: 50,
    height: 50,
    borderRadius: 12,
    background: "linear-gradient(145deg, rgba(60,9,108,0.55) 0%, rgba(17,10,22,0.92) 100%)",
    border: "1px solid rgba(224,170,255,0.08)",
    flexShrink: 0,
  },
  playlistGridMeta: {
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: "0.18rem",
  },
  playlistGridName: {
    color: "#f8f4fb",
    fontSize: "0.82rem",
    fontWeight: 650,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  playlistQuickPlayBtn: {
    width: 20,
    height: 20,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
    marginRight: "0.25rem",
    border: 0,
    padding: 0,
    background: "transparent",
    color: "#e7d8f7",
    cursor: "pointer",
    flexShrink: 0,
    opacity: 0.82,
  },
  playlistGridCount: {
    color: "#9486a6",
    fontSize: "0.68rem",
  },
  expandedPlaylistPanel: {
    marginTop: "0.95rem",
    padding: "0.9rem",
    borderRadius: 20,
    border: "1px solid rgba(224,170,255,0.08)",
    background: "linear-gradient(180deg, rgba(9,5,13,0.86) 0%, rgba(14,9,18,0.98) 100%)",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.02)",
  },
  expandedPlaylistTitle: {
    margin: "0 0 0.8rem",
    color: "#f5f1fa",
    fontSize: "0.92rem",
    fontWeight: 700,
    letterSpacing: "-0.01em",
  },
  compactTrackList: {
    display: "flex",
    flexDirection: "column",
    gap: "0.45rem",
  },
  compactTrackRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "0.7rem",
    padding: "0.35rem 0.1rem",
  },
  compactTrackMeta: {
    display: "flex",
    alignItems: "center",
    gap: "0.7rem",
    minWidth: 0,
    flex: 1,
    cursor: "pointer",
  },
  trackOptionsBtn: {
    width: 34,
    height: 34,
    borderRadius: "50%",
    border: "1px solid rgba(255,255,255,0.08)",
    background: "rgba(255,255,255,0.03)",
    color: "#d9c8f1",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    flexShrink: 0,
  },
  compactTrackArt: {
    width: 40,
    height: 40,
    borderRadius: 10,
    objectFit: "cover",
    flexShrink: 0,
  },
  compactTrackArtFallback: {
    width: 40,
    height: 40,
    borderRadius: 10,
    background: "linear-gradient(145deg, rgba(60,9,108,0.45) 0%, rgba(17,10,22,0.92) 100%)",
    flexShrink: 0,
  },
  compactTrackName: {
    display: "block",
    color: "#f4eff9",
    fontSize: "0.82rem",
    fontWeight: 600,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  compactTrackArtist: {
    display: "block",
    color: "#8d80a0",
    fontSize: "0.7rem",
    marginTop: "0.18rem",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  recentlyPlayedGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: "0.75rem",
  },
  recentCard: {
    display: "flex",
    alignItems: "center",
    gap: "0.7rem",
    minWidth: 0,
    padding: "0.7rem",
    borderRadius: 18,
    border: "1px solid rgba(224,170,255,0.06)",
    background: "linear-gradient(180deg, rgba(255,255,255,0.024) 0%, rgba(255,255,255,0.012) 100%)",
    color: "#f2edf8",
    cursor: "pointer",
    textAlign: "left",
  },
  recentCardArt: {
    width: 52,
    height: 52,
    borderRadius: 14,
    objectFit: "cover",
    flexShrink: 0,
  },
  recentCardArtFallback: {
    width: 52,
    height: 52,
    borderRadius: 14,
    background: "linear-gradient(145deg, rgba(60,9,108,0.5) 0%, rgba(17,10,22,0.92) 100%)",
    flexShrink: 0,
  },
  recentCardMeta: {
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: "0.2rem",
  },
  recentCardName: {
    color: "#f7f3fb",
    fontSize: "0.84rem",
    fontWeight: 650,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  recentCardArtist: {
    color: "#8f82a1",
    fontSize: "0.7rem",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },

  playlistWrap: {
    borderRadius: 12, overflow: "hidden",
    border: "1px solid rgba(224,170,255,0.07)",
    background: "#0f0915",
  },
  playlistRow: {
    width: "100%", display: "flex", alignItems: "center", gap: "0.75rem",
    padding: "0.65rem 0.85rem",
    background: "transparent",
    border: "none", color: "#f0f0f5", cursor: "pointer", textAlign: "left",
    transition: "background 0.15s",
  },
  playlistArt: { width: 42, height: 42, borderRadius: 8, objectFit: "cover", flexShrink: 0 },
  playlistArtFallback: {
    width: 42, height: 42, borderRadius: 8,
    background: "#1e1e2e", flexShrink: 0,
  },
  likedArt: {
    width: 42, height: 42, borderRadius: 8, flexShrink: 0,
    background: "#1a1121",
    border: "1px solid rgba(224,170,255,0.2)",
    display: "flex", alignItems: "center",
    justifyContent: "center", fontSize: "1.1rem",
  },
  playlistMeta: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 },
  playlistName: {
    fontSize: "0.88rem", fontWeight: 600,
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  },
  playlistCount: { fontSize: "0.73rem", color: "#5a5a78" },

  trackList: {
    background: "rgba(5,2,8,0.46)",
    borderTop: "1px solid rgba(224,170,255,0.05)",
  },
  trackRow: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "0.55rem 0.85rem",
    borderBottom: "1px solid rgba(255,255,255,0.04)",
    gap: "0.5rem",
    transition: "background 0.15s",
  },
  trackLeft: { display: "flex", alignItems: "center", gap: "0.65rem", minWidth: 0, flex: 1 },
  trackArt: { width: 36, height: 36, borderRadius: 6, objectFit: "cover", flexShrink: 0 },
  trackArtFallback: { width: 36, height: 36, borderRadius: 6, background: "#1e1e2e", flexShrink: 0 },
  trackMeta: { display: "flex", flexDirection: "column", gap: 1, minWidth: 0 },
  trackRowName: {
    fontSize: "0.84rem", fontWeight: 500,
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
    display: "block",
  },
  trackRowArtist: { fontSize: "0.73rem", color: "#5a5a78", display: "block" },
  chipRow: { display: "flex", flexWrap: "wrap", gap: "0.3rem", marginTop: "0.3rem" },
  chip: {
    padding: "0.15rem 0.55rem", borderRadius: 20,
    background: "rgba(224,170,255,0.08)",
    border: "1px solid rgba(224,170,255,0.22)",
    color: "#f0d2ff", fontSize: "0.7rem", cursor: "pointer",
    whiteSpace: "nowrap", maxWidth: 120,
    overflow: "hidden", textOverflow: "ellipsis",
    transition: "background 0.15s",
  },
  trackRight: { display: "flex", alignItems: "center", gap: "0.6rem", flexShrink: 0 },
  trackDuration: { fontSize: "0.73rem", color: "#3a3a58" },
  playTrackBtn: {
    width: 32, height: 32, borderRadius: "50%",
    background: "linear-gradient(30deg, #E0AAFF 5%, #9D4EDD 45%, #5A189A 72%, #3c096c 100%)",
    border: "none", color: "#fff",
    cursor: "pointer",
    display: "flex", alignItems: "center", justifyContent: "center",
    flexShrink: 0, lineHeight: 1,
    transition: "transform 0.15s",
  },

  // ── Buttons ──
  btnPrimary: {
    padding: "0.5rem 1rem", borderRadius: 10, border: "none",
    background: GRAD,
    color: "#fff", fontWeight: 700,
    cursor: "pointer", fontSize: "0.82rem", whiteSpace: "nowrap",
    transition: "opacity 0.15s",
  },
  btnPrimaryLg: {
    marginTop: "1.5rem", padding: "0.75rem 2rem",
    borderRadius: 12, border: "none",
    background: GRAD,
    color: "#fff", fontWeight: 700, cursor: "pointer", fontSize: "1rem",
    letterSpacing: "-0.01em",
  },
  btnGhost: {
    padding: "0.45rem 0.85rem", borderRadius: 10,
    border: "1px solid rgba(224,170,255,0.09)",
    background: "rgba(255,255,255,0.025)",
    color: "#bca5cc", cursor: "pointer", fontSize: "0.82rem",
    transition: "border-color 0.15s",
  },
  btnDisabled: {
    opacity: 0.45,
    cursor: "not-allowed",
  },

  // ── Your Snippets ──
  snippetCard: {
    background: "#0f0915",
    borderRadius: 14,
    border: "1px solid rgba(224,170,255,0.07)",
    overflow: "hidden",
  },
  snippetCardHeader: {
    display: "flex",
    alignItems: "center",
    gap: "0.65rem",
    padding: "0.7rem 0.85rem",
    borderBottom: "1px solid rgba(255,255,255,0.05)",
  },
  snippetArt: { width: 38, height: 38, borderRadius: 6, objectFit: "cover", flexShrink: 0 },
  snippetArtFallback: { width: 38, height: 38, borderRadius: 6, background: "#1e1e2e", flexShrink: 0 },
  snippetTrackMeta: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 },
  snippetTrackName: { fontSize: "0.88rem", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#f0f0f5" },
  snippetTrackArtist: { fontSize: "0.73rem", color: "#5a5a78" },
  snippetCardActions: {
    marginLeft: "auto",
    display: "flex",
    alignItems: "center",
    gap: "0.45rem",
    flexShrink: 0,
  },
  snippetExpandBtn: {
    width: 32,
    height: 32,
    borderRadius: "50%",
    border: "1px solid rgba(224,170,255,0.12)",
    background: "rgba(255,255,255,0.03)",
    color: "#d6c4e8",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04)",
  },
  snippetList: { display: "flex", flexDirection: "column" },
  snippetRow: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    padding: "0.45rem 0.85rem",
    borderBottom: "1px solid rgba(255,255,255,0.03)",
  },
  snippetToggleRow: {
    flex: 1,
    minWidth: 0,
  },
  snippetCardFooter: {
    padding: "0.85rem",
    borderTop: "1px solid rgba(255,255,255,0.05)",
  },
  snippetEditInput: {
    flex: 1,
    padding: "0.3rem 0.6rem",
    borderRadius: 8,
    border: "1px solid rgba(224,170,255,0.28)",
    background: "rgba(224,170,255,0.06)",
    color: "#f0f0f5",
    fontSize: "0.82rem",
    outline: "none",
    minWidth: 0,
  },
  snippetSaveBtn: {
    background: "none", border: "none", color: "#E0AAFF",
    cursor: "pointer", fontSize: "0.88rem", padding: "0 0.15rem",
    flexShrink: 0, lineHeight: 1, fontWeight: 700,
  },
  editBtn: {
    background: "none", border: "none", color: "#3a3a58",
    cursor: "pointer", fontSize: "0.78rem", padding: "0 0.15rem",
    flexShrink: 0, lineHeight: 1,
    transition: "color 0.15s",
  },
  inlineDeleteBtn: {
    marginLeft: "auto",
    background: "none",
    border: "none",
    color: "#7d6e8f",
    cursor: "pointer",
    fontSize: "0.85rem",
    padding: "0 0.2rem",
    lineHeight: 1,
    flexShrink: 0,
  },

  // ── Device Picker ──
  devicePicker: {
    background: "#0f0915",
    borderRadius: 18,
    border: "1px solid rgba(224,170,255,0.08)",
    padding: "1.25rem",
    marginBottom: "1.5rem",
    boxShadow: "0 18px 44px rgba(0,0,0,0.32)",
  },
  devicePickerHeading: {
    fontSize: "1rem",
    fontWeight: 700,
    margin: "0 0 0.35rem",
    color: "#f0f0f5",
    letterSpacing: "-0.01em",
  },
  deviceList: {
    display: "flex",
    flexDirection: "column",
    gap: "0.4rem",
  },
  deviceRow: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    width: "100%",
    padding: "0.7rem 1rem",
    background: "rgba(255,255,255,0.025)",
    border: "1px solid rgba(224,170,255,0.06)",
    borderRadius: 12,
    color: "#c0c0d8",
    cursor: "pointer",
    textAlign: "left",
    fontSize: "0.88rem",
    transition: "background 0.15s, border-color 0.15s",
  },
  deviceRowActive: {
    background: "rgba(224,170,255,0.1)",
    border: "1px solid rgba(224,170,255,0.24)",
    color: "#f0f0f5",
  },
  deviceIcon: { fontSize: "1.1rem", flexShrink: 0 },
  deviceName: { flex: 1, fontWeight: 500 },
  deviceCheck: { color: "#E0AAFF", fontWeight: 700, fontSize: "0.9rem" },

  // ── Bottom Nav ──
  bottomNav: {
    position: "fixed",
    bottom: "0.8rem",
    left: "50%",
    transform: "translateX(-50%)",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-around",
    gap: "1.15rem",
    width: "min(calc(100vw - 1.5rem), 560px)",
    padding: "0.72rem 1.1rem 0.68rem",
    background: "linear-gradient(180deg, rgba(10, 7, 16, 0.56) 0%, rgba(8, 6, 12, 0.82) 52%, rgba(6, 4, 9, 0.9) 100%)",
    backdropFilter: "blur(34px) saturate(1.16)",
    WebkitBackdropFilter: "blur(34px) saturate(1.16)",
    borderRadius: 26,
    border: "1px solid rgba(224,170,255,0.14)",
    boxShadow: "0 18px 48px rgba(0,0,0,0.48), 0 4px 16px rgba(0,0,0,0.18), inset 0 1px 0 rgba(255,255,255,0.08), inset 0 -10px 26px rgba(0,0,0,0.2)",
    zIndex: 50,
    overflow: "hidden",
  },
  bottomNavWithMiniPlayer: {
    borderRadius: "14px 14px 26px 26px",
  },
  bottomNavSheen: {
    position: "absolute",
    inset: "1px 1px auto 1px",
    height: "46%",
    borderRadius: 24,
    background: "linear-gradient(180deg, rgba(255,255,255,0.09) 0%, rgba(255,255,255,0.018) 60%, rgba(255,255,255,0) 100%)",
    pointerEvents: "none",
  },
  bottomNavSheenWithMiniPlayer: {
    borderRadius: "12px 12px 24px 24px",
  },
  miniPlayerShell: {
    position: "fixed",
    left: "50%",
    bottom: "4.72rem",
    transform: "translateX(-50%)",
    width: "min(calc(100vw - 1.5rem), 560px)",
    zIndex: 49,
  },
  miniPlayerBar: {
    display: "flex",
    alignItems: "center",
    gap: "0.62rem",
    padding: "0.54rem 0.72rem",
    borderRadius: 22,
    background: "linear-gradient(180deg, rgba(11, 8, 17, 0.62) 0%, rgba(8, 6, 12, 0.88) 100%)",
    border: "1px solid rgba(224,170,255,0.14)",
    backdropFilter: "blur(30px) saturate(1.14)",
    WebkitBackdropFilter: "blur(30px) saturate(1.14)",
    boxShadow: "0 16px 38px rgba(0,0,0,0.34), inset 0 1px 0 rgba(255,255,255,0.06)",
  },
  miniModeToggle: {
    width: 38,
    height: 38,
    borderRadius: "50%",
    background: "linear-gradient(180deg, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0.02) 100%)",
    border: "1px solid rgba(255,255,255,0.1)",
    padding: 0,
    margin: 0,
    flexShrink: 0,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08), 0 10px 24px rgba(0,0,0,0.22)",
  },
  miniModeToggleInner: {
    position: "relative",
    width: 18,
    height: 18,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    transform: "rotate(0deg)",
    transition: "transform 0.32s ease",
  },
  miniModeBar: {
    position: "absolute",
    height: 2.5,
    borderRadius: 999,
    background: "#ffffff",
    boxShadow: "0 0 10px rgba(255,255,255,0.16)",
    transition: "transform 0.32s ease, opacity 0.22s ease, width 0.32s ease",
  },
  miniModeBarTop: {
    width: 10,
    opacity: 0.55,
    transform: "translateY(0)",
  },
  miniModeBarMiddle: {
    width: 18,
    transform: "translateY(0)",
    opacity: 1,
  },
  miniModeBarBottom: {
    width: 10,
    opacity: 0.55,
    transform: "translateY(0)",
  },
  miniModeBarTopActive: {
    width: 18,
    opacity: 1,
    transform: "translateY(-6px)",
  },
  miniModeBarMiddleActive: {
    width: 18,
    transform: "translateY(0)",
    opacity: 1,
  },
  miniModeBarBottomActive: {
    width: 18,
    opacity: 1,
    transform: "translateY(6px)",
  },
  miniPlayerMeta: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    alignItems: "center",
    gap: "0.62rem",
    padding: 0,
    background: "none",
    border: "none",
    color: "inherit",
    textAlign: "left",
    cursor: "pointer",
  },
  miniPlayerArt: {
    width: 40,
    height: 40,
    borderRadius: 12,
    objectFit: "cover",
    flexShrink: 0,
    boxShadow: "0 8px 24px rgba(0,0,0,0.32)",
  },
  miniPlayerArtFallback: {
    width: 40,
    height: 40,
    borderRadius: 12,
    background: "linear-gradient(145deg, rgba(60,9,108,0.56) 0%, rgba(17,10,22,0.92) 100%)",
    flexShrink: 0,
  },
  miniPlayerTrack: {
    display: "block",
    color: "#fbf8ff",
    fontSize: "0.76rem",
    fontWeight: 620,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  miniPlayerArtist: {
    display: "block",
    color: "#9485a4",
    fontSize: "0.63rem",
    marginTop: "0.1rem",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  miniPlayerActions: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    minWidth: 74,
  },
  miniControlCluster: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "0.35rem",
  },
  miniPrimaryControl: {
    width: 34,
    height: 34,
    borderRadius: 999,
    border: "1px solid rgba(224,170,255,0.08)",
    background: "rgba(255,255,255,0.03)",
    color: "#fff",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  miniSecondaryControl: {
    width: 28,
    height: 28,
    borderRadius: 999,
    border: "1px solid rgba(224,170,255,0.08)",
    background: "rgba(255,255,255,0.02)",
    color: "#e6d6f5",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  navBtn: {
    background: "linear-gradient(180deg, rgba(255,255,255,0.035) 0%, rgba(255,255,255,0.015) 100%)",
    border: "1px solid rgba(255,255,255,0.04)",
    cursor: "pointer",
    color: "rgba(255,255,255,0.42)",
    width: 42,
    height: 42,
    padding: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    lineHeight: 0,
    transition: "transform 0.15s ease, color 0.15s ease, box-shadow 0.2s ease, background 0.2s ease, border-color 0.2s ease",
    borderRadius: 999,
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.02)",
    position: "relative",
  },
  navBtnActive: {
    color: "#f6eeff",
    background: "linear-gradient(180deg, rgba(104, 54, 168, 0.22) 0%, rgba(39, 20, 58, 0.08) 100%)",
    border: "1px solid rgba(224,170,255,0.12)",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.12), 0 0 18px rgba(125, 68, 214, 0.22), 0 10px 22px rgba(0,0,0,0.16)",
    filter: "drop-shadow(0 0 10px rgba(224,170,255,0.22))",
  },

  // ── Search Tab ──
  searchTab: {
    paddingTop: "0.25rem",
  },
  searchOrbWrap: {
    marginBottom: "1.25rem",
    display: "flex",
    justifyContent: "center",
  },
  tabHeading: {
    fontSize: "1.35rem",
    fontWeight: 800,
    margin: "0 0 1rem",
    letterSpacing: "-0.025em",
    color: "#f0f0f5",
  },

  // ── Profile Tab ──
  profileTab: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    paddingTop: "4rem",
    textAlign: "center",
  },
  profileAvatarWrap: {
    width: 96,
    height: 96,
    borderRadius: "50%",
    background: "rgba(255,255,255,0.05)",
    border: "1px solid rgba(255,255,255,0.1)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: "1.25rem",
    color: "rgba(255,255,255,0.35)",
  },
  profileTitle: {
    fontSize: "1.5rem",
    fontWeight: 800,
    margin: "0 0 0.35rem",
    letterSpacing: "-0.025em",
    color: "#f0f0f5",
  },

  // ── Track Detail Modal ──
  modalOverlay: {
    position: "fixed", inset: 0,
    background: "radial-gradient(circle at 22% 8%, rgba(255, 170, 224, 0.18), transparent 24%), radial-gradient(circle at 78% 6%, rgba(170, 112, 255, 0.16), transparent 26%), rgba(0,0,0,0.82)",
    backdropFilter: "blur(20px)",
    zIndex: 100,
    display: "flex", alignItems: "stretch", justifyContent: "center",
    overflowY: "auto",
  },
  modalSheet: {
    width: "100%", maxWidth: 600,
    background: "linear-gradient(180deg, rgba(49, 28, 72, 0.96) 0%, rgba(58, 33, 88, 0.95) 18%, rgba(42, 24, 64, 0.94) 34%, rgba(19, 12, 30, 0.96) 60%, rgba(9, 6, 14, 0.98) 84%)",
    minHeight: "100%",
    padding: "0 1.25rem 7rem",
    display: "flex", flexDirection: "column",
    position: "relative",
    overflow: "hidden",
  },
  modalAura: {
    position: "absolute",
    inset: "-8% -4% auto",
    height: "60vh",
    background: "radial-gradient(circle at 16% 18%, rgba(255, 163, 216, 0.52), transparent 36%), radial-gradient(circle at 84% 10%, rgba(191, 120, 255, 0.48), transparent 38%), radial-gradient(circle at 52% 24%, rgba(150, 92, 225, 0.26), transparent 44%), linear-gradient(145deg, rgba(255, 140, 210, 0.18) 0%, rgba(151, 91, 229, 0.24) 56%, rgba(15, 8, 20, 0.01) 100%)",
    filter: "blur(22px)",
    pointerEvents: "none",
  },
  modalViewport: {
    position: "relative",
    zIndex: 1,
  },
  modalHeader: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "1.25rem 0 0.7rem",
    position: "sticky", top: 0,
    background: "linear-gradient(180deg, rgba(47, 28, 71, 0.08) 0%, rgba(47, 28, 71, 0) 100%)",
    backdropFilter: "blur(6px)",
    zIndex: 1,
  },
  modalClose: {
    background: "none", border: "none",
    color: "#f3ebfb", cursor: "pointer",
    width: 36, height: 36, borderRadius: "50%",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: "0.88rem", flexShrink: 0, padding: 0,
  },
  modalHeaderActions: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: "0.25rem",
    flexShrink: 0,
  },
  modalClipNoticeWrap: {
    minHeight: 16,
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "flex-end",
    width: "100%",
  },
  modalClipNotice: {
    fontSize: "0.68rem",
    letterSpacing: "0.01em",
    color: "rgba(248, 241, 255, 0.68)",
    transition: "opacity 180ms ease, transform 180ms ease",
    textAlign: "right",
    whiteSpace: "nowrap",
  },
  modalHandle: {
    width: 42,
    height: 6,
    borderRadius: 999,
    background: "transparent",
    boxShadow: "none",
    opacity: 0,
  },
  modalClipBtn: {
    width: 104,
    height: 40,
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.16)",
    background: "linear-gradient(180deg, rgba(15,10,22,0.96) 0%, rgba(10,7,15,0.92) 100%)",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.12), 0 10px 24px rgba(0,0,0,0.2)",
    backdropFilter: "blur(16px) saturate(1.12)",
    WebkitBackdropFilter: "blur(16px) saturate(1.12)",
    color: "#f7f1ff",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-start",
    gap: "0.45rem",
    padding: "0 0.32rem",
    overflow: "hidden",
    transition: "transform 160ms ease, box-shadow 180ms ease, background 180ms ease, border-color 180ms ease, gap 180ms ease",
  },
  modalClipBtnPressed: {
    transform: "scale(0.94)",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.12), 0 5px 14px rgba(0,0,0,0.16)",
  },
  modalClipBtnSaved: {
    background: "linear-gradient(180deg, rgba(52,24,78,0.98) 0%, rgba(24,11,34,0.95) 100%)",
    border: "1px solid rgba(224,170,255,0.42)",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.24), 0 0 0 1px rgba(224,170,255,0.16), 0 12px 28px rgba(117,73,183,0.28)",
  },
  modalClipIconContainer: {
    width: 30,
    height: 30,
    borderRadius: 999,
    background: "linear-gradient(180deg, rgba(224,170,255,0.95) 0%, rgba(157,78,221,0.92) 100%)",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.28), 0 6px 16px rgba(117,73,183,0.28)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    transition: "width 180ms ease, transform 180ms ease, box-shadow 180ms ease",
  },
  modalClipIcon: {
    width: 17,
    height: 17,
    objectFit: "contain",
    filter: "brightness(0) invert(1)",
    opacity: 0.98,
  },
  modalClipText: {
    height: "100%",
    width: 54,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#fff",
    fontSize: "0.96rem",
    fontWeight: 600,
    letterSpacing: "-0.01em",
    transition: "transform 180ms ease, opacity 180ms ease",
  },
  modalMenuBtn: {
    background: "linear-gradient(180deg, rgba(255,255,255,0.1) 0%, rgba(255,255,255,0.03) 100%)",
    border: "1px solid rgba(255,255,255,0.14)",
    color: "#f3ebfb",
    cursor: "pointer",
    width: 42,
    height: 42,
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
    backdropFilter: "blur(16px) saturate(1.12)",
    WebkitBackdropFilter: "blur(16px) saturate(1.12)",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.18), 0 10px 26px rgba(0,0,0,0.18)",
  },
  modalHero: {
    paddingTop: "1.2rem",
    minHeight: "68vh",
    display: "flex",
    flexDirection: "column",
  },
  modalMetaRow: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "flex-start",
    gap: "1rem",
    marginBottom: "1.8rem",
  },
  modalDiscStage: {
    position: "relative",
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: 350,
    marginBottom: "2rem",
    overflow: "hidden",
  },
  modalSideArt: {
    position: "absolute",
    top: "50%",
    width: 110,
    height: 110,
    borderRadius: "50%",
    overflow: "hidden",
    transform: "translateY(-50%)",
    opacity: 0.82,
    filter: "blur(0.15px) saturate(0.95)",
    border: "1px solid rgba(255,255,255,0.12)",
    boxShadow: "0 24px 40px rgba(0,0,0,0.3)",
    zIndex: 1,
  },
  modalSideArtLeft: {
    left: "0.4rem",
    maskImage: "linear-gradient(90deg, rgba(0,0,0,1) 0%, rgba(0,0,0,0.94) 58%, rgba(0,0,0,0.42) 78%, transparent 100%)",
    WebkitMaskImage: "linear-gradient(90deg, rgba(0,0,0,1) 0%, rgba(0,0,0,0.94) 58%, rgba(0,0,0,0.42) 78%, transparent 100%)",
  },
  modalSideArtRight: {
    right: "0.4rem",
    maskImage: "linear-gradient(270deg, rgba(0,0,0,1) 0%, rgba(0,0,0,0.94) 58%, rgba(0,0,0,0.42) 78%, transparent 100%)",
    WebkitMaskImage: "linear-gradient(270deg, rgba(0,0,0,1) 0%, rgba(0,0,0,0.94) 58%, rgba(0,0,0,0.42) 78%, transparent 100%)",
  },
  modalSideArtImage: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
  },
  modalSideArtGlass: {
    position: "absolute",
    inset: 0,
    borderRadius: "50%",
    pointerEvents: "none",
    backdropFilter: "blur(14px) saturate(1.15)",
    WebkitBackdropFilter: "blur(14px) saturate(1.15)",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.22), inset 0 -18px 26px rgba(255,255,255,0.03)",
  },
  modalSideArtGlassLeft: {
    background: "linear-gradient(90deg, rgba(255,255,255,0.02) 0%, rgba(255,255,255,0.02) 46%, rgba(16,11,22,0.18) 60%, rgba(16,11,22,0.48) 74%, rgba(16,11,22,0.78) 100%)",
    maskImage: "linear-gradient(90deg, transparent 0%, transparent 48%, rgba(0,0,0,0.55) 62%, rgba(0,0,0,0.9) 78%, rgba(0,0,0,1) 100%)",
    WebkitMaskImage: "linear-gradient(90deg, transparent 0%, transparent 48%, rgba(0,0,0,0.55) 62%, rgba(0,0,0,0.9) 78%, rgba(0,0,0,1) 100%)",
  },
  modalSideArtGlassRight: {
    background: "linear-gradient(270deg, rgba(255,255,255,0.02) 0%, rgba(255,255,255,0.02) 46%, rgba(16,11,22,0.18) 60%, rgba(16,11,22,0.48) 74%, rgba(16,11,22,0.78) 100%)",
    maskImage: "linear-gradient(270deg, transparent 0%, transparent 48%, rgba(0,0,0,0.55) 62%, rgba(0,0,0,0.9) 78%, rgba(0,0,0,1) 100%)",
    WebkitMaskImage: "linear-gradient(270deg, transparent 0%, transparent 48%, rgba(0,0,0,0.55) 62%, rgba(0,0,0,0.9) 78%, rgba(0,0,0,1) 100%)",
  },
  modalSideArtFallback: {
    width: "100%",
    height: "100%",
    background: "linear-gradient(145deg, rgba(224,170,255,0.34) 0%, rgba(60,9,108,0.7) 100%)",
  },
  modalDiscOuter: {
    width: "min(78vw, 360px)",
    aspectRatio: "1",
    borderRadius: "50%",
    position: "relative",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "12px",
    border: "1px solid rgba(255,255,255,0.18)",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.22), inset 0 -20px 36px rgba(0,0,0,0.34), 0 34px 62px rgba(0,0,0,0.42)",
    zIndex: 2,
  },
  modalProgressRing: {
    position: "absolute",
    inset: "3.5%",
    width: "93%",
    height: "93%",
    pointerEvents: "none",
    filter: "drop-shadow(0 0 8px rgba(120, 180, 255, 0.18))",
  },
  modalProgressActive: {
    transition: "stroke-dasharray 120ms linear",
  },
  modalProgressHitArea: {
    position: "absolute",
    inset: "3.5%",
    width: "93%",
    height: "93%",
    borderRadius: "50%",
    background: "transparent",
    cursor: "grab",
    touchAction: "none",
    zIndex: 3,
  },
  modalDiscInner: {
    width: "100%",
    height: "100%",
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "radial-gradient(circle at 35% 26%, rgba(255,255,255,0.24), rgba(255,255,255,0.06) 24%, rgba(30,22,40,0.34) 58%, rgba(11,8,16,0.74) 100%)",
    border: "1px solid rgba(211, 195, 255, 0.24)",
    boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.04)",
  },
  modalDiscCenter: {
    width: "66%",
    height: "66%",
    borderRadius: "50%",
    overflow: "hidden",
    boxShadow: "0 18px 32px rgba(0,0,0,0.3)",
  },
  modalArt: {
    width: "100%", height: "100%", objectFit: "cover", display: "block",
  },
  modalArtFallback: {
    width: "100%", height: "100%",
    background: "linear-gradient(135deg, rgba(255, 172, 225, 0.95), rgba(160, 132, 255, 0.9))",
  },
  modalDiscTime: {
    position: "absolute",
    top: "86.2%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    fontSize: "0.98rem",
    color: "#fffafc",
    letterSpacing: "0.02em",
    padding: "0.16rem 0.5rem",
    borderRadius: 999,
    background: "rgba(9,6,14,0.72)",
    boxShadow: "0 10px 20px rgba(0,0,0,0.18), inset 0 1px 0 rgba(255,255,255,0.04)",
    zIndex: 4,
  },
  modalSeekWrap: {
    marginTop: "-0.25rem",
    marginBottom: "1.2rem",
    padding: "0 0.4rem",
  },
  modalSeekSlider: {
    width: "100%",
    display: "block",
    cursor: "pointer",
    accentColor: "#7ebcff",
  },
  modalSeekTimes: {
    marginTop: "0.35rem",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    fontSize: "0.72rem",
    color: "rgba(255,255,255,0.56)",
    letterSpacing: "0.02em",
  },
  modalTrackName: {
    margin: "0 0 0.35rem", fontSize: "3rem", fontWeight: 300,
    letterSpacing: "-0.03em",
    color: "#fff8ff",
    maxWidth: "72vw",
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  },
  modalArtist: {
    margin: 0, color: "rgba(255,255,255,0.74)", fontSize: "1.05rem", fontWeight: 400,
  },
  modalTransport: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "0.8rem",
    padding: "0 0.5rem",
    marginTop: "auto",
    marginBottom: "2.35rem",
  },
  modalTransportBtn: {
    width: 42,
    height: 42,
    borderRadius: "50%",
    border: "1px solid rgba(255,255,255,0.08)",
    background: "linear-gradient(180deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.025) 100%)",
    backdropFilter: "blur(18px) saturate(1.08)",
    WebkitBackdropFilter: "blur(18px) saturate(1.08)",
    color: "rgba(255,255,255,0.94)",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    position: "relative",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.12), 0 10px 28px rgba(0,0,0,0.2)",
  },
  modalTransportBtnActive: {
    color: "#E0AAFF",
    filter: "drop-shadow(0 0 10px rgba(224,170,255,0.32))",
  },
  modalTransportPrimary: {
    width: 84,
    height: 84,
    borderRadius: "50%",
    background: "linear-gradient(180deg, rgba(255,255,255,0.14) 0%, rgba(31,24,42,0.72) 26%, rgba(16,12,23,0.9) 100%)",
    border: "1px solid rgba(255,255,255,0.16)",
    backdropFilter: "blur(22px) saturate(1.08)",
    WebkitBackdropFilter: "blur(22px) saturate(1.08)",
    color: "#fff",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.18), inset 0 -18px 28px rgba(0,0,0,0.16), 0 24px 40px rgba(0,0,0,0.36)",
  },
  repeatBadge: {
    position: "absolute",
    right: 6,
    bottom: 6,
    fontSize: "0.58rem",
    color: "#f7e9ff",
    fontWeight: 700,
    lineHeight: 1,
  },
  modalSaveRow: {
    display: "flex", gap: "0.5rem", marginBottom: "1rem",
  },
  modalQueuePanel: {
    marginTop: "-0.15rem",
    marginBottom: "0.95rem",
    padding: "1rem",
    borderRadius: 24,
    background: "linear-gradient(180deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.02) 100%)",
    border: "1px solid rgba(255,255,255,0.08)",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.05)",
    backdropFilter: "blur(20px)",
  },
  modalQueueHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "0.75rem",
    marginBottom: "0.8rem",
  },
  modalQueueHeading: {
    margin: 0,
    fontSize: "0.72rem",
    fontWeight: 700,
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    color: "rgba(255,255,255,0.46)",
  },
  modalQueueMenuBtn: {
    border: "none",
    background: "transparent",
    color: "rgba(255,255,255,0.66)",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "0.12rem 0",
    minWidth: 24,
    flexShrink: 0,
    opacity: 0.9,
  },
  modalMenuBackdrop: {
    position: "fixed",
    inset: 0,
    background: "linear-gradient(180deg, rgba(0,0,0,0.06) 0%, rgba(0,0,0,0.32) 100%)",
    backdropFilter: "blur(8px)",
    WebkitBackdropFilter: "blur(8px)",
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "center",
    zIndex: 120,
  },
  modalMenuSheet: {
    width: "100%",
    maxWidth: 600,
    minHeight: "34vh",
    maxHeight: "62vh",
    padding: "0.9rem 1rem 1.25rem",
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    background: "linear-gradient(180deg, rgba(28,18,42,0.96) 0%, rgba(16,10,24,0.97) 100%)",
    border: "1px solid rgba(255,255,255,0.09)",
    borderBottom: "none",
    boxShadow: "0 -24px 60px rgba(0,0,0,0.34), inset 0 1px 0 rgba(255,255,255,0.06)",
    backdropFilter: "blur(26px) saturate(1.12)",
    WebkitBackdropFilter: "blur(26px) saturate(1.12)",
    overflowY: "auto",
  },
  modalMenuHandle: {
    width: 54,
    height: 5,
    borderRadius: 999,
    background: "rgba(255,255,255,0.24)",
    margin: "0 auto 1rem",
  },
  modalMenuHeader: {
    display: "flex",
    alignItems: "center",
    gap: "0.8rem",
    paddingBottom: "0.95rem",
    borderBottom: "1px solid rgba(255,255,255,0.07)",
    marginBottom: "0.85rem",
  },
  modalMenuTrackArt: {
    width: 52,
    height: 52,
    borderRadius: 16,
    objectFit: "cover",
    flexShrink: 0,
  },
  modalMenuTrackArtFallback: {
    width: 52,
    height: 52,
    borderRadius: 16,
    flexShrink: 0,
    background: "linear-gradient(145deg, rgba(224,170,255,0.3) 0%, rgba(60,9,108,0.65) 100%)",
  },
  modalMenuTrackName: {
    margin: "0 0 0.22rem",
    color: "#f9f4ff",
    fontSize: "1.05rem",
    fontWeight: 650,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  modalMenuTrackArtist: {
    margin: 0,
    color: "rgba(255,255,255,0.58)",
    fontSize: "0.82rem",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  modalMenuActions: {
    display: "flex",
    flexDirection: "column",
    gap: "0.65rem",
  },
  modalMenuAction: {
    width: "100%",
    border: "1px solid rgba(255,255,255,0.08)",
    background: "linear-gradient(180deg, rgba(255,255,255,0.045) 0%, rgba(255,255,255,0.018) 100%)",
    borderRadius: 22,
    padding: "0.95rem 1rem",
    color: "#fff",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "1rem",
    cursor: "pointer",
    textAlign: "left",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04)",
  },
  modalMenuActionCopy: {
    display: "flex",
    flexDirection: "column",
    gap: "0.2rem",
    minWidth: 0,
  },
  modalMenuActionTitle: {
    color: "#fcf7ff",
    fontSize: "0.96rem",
    fontWeight: 620,
  },
  modalMenuActionSubtle: {
    color: "rgba(255,255,255,0.56)",
    fontSize: "0.76rem",
    lineHeight: 1.35,
  },
  modalMenuTogglePill: {
    minWidth: 42,
    height: 28,
    padding: "0 0.7rem",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.08)",
    background: "rgba(255,255,255,0.04)",
    color: "rgba(255,255,255,0.7)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "0.74rem",
    fontWeight: 700,
    letterSpacing: "0.03em",
    flexShrink: 0,
  },
  modalMenuTogglePillActive: {
    background: "linear-gradient(180deg, rgba(224,170,255,0.22) 0%, rgba(157,78,221,0.14) 100%)",
    border: "1px solid rgba(224,170,255,0.24)",
    color: "#f3e8ff",
    boxShadow: "0 0 16px rgba(224,170,255,0.18)",
  },
  modalMenuChevron: {
    color: "rgba(255,255,255,0.72)",
    fontSize: "1.15rem",
    fontWeight: 500,
    flexShrink: 0,
  },
  modalMenuSnippetSection: {
    marginTop: "0.85rem",
    paddingTop: "0.9rem",
    borderTop: "1px solid rgba(255,255,255,0.07)",
  },
  modalMenuEmpty: {
    margin: 0,
    color: "rgba(255,255,255,0.54)",
    fontSize: "0.82rem",
  },
  modalQueueList: {
    display: "flex",
    flexDirection: "column",
  },
  modalQueueRow: {
    width: "100%",
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    padding: "0.7rem 0.1rem",
    background: "none",
    border: "none",
    borderBottom: "1px solid rgba(255,255,255,0.08)",
    color: "#fff",
    textAlign: "left",
    cursor: "pointer",
  },
  modalQueueArt: {
    width: 56,
    height: 56,
    borderRadius: 18,
    objectFit: "cover",
    flexShrink: 0,
  },
  modalQueueArtFallback: {
    width: 56,
    height: 56,
    borderRadius: 18,
    background: "linear-gradient(145deg, rgba(224,170,255,0.28) 0%, rgba(60,9,108,0.62) 100%)",
    flexShrink: 0,
  },
  modalQueueMeta: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: "0.18rem",
  },
  modalQueueName: {
    color: "#fcf8ff",
    fontSize: "0.9rem",
    fontWeight: 550,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  modalQueueArtist: {
    color: "rgba(255,255,255,0.54)",
    fontSize: "0.74rem",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  modalQueueDuration: {
    color: "rgba(255,255,255,0.74)",
    fontSize: "0.8rem",
    flexShrink: 0,
    marginLeft: "0.5rem",
  },
  modalTimestamps: {
    borderTop: "1px solid rgba(255,255,255,0.06)",
    paddingTop: "1rem",
  },
  modalSnippetPanel: {
    marginTop: "0.75rem",
    marginBottom: "1rem",
    padding: "1rem",
    borderRadius: 24,
    background: "linear-gradient(180deg, rgba(255,255,255,0.045) 0%, rgba(255,255,255,0.02) 100%)",
    border: "1px solid rgba(255,255,255,0.08)",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04)",
    backdropFilter: "blur(20px)",
  },
  modalTsHeading: {
    margin: "0 0 0.75rem", fontSize: "0.7rem", fontWeight: 700,
    letterSpacing: "0.12em", textTransform: "uppercase", color: "rgba(255,255,255,0.46)",
  },
};
