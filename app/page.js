"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  playSnippet,
  getPlayerState,
  getUserPlaylists,
  getPlaylistTracks,
  getLikedTracks,
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

export default function Home() {
  const [token, setToken] = useState(null);
  const [hydrated, setHydrated] = useState(false);
  const [urlError, setUrlError] = useState(null);
  const [authPending, setAuthPending] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeTab, setActiveTab] = useState("home");
  const [pressedTab, setPressedTab] = useState(null);

  // Web Playback SDK — browser is the Spotify device
  const [webPlayerId, setWebPlayerId] = useState(null);
  const sdkPlayerRef = useRef(null);

  // Device selection fallback (when SDK isn't available)
  const [devices, setDevices] = useState([]);
  const [deviceId, setDeviceId] = useState(null);
  const [loadingDevices, setLoadingDevices] = useState(false);

  // Now Playing
  const [playerState, setPlayerState] = useState(null);
  const [labelInput, setLabelInput] = useState("");
  const [estimatedPos, setEstimatedPos] = useState(0);
  const lastPollRef = useRef(null);
  const isSeekingRef = useRef(false);

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

  // Track detail modal
  const [selectedTrack, setSelectedTrack] = useState(null);
  const [queueTracks, setQueueTracks] = useState([]);

  // Snippet editing
  const [editingSnippet, setEditingSnippet] = useState(null); // { trackId, index, label }
  const [editLabel, setEditLabel] = useState("");
  const [selectedSnippetIndexByTrack, setSelectedSnippetIndexByTrack] = useState({});
  const [snippetModeEnabled, setSnippetModeEnabled] = useState(false);
  const [snippetsOpen, setSnippetsOpen] = useState(true);
  const [playlistsOpen, setPlaylistsOpen] = useState(true);

  // Spotify global search
  const [spotifyResults, setSpotifyResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const nativeSpotifyBridge = getNativeSpotifyBridge();
  const isNativeApp = Boolean(nativeSpotifyBridge);

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
    if (!t) return;
    const [state, queue] = await Promise.all([
      withFreshToken((accessToken) => getPlayerState(accessToken)).catch(() => null),
      withFreshToken((accessToken) => getQueue(accessToken)).catch(() => []),
    ]);
    if (state) {
      setPlayerState(state);
      setEstimatedPos(state.positionMs);
      lastPollRef.current = {
        time: Date.now(),
        positionMs: state.positionMs,
        isPlaying: state.isPlaying,
      };
    }
    setQueueTracks(queue || []);
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
    const code = params.get("code");
    const verifier = params.get("state");
    const err = params.get("error");
    const detail = params.get("detail");
    if (err) {
      if (!t) setUrlError(detail || err);
      window.history.replaceState({}, "", "/");
      return;
    }
    if (!code || !verifier) return;

    setAuthPending(true);
    fetch("/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, code_verifier: verifier }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data?.detail || data?.error || "Token exchange failed");
        }
        const accessToken = data.access_token;
        const refreshToken = data.refresh_token;
        const expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
        localStorage.setItem(STORAGE_KEY, accessToken);
        localStorage.setItem(STORAGE_EXPIRES, String(expiresAt));
        if (refreshToken) {
          localStorage.setItem(STORAGE_REFRESH, refreshToken);
        }
        setToken(accessToken);
        setUrlError(null);
        window.history.replaceState({}, "", "/");
      })
      .catch((exchangeError) => {
        console.warn("[callback] token exchange failed", exchangeError);
        setUrlError(String(exchangeError?.message || exchangeError || "Token exchange failed"));
        window.history.replaceState({}, "", "/");
      })
      .finally(() => {
        setAuthPending(false);
      });
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
      player.addListener("ready", ({ device_id }) => setWebPlayerId(device_id));
      player.addListener("not_ready", () => setWebPlayerId(null));
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
      const state = await getPlayerState(token);
      if (state) {
        setPlayerState(state);
        setEstimatedPos(state.positionMs);
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
  }, [token]);

  // Fetch available devices whenever playerState is null (nothing active)
  const fetchDevices = useCallback(async () => {
    if (isNativeApp) return;
    const t = getStoredToken();
    if (!t) return;
    setLoadingDevices(true);
    const list = await getDevices(t);
    setDevices(list);
    setLoadingDevices(false);
    // Auto-select if only one device available
    if (list.length === 1 && !deviceId) setDeviceId(list[0].id);
  }, [deviceId, isNativeApp]);

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

  // Smooth position estimate between polls
  useEffect(() => {
    const id = setInterval(() => {
      if (isSeekingRef.current) return;
      if (!lastPollRef.current?.isPlaying) return;
      const elapsed = Date.now() - lastPollRef.current.time;
      setEstimatedPos(lastPollRef.current.positionMs + elapsed);
    }, 500);
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
        if (items) setPlaylists(items);
      })
      .catch((err) => console.warn("[playlists] failed to load", err));
  }, [token, playlists.length, withFreshToken]);

  useEffect(() => {
    if (!token || likedTracks !== null) return;
    withFreshToken((accessToken) => getLikedTracks(accessToken))
      .then((tracks) => {
        if (tracks) setLikedTracks(tracks);
      })
      .catch((err) => console.warn("[likedTracks] failed to load", err));
  }, [token, likedTracks, withFreshToken]);

  // Spotify global search — fires when on Search tab, debounced 350ms
  useEffect(() => {
    if (activeTab !== "search" || !searchQuery) {
      setSpotifyResults([]);
      setSearchLoading(false);
      return;
    }
    setSearchLoading(true);
    const id = setTimeout(async () => {
      try {
        let t = getStoredToken();
        if (!t) { setSearchLoading(false); return; }
        let results = await searchTracks(t, searchQuery);
        setSpotifyResults(results);
      } catch (err) {
        if (err.message === "TOKEN_EXPIRED") {
          const newToken = await doRefresh();
          if (newToken) {
            const results = await searchTracks(newToken, searchQuery).catch(() => []);
            setSpotifyResults(results);
          }
        }
      } finally {
        setSearchLoading(false);
      }
    }, 350);
    return () => clearTimeout(id);
  }, [searchQuery, activeTab, doRefresh]);

  // When searching, eagerly load liked tracks and all playlist tracks
  useEffect(() => {
    if (!searchQuery) return;
    if (likedTracks === null) {
      withFreshToken((accessToken) => getLikedTracks(accessToken))
        .then((tracks) => {
          if (tracks) setLikedTracks(tracks);
        })
        .catch((err) => console.warn("[likedTracks] failed to load", err));
    }
    playlists.forEach((pl) => {
      if (!playlistTracks[pl.id]) {
        withFreshToken((accessToken) => getPlaylistTracks(accessToken, pl.id))
          .then((result) => {
            if (!result) return;
            setPlaylistTracks((prev) => ({ ...prev, [pl.id]: result.tracks }));
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
    const tracks = await withFreshToken((accessToken) => getLikedTracks(accessToken));
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
      const result = await withFreshToken((accessToken) => getPlaylistTracks(accessToken, playlistId))
        .catch((err) => {
          console.warn("[playlistTracks] failed to load", playlistId, err);
          return null;
        });
      if (result) {
        setPlaylistTracks((prev) => ({ ...prev, [playlistId]: result.tracks }));
        if (result.forbidden) {
          setPlaylistErrors((prev) => ({ ...prev, [playlistId]: "This playlist can't be accessed. It may be private or managed by Spotify." }));
        }
      }
      setLoadingPlaylistId(null);
    },
    [openPlaylistId, playlistTracks, withFreshToken]
  );

  // ── Playback ─────────────────────────────────────────────────────────────────

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
    // Always prefer the device running this app before falling back to Spotify's active player.
    const targetDevice = webPlayerId || deviceId || null;
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
  }, [playerState, deviceId, webPlayerId, doRefresh, fetchDevices]);

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
    await skipToNext(t, playbackTargetDevice);
    setTimeout(() => refreshPlayerSnapshot(), 350);
  }, [playbackTargetDevice, refreshPlayerSnapshot]);

  const handleSkipPrevious = useCallback(async () => {
    const t = getStoredToken();
    if (!t) return;
    await skipToPrevious(t, playbackTargetDevice);
    setTimeout(() => refreshPlayerSnapshot(), 350);
  }, [playbackTargetDevice, refreshPlayerSnapshot]);

  const handleSaveTimestamp = useCallback(async () => {
    if (!playerState) return;
    const t = getStoredToken();
    if (!t) return;
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
    } catch (err) {
      if (err.message === "MAX_SNIPPETS_REACHED") {
        alert(err.detail || `You can save up to ${MAX_SNIPPETS_PER_TRACK} snippets per song.`);
        return;
      }
      console.warn("[saveTimestamp] failed", err);
    }
  }, [playerState, estimatedPos, labelInput]);

  const handleSelectSnippet = useCallback((trackId, index) => {
    setSelectedSnippetIndexByTrack((prev) => ({ ...prev, [trackId]: index }));
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
    setLikedOpen(false);

    lastPollRef.current = null;
  };

  const handleTabPress = useCallback((tab) => {
    setPressedTab(tab);
    setActiveTab(tab);
    setTimeout(() => setPressedTab(null), 150);
  }, []);

  // ── Render ───────────────────────────────────────────────────────────────────

  if (!hydrated) return <main style={s.main}><p style={s.muted}>Loading…</p></main>;

  const nowPlayingTimestamps = playerState
    ? (allTimestamps[playerState.id] || [])
    : [];
  const selectedNowPlayingSnippetIndex = playerState
    ? Math.min(selectedSnippetIndexByTrack[playerState.id] ?? 0, Math.max(0, nowPlayingTimestamps.length - 1))
    : 0;
  const selectedNowPlayingSnippet = nowPlayingTimestamps[selectedNowPlayingSnippetIndex] ?? null;
  const trackLookup = {};
  (likedTracks || []).forEach((t) => { trackLookup[t.id] = t; });
  Object.values(playlistTracks).flat().forEach((t) => { trackLookup[t.id] = t; });
  if (playerState) {
    trackLookup[playerState.id] = {
      id: playerState.id,
      name: playerState.name,
      uri: playerState.uri,
      artists: playerState.artists,
      albumArt: playerState.albumArt,
      durationMs: playerState.durationMs,
    };
  }
  const snippetTracks = Object.entries(allTimestamps)
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
    .sort((a, b) => b.latestCreatedAt - a.latestCreatedAt);
  const prioritizedPlaylists = [...playlists]
    .sort((a, b) => (b.trackCount ?? 0) - (a.trackCount ?? 0))
    .slice(0, 6);
  const recentTrackPool = [
    ...(playerState ? [trackLookup[playerState.id]] : []),
    ...(likedTracks || []).slice(0, 8),
    ...Object.values(playlistTracks).flat().slice(0, 20),
  ].filter(Boolean);
  const seenRecentTracks = new Set();
  const recentlyPlayedTracks = recentTrackPool.filter((track) => {
    if (!track?.id || seenRecentTracks.has(track.id)) return false;
    seenRecentTracks.add(track.id);
    return true;
  }).slice(0, 6);
  const fallbackUpcomingTracks = (() => {
    const cachedLists = Object.values(playlistTracks);
    for (const tracks of cachedLists) {
      const currentIndex = tracks.findIndex((track) => track.id === selectedTrack?.id);
      if (currentIndex >= 0) {
        return tracks.slice(currentIndex + 1, currentIndex + 7);
      }
    }
    return [];
  })();

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
        {token && (
          <button style={s.headerIconBtn} onClick={() => handleTabPress("search")} aria-label="Open search">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="7.5" />
              <line x1="21" y1="21" x2="16.5" y2="16.5" />
            </svg>
          </button>
        )}
      </header>

      {urlError && <p style={s.error}>Login issue: {urlError}</p>}

      {!token ? (
        <div style={s.empty}>
          {authPending ? (
            <p style={{ ...s.muted, color: "#d7cae5" }}>Connecting Spotify…</p>
          ) : null}
          <p style={{
            ...s.emptyTitle,
            background: GRAD,
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            backgroundClip: "text",
          }}>Jump to the best parts.</p>
          <p style={s.muted}>
            Connect Spotify, start any track, and save the moments worth jumping back to.
          </p>
          <button style={s.btnPrimaryLg} onClick={goLogin}>Login with Spotify</button>
        </div>
      ) : (
        <>
          {/* ── Home Tab ── */}
          {activeTab === "home" && (<>
            {!playerState && !isNativeApp && !webPlayerId && devices.length === 0 && (
              <div style={s.devicePicker}>
                <p style={s.devicePickerHeading}>Connect a playback device</p>
                <p style={{ ...s.muted, fontSize: "0.82rem" }}>
                  Open Spotify somewhere or refresh devices so Snippet has a place to play.
                </p>
                <button style={{ ...s.btnGhost, marginTop: "0.9rem" }} onClick={fetchDevices}>Refresh devices</button>
              )}
            </div>
            )
          ) : (
            <div style={s.card}>
              <div style={s.cardGradientBar} />
              <div style={s.cardInner}>
              <div style={s.nowPlaying}>
                {playerState.albumArt && (
                  <img src={playerState.albumArt} alt="Album art" style={s.albumArt} />
                )}
                <div style={s.trackInfo}>
                  <div style={s.trackNameRow}>
                    <p style={s.trackName}>{playerState.name}</p>
                    <button style={s.saveIconBtn} onClick={handleSaveTimestamp} title={`Save moment at ${formatMs(estimatedPos)}`}>
                      <img src="/Snippet-S.png" alt="Save moment" width="50" height="50" style={{ display: "block", objectFit: "contain", filter: "brightness(0) invert(1)" }} />
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


              {nowPlayingTimestamps.length > 0 ? (
                <ul style={s.list}>
                  {nowPlayingTimestamps.map((ts, i) => (
                    <li key={i} style={s.listItem}>
                      <button
                        style={s.jumpBtn}
                        onClick={() => jump(playerState.uri, ts.positionMs)}
                      >
                        <span style={s.playIcon}>▶</span>
                        <span style={s.tsLabel}>{ts.label}</span>
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
              )}
              </div>{/* cardInner */}
            </div>
          )}

          {/* ── Your Snippets ── */}
          {Object.keys(allTimestamps).length > 0 && (() => {
            const trackLookup = {};
            (likedTracks || []).forEach((t) => { trackLookup[t.id] = t; });
            Object.values(playlistTracks).flat().forEach((t) => { trackLookup[t.id] = t; });
            if (playerState) trackLookup[playerState.id] = { id: playerState.id, name: playerState.name, uri: playerState.uri, artists: playerState.artists, albumArt: playerState.albumArt, durationMs: playerState.durationMs };

            const snippetTracks = Object.entries(allTimestamps).map(([trackId, tss]) => ({
              trackId,
              track: trackLookup[trackId] ?? null,
              tss,
            }));

            return (
              <div style={s.librarySection}>
                <p style={s.libraryLabel}>Your Snippets</p>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                  {snippetTracks.map(({ trackId, track, tss }) => (
                    <div key={trackId} style={s.snippetCard}>
                      <div style={s.snippetCardHeader}>
                        {track?.albumArt ? (
                          <img src={track.albumArt} alt="" style={s.snippetArt} />
                        ) : (
                          <div style={s.snippetArtFallback} />
                        )}
                        <div style={s.snippetTrackMeta}>
                          <span style={s.snippetTrackName}>{track?.name ?? "Unknown track"}</span>
                          <span style={s.snippetTrackArtist}>{track?.artists ?? trackId}</span>
                        </div>
                        {track && (
                          <button style={s.playTrackBtn} onClick={() => jump(track.uri, 0)} title="Play from start">
                            <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                          </button>
                        )}
                      </div>
                      <div style={s.snippetList}>
                        {tss.map((ts, i) => {
                          const isEditing = editingSnippet?.trackId === trackId && editingSnippet?.index === i;
                          return (
                            <div key={i} style={s.snippetRow}>
                              {isEditing ? (
                                <>
                                  <input
                                    style={s.snippetEditInput}
                                    value={editLabel}
                                    onChange={(e) => setEditLabel(e.target.value)}
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter") handleUpdateTimestamp(trackId, i, editLabel);
                                      if (e.key === "Escape") setEditingSnippet(null);
                                    }}
                                    autoFocus
                                  />
                                  <span style={s.tsTime}>{formatMs(ts.positionMs)}</span>
                                  <button style={s.snippetSaveBtn} onClick={() => handleUpdateTimestamp(trackId, i, editLabel)}>✓</button>
                                  <button style={s.deleteBtn} onClick={() => setEditingSnippet(null)}>✕</button>
                                </>
                              ) : (
                                <>
                                  <button
                                    style={s.jumpBtn}
                                    onClick={() => track && jump(track.uri, ts.positionMs)}
                                  >
                                    <span style={s.playIcon}>▶</span>
                                    <span style={s.tsLabel}>{ts.label || formatMs(ts.positionMs)}</span>
                                  </button>
                                  <span style={s.tsTime}>{formatMs(ts.positionMs)}</span>
                                  <button
                                    style={s.editBtn}
                                    onClick={() => { setEditingSnippet({ trackId, index: i }); setEditLabel(ts.label || ""); }}
                                    title="Edit label"
                                  >✏</button>
                                  <button style={s.deleteBtn} onClick={() => handleDelete(trackId, i)} title="Remove">✕</button>
                                </>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </button>
              {snippetsOpen && (
                snippetTracks.length === 0 ? (
                  <p style={{ ...s.muted, padding: "0.25rem 0.35rem 0.4rem" }}>Save a few snippets and they’ll show up here.</p>
                ) : (
                  <div style={s.snippetDropdown}>
                    {snippetTracks.map(({ trackId, track, tss }) => {
                      const selectedSnippetIndex = Math.min(
                        selectedSnippetIndexByTrack[trackId] ?? 0,
                        Math.max(0, tss.length - 1)
                      );
                      const selectedSnippet = tss[selectedSnippetIndex];
                      return (
                        <div key={trackId} style={s.snippetCard}>
                          <div style={s.snippetCardHeader}>
                            {track?.albumArt ? (
                              <img src={track.albumArt} alt="" style={s.snippetArt} />
                            ) : (
                              <div style={s.snippetArtFallback} />
                            )}
                            <div style={s.snippetTrackMeta}>
                              <span style={s.snippetTrackName}>{track?.name ?? "Unknown track"}</span>
                              <span style={s.snippetTrackArtist}>{track?.artists ?? trackId}</span>
                            </div>
                            {track && (
                              <button
                                style={s.playTrackBtn}
                                onClick={() => playTrackWithMode(track)}
                                title={snippetModeEnabled ? "Play selected snippet" : "Play from start"}
                              >
                                <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                              </button>
                            )}
                          </div>
                          <div style={s.snippetList}>
                            {tss.map((ts, i) => {
                              const isEditing = editingSnippet?.trackId === trackId && editingSnippet?.index === i;
                              return (
                                <div key={i} style={s.snippetRow}>
                                  {isEditing ? (
                                    <>
                                      <input
                                        style={s.snippetEditInput}
                                        value={editLabel}
                                        onChange={(e) => setEditLabel(e.target.value)}
                                        onKeyDown={(e) => {
                                          if (e.key === "Enter") handleUpdateTimestamp(trackId, i, editLabel);
                                          if (e.key === "Escape") setEditingSnippet(null);
                                        }}
                                        autoFocus
                                      />
                                      <span style={s.tsTime}>{formatMs(ts.positionMs)}</span>
                                      <button style={s.snippetSaveBtn} onClick={() => handleUpdateTimestamp(trackId, i, editLabel)}>✓</button>
                                      <button style={s.deleteBtn} onClick={() => setEditingSnippet(null)}>✕</button>
                                    </>
                                  ) : (
                                    <>
                                      <label
                                        className={`snippet-option${!snippetModeEnabled ? " snippet-option-dormant" : ""}`}
                                        style={s.snippetToggleRow}
                                      >
                                        <input
                                          type="radio"
                                          name={`snippet-track-${trackId}`}
                                          className="snippet-radio-input"
                                          checked={selectedSnippetIndex === i}
                                          onChange={() => handleSelectSnippet(trackId, i)}
                                        />
                                        <span className="snippet-selector" />
                                        <span className="snippet-glow" />
                                        <span className="snippet-label">
                                          {ts.label || `Snippet ${i + 1}`}
                                          <span className="snippet-meta">{formatMs(ts.positionMs)}</span>
                                        </span>
                                        <span className="snippet-connector" />
                                      </label>
                                      <button
                                        style={s.editBtn}
                                        onClick={() => { setEditingSnippet({ trackId, index: i }); setEditLabel(ts.label || ""); }}
                                        title="Edit label"
                                      >✏</button>
                                      <button style={s.deleteBtn} onClick={() => handleDelete(trackId, i)} title="Remove">✕</button>
                                    </>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                          {track && selectedSnippet && (
                            <div style={s.snippetCardFooter}>
                              <button style={{ ...s.btnPrimary, width: "100%" }} onClick={() => jump(track, selectedSnippet.positionMs, track)}>
                                Play selected snippet
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )
              )}
            </section>

            <section style={s.sectionBlock}>
              <button style={s.sectionHeader} onClick={() => setPlaylistsOpen((v) => !v)}>
                <div>
                  <p style={s.sectionTitle}>Playlists</p>
                  <p style={s.sectionSubtle}>Your most important playlists first</p>
                </div>
                <div style={s.sectionHeaderRight}>
                  <span style={s.sectionMeta}>{playlists.length}</span>
                  <span style={{ ...s.chevron, fontSize: "0.85rem" }}>{playlistsOpen ? "▲" : "▼"}</span>
                </div>
              </button>
              {playlistsOpen && (
                prioritizedPlaylists.length === 0 ? (
                  <p style={{ ...s.muted, padding: "0.25rem 0.35rem 0.4rem" }}>Loading playlists…</p>
                ) : (
                  <>
                    <div style={s.playlistGrid}>
                      {prioritizedPlaylists.map((pl) => (
                        <button
                          key={pl.id}
                          style={{ ...s.playlistGridCard, ...(openPlaylistId === pl.id ? s.playlistGridCardActive : {}) }}
                          onClick={() => handleTogglePlaylist(pl.id)}
                        >
                          {pl.coverArt ? (
                            <img src={pl.coverArt} alt="" style={s.playlistGridArt} />
                          ) : (
                            <div style={s.playlistGridArtFallback} />
                          )}
                          <div style={s.playlistGridMeta}>
                            <span style={s.playlistGridName}>{pl.name}</span>
                            <span style={s.playlistGridCount}>{pl.trackCount} songs</span>
                          </div>
                        </button>
                      ))}
                    </div>
                    {openPlaylistId && (() => {
                      const currentPlaylist = playlists.find((pl) => pl.id === openPlaylistId);
                      const tracks = playlistTracks[openPlaylistId] || [];
                      const loading = loadingPlaylistId === openPlaylistId;
                      return (
                        <div style={s.expandedPlaylistPanel}>
                          <p style={s.expandedPlaylistTitle}>{currentPlaylist?.name ?? "Playlist"}</p>
                          {loading ? (
                            <p style={s.muted}>Loading…</p>
                          ) : playlistErrors[openPlaylistId] ? (
                            <p style={s.muted}>{playlistErrors[openPlaylistId]}</p>
                          ) : tracks.length === 0 ? (
                            <p style={s.muted}>No tracks found.</p>
                          ) : (
                            <div style={s.compactTrackList}>
                              {tracks.slice(0, 8).map((track) => (
                                <div key={track.id} style={s.compactTrackRow}>
                                  <div style={s.compactTrackMeta} onClick={() => setSelectedTrack(track)}>
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
                                    style={s.playTrackBtn}
                                    onClick={() => playTrackWithMode(track)}
                                    title={snippetModeEnabled ? "Play selected snippet" : "Play from start"}
                                  >
                                    <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </>
                )
              )}
            </section>

            <section style={s.sectionBlock}>
              <div style={s.sectionHeaderStatic}>
                <div>
                  <p style={s.sectionTitle}>Recently Played</p>
                  <p style={s.sectionSubtle}>Jump back into your latest tracks</p>
                </div>
              </div>
              {recentlyPlayedTracks.length === 0 ? (
                <p style={{ ...s.muted, padding: "0.25rem 0.35rem 0.4rem" }}>Start listening and your recent songs will appear here.</p>
              ) : (
                <div style={s.recentlyPlayedGrid}>
                  {recentlyPlayedTracks.map((track) => (
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
                <p style={{ ...s.muted, textAlign: "center", marginTop: "3rem" }}>Searching…</p>
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
        const isCurrentTrack = playerState?.id === selectedTrack.id;
        const tss = allTimestamps[selectedTrack.id] || [];
        const selectedSnippetIndex = Math.min(
          selectedSnippetIndexByTrack[selectedTrack.id] ?? 0,
          Math.max(0, tss.length - 1)
        );
        const selectedSnippet = tss[selectedSnippetIndex] ?? null;
        const upcomingTracks = (queueTracks.length > 0 ? queueTracks : fallbackUpcomingTracks).slice(0, 6);
        return (
          <div style={s.modalOverlay} onClick={() => setSelectedTrack(null)}>
            <div style={s.modalSheet} onClick={e => e.stopPropagation()}>
              <div style={s.modalAura} />
              <div style={s.modalViewport}>
                <div style={s.modalHeader}>
                  <button style={s.modalClose} onClick={() => setSelectedTrack(null)} aria-label="Close player">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="m6 9 6 6 6-6" />
                    </svg>
                  </button>
                  <div style={s.modalHandle} />
                  <button style={s.modalMenuBtn} aria-label="More options">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                      <circle cx="12" cy="5" r="1.8" />
                      <circle cx="12" cy="12" r="1.8" />
                      <circle cx="12" cy="19" r="1.8" />
                    </svg>
                  </button>
                </div>

                <div style={s.modalHero}>
                  <div style={s.modalMetaRow}>
                    <div>
                      <p style={s.modalTrackName}>{selectedTrack.name}</p>
                      <p style={s.modalArtist}>{selectedTrack.artists}</p>
                    </div>
                    <button style={s.modalFavorite} aria-label="Favorite track">
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m12 20.4-1.15-1.05C5.4 14.36 2 11.28 2 7.5A4.5 4.5 0 0 1 6.5 3C8.24 3 9.91 3.81 11 5.09 12.09 3.81 13.76 3 15.5 3A4.5 4.5 0 0 1 20 7.5c0 3.78-3.4 6.86-8.85 11.86Z" />
                      </svg>
                    </button>
                  </div>

                  <div style={s.modalDiscStage}>
                    <div style={{ ...s.modalSideArt, ...s.modalSideArtLeft }}>
                      {selectedTrack.albumArt ? (
                        <img src={selectedTrack.albumArt} alt="" style={s.modalSideArtImage} />
                      ) : (
                        <div style={s.modalSideArtFallback} />
                      )}
                    </div>
                    <div style={{ ...s.modalSideArt, ...s.modalSideArtRight }}>
                      {selectedTrack.albumArt ? (
                        <img src={selectedTrack.albumArt} alt="" style={s.modalSideArtImage} />
                      ) : (
                        <div style={s.modalSideArtFallback} />
                      )}
                    </div>
                    <div style={s.modalDiscOuter}>
                      <div style={s.modalDiscInner}>
                        <div style={s.modalDiscCenter}>
                          {selectedTrack.albumArt ? (
                            <img src={selectedTrack.albumArt} alt="" style={s.modalArt} />
                          ) : (
                            <div style={s.modalArtFallback} />
                          )}
                        </div>
                      </div>
                      <div style={s.modalDiscTime}>
                        {formatMs(isCurrentTrack ? estimatedPos : (selectedSnippet?.positionMs ?? 0) || selectedTrack.durationMs || 0)}
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
                        <path d="m18 14 4 4-4 4" />
                        <path d="m18 2 4 4-4 4" />
                        <path d="M2 18h5l9-9" />
                        <path d="M2 6h5l9 9" />
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
                        jump(selectedTrack, resolvePlaybackPosition(selectedTrack.id, 0), selectedTrack);
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
                        <path d="M16 5h2v14h-2zM6 5l9.5 7L6 19z" transform="translate(24 0) scale(-1 1)" />
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
                        <path d="M17 1.8v4.5h4.5" />
                        <path d="M3.2 7.7h12.4a4.1 4.1 0 0 1 3.1 1.3L21.5 12" />
                        <path d="M7 22.2v-4.5H2.5" />
                        <path d="M20.8 16.3H8.4a4.1 4.1 0 0 1-3.1-1.3L2.5 12" />
                      </svg>
                      {playerState?.repeatMode === "track" && <span style={s.repeatBadge}>1</span>}
                    </button>
                  </div>
                </div>
              </div>
              {upcomingTracks.length > 0 && (
                <div style={s.modalQueuePanel}>
                  <p style={s.modalQueueHeading}>Up Next</p>
                  <div style={s.modalQueueList}>
                    {upcomingTracks.map((track, index) => (
                      <button
                        key={`${track.id}-${index}`}
                        style={s.modalQueueRow}
                        onClick={() => setSelectedTrack(track)}
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
                            name={`modal-snippet-${selectedTrack.id}`}
                            className="snippet-radio-input"
                            checked={selectedSnippetIndex === i}
                            onChange={() => handleSelectSnippet(selectedTrack.id, i)}
                          />
                          <span className="snippet-selector" />
                          <span className="snippet-glow" />
                          <span className="snippet-label">
                            {ts.label || `Snippet ${i + 1}`}
                            <span className="snippet-meta">{formatMs(ts.positionMs)}</span>
                          </span>
                          <span className="snippet-connector" />
                        </label>
                      ))}
                    </div>
                    {tss.length > 0 && (
                      <button
                        style={{ ...s.btnPrimary, width: "100%", marginTop: "1rem" }}
                        onClick={() => {
                          if (!selectedSnippet) return;
                          jump(selectedTrack, selectedSnippet.positionMs, selectedTrack);
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
              className="checkbox-wrapper"
              style={s.miniModeToggle}
              onClick={() => setSnippetModeEnabled((value) => !value)}
              aria-label={snippetModeEnabled ? "Disable snippet mode" : "Enable snippet mode"}
              title={snippetModeEnabled ? "Snippet Mode On" : "Snippet Mode Off"}
            >
              <input type="checkbox" checked={snippetModeEnabled} readOnly />
              <label aria-hidden="true">
                <span className="tick_mark" />
              </label>
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
          <nav style={s.bottomNav}>
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
  headerRight: { display: "flex", gap: "0.5rem", flexShrink: 0 },
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
    height: 3,
    background: GRAD,
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
    background: "#7b31c7", border: "none", borderRadius: 8,
    width: 30, height: 30, display: "flex", alignItems: "center",
    justifyContent: "center", cursor: "pointer",
    flexShrink: 0, transition: "transform 0.15s, opacity 0.15s",
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
    gap: "0.7rem",
    minWidth: 0,
    padding: "0.7rem",
    borderRadius: 18,
    border: "1px solid rgba(224,170,255,0.06)",
    background: "linear-gradient(180deg, rgba(255,255,255,0.032) 0%, rgba(255,255,255,0.02) 100%)",
    color: "#f2edf8",
    cursor: "pointer",
    textAlign: "left",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.02)",
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
    bottom: "1rem",
    left: "50%",
    transform: "translateX(-50%)",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-around",
    gap: "1.5rem",
    width: "min(calc(100vw - 1.5rem), 560px)",
    padding: "1rem 1.5rem 0.95rem",
    background: "linear-gradient(180deg, rgba(8, 6, 12, 0.74) 0%, rgba(6, 4, 9, 0.88) 100%)",
    backdropFilter: "blur(28px)",
    WebkitBackdropFilter: "blur(28px)",
    borderRadius: 28,
    border: "1px solid rgba(224,170,255,0.12)",
    boxShadow: "0 12px 42px rgba(0,0,0,0.54), 0 2px 10px rgba(0,0,0,0.28), inset 0 1px 0 rgba(255,255,255,0.04)",
    zIndex: 50,
  },
  miniPlayerShell: {
    position: "fixed",
    left: "50%",
    bottom: "5.45rem",
    transform: "translateX(-50%)",
    width: "min(calc(100vw - 1.5rem), 560px)",
    zIndex: 49,
  },
  miniPlayerBar: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    padding: "0.68rem 0.85rem",
    borderRadius: 24,
    background: "linear-gradient(180deg, rgba(8, 6, 12, 0.7) 0%, rgba(8, 6, 12, 0.92) 100%)",
    border: "1px solid rgba(224,170,255,0.12)",
    backdropFilter: "blur(28px)",
    WebkitBackdropFilter: "blur(28px)",
    boxShadow: "0 14px 34px rgba(0,0,0,0.38), inset 0 1px 0 rgba(255,255,255,0.04)",
  },
  miniModeToggle: {
    background: "none",
    border: "none",
    padding: 0,
    margin: 0,
    flexShrink: 0,
    cursor: "pointer",
  },
  miniPlayerMeta: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    alignItems: "center",
    gap: "0.7rem",
    padding: 0,
    background: "none",
    border: "none",
    color: "inherit",
    textAlign: "left",
    cursor: "pointer",
  },
  miniPlayerArt: {
    width: 44,
    height: 44,
    borderRadius: 14,
    objectFit: "cover",
    flexShrink: 0,
    boxShadow: "0 8px 24px rgba(0,0,0,0.32)",
  },
  miniPlayerArtFallback: {
    width: 44,
    height: 44,
    borderRadius: 14,
    background: "linear-gradient(145deg, rgba(60,9,108,0.56) 0%, rgba(17,10,22,0.92) 100%)",
    flexShrink: 0,
  },
  miniPlayerTrack: {
    display: "block",
    color: "#fbf8ff",
    fontSize: "0.8rem",
    fontWeight: 620,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  miniPlayerArtist: {
    display: "block",
    color: "#9485a4",
    fontSize: "0.66rem",
    marginTop: "0.14rem",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  miniPlayerActions: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    minWidth: 82,
  },
  miniControlCluster: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "0.45rem",
  },
  miniPrimaryControl: {
    width: 38,
    height: 38,
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
    width: 30,
    height: 30,
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
    background: "none",
    border: "none",
    cursor: "pointer",
    color: "rgba(255,255,255,0.38)",
    padding: "0.2rem",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    lineHeight: 0,
    transition: "transform 0.15s ease, color 0.15s ease",
    borderRadius: 8,
  },
  navBtnActive: {
    color: "#E0AAFF",
    filter: "drop-shadow(0 0 8px rgba(224,170,255,0.3))",
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
    background: "radial-gradient(circle at top, rgba(224,170,255,0.12), transparent 26%), rgba(0,0,0,0.88)",
    backdropFilter: "blur(20px)",
    zIndex: 100,
    display: "flex", alignItems: "stretch", justifyContent: "center",
    overflowY: "auto",
  },
  modalSheet: {
    width: "100%", maxWidth: 600,
    background: "linear-gradient(180deg, rgba(12,8,17,0.96) 0%, rgba(6,4,9,1) 72%)",
    minHeight: "100%",
    padding: "0 1.25rem 7rem",
    display: "flex", flexDirection: "column",
    position: "relative",
    overflow: "hidden",
  },
  modalAura: {
    position: "absolute",
    inset: "0 0 auto 0",
    height: "52vh",
    background: "radial-gradient(circle at 20% 18%, rgba(255, 168, 223, 0.45), transparent 35%), radial-gradient(circle at 78% 10%, rgba(186, 118, 255, 0.4), transparent 38%), linear-gradient(135deg, rgba(255, 151, 208, 0.26) 0%, rgba(117, 73, 183, 0.38) 52%, rgba(15, 8, 20, 0.04) 100%)",
    filter: "blur(4px)",
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
    background: "linear-gradient(180deg, rgba(12,8,17,0.52) 0%, rgba(12,8,17,0) 100%)",
    backdropFilter: "blur(10px)",
    zIndex: 1,
  },
  modalClose: {
    background: "none", border: "none",
    color: "#f3ebfb", cursor: "pointer",
    width: 36, height: 36, borderRadius: "50%",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: "0.88rem", flexShrink: 0, padding: 0,
  },
  modalHandle: {
    width: 42,
    height: 6,
    borderRadius: 999,
    background: "rgba(255,255,255,0.34)",
    boxShadow: "0 0 0 1px rgba(255,255,255,0.06), 0 4px 18px rgba(255,255,255,0.12)",
  },
  modalMenuBtn: {
    background: "none",
    border: "none",
    color: "#f3ebfb",
    cursor: "pointer",
    width: 36,
    height: 36,
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
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
    justifyContent: "space-between",
    gap: "1rem",
    marginBottom: "1.8rem",
  },
  modalFavorite: {
    width: 40,
    height: 40,
    borderRadius: "50%",
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(255,255,255,0.03)",
    color: "#fff",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    marginTop: "0.4rem",
  },
  modalDiscStage: {
    position: "relative",
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: 350,
    marginBottom: "2rem",
  },
  modalSideArt: {
    position: "absolute",
    top: "50%",
    width: 110,
    height: 110,
    borderRadius: "50%",
    overflow: "hidden",
    transform: "translateY(-50%)",
    opacity: 0.66,
    filter: "blur(0.2px)",
    border: "1px solid rgba(255,255,255,0.12)",
    boxShadow: "0 24px 40px rgba(0,0,0,0.3)",
  },
  modalSideArtLeft: {
    left: "-0.8rem",
  },
  modalSideArtRight: {
    right: "-0.8rem",
  },
  modalSideArtImage: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
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
    background: "radial-gradient(circle at 35% 26%, rgba(255,255,255,0.28), rgba(255,255,255,0.06) 24%, rgba(30,22,40,0.32) 58%, rgba(11,8,16,0.7) 100%)",
    border: "1px solid rgba(255,255,255,0.2)",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.38), inset 0 -24px 40px rgba(0,0,0,0.42), 0 34px 62px rgba(0,0,0,0.42)",
  },
  modalDiscInner: {
    width: "82%",
    height: "82%",
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
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
    bottom: "1.3rem",
    left: "50%",
    transform: "translateX(-50%)",
    fontSize: "0.9rem",
    color: "#fffafc",
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
    border: "none",
    background: "transparent",
    color: "rgba(255,255,255,0.94)",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    position: "relative",
  },
  modalTransportBtnActive: {
    color: "#E0AAFF",
    filter: "drop-shadow(0 0 10px rgba(224,170,255,0.32))",
  },
  modalTransportPrimary: {
    width: 84,
    height: 84,
    borderRadius: "50%",
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(255,255,255,0.12)",
    color: "#fff",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.16), 0 24px 40px rgba(0,0,0,0.36)",
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
  modalQueueHeading: {
    margin: "0 0 0.8rem",
    fontSize: "0.72rem",
    fontWeight: 700,
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    color: "rgba(255,255,255,0.46)",
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
