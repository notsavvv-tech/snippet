"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  playSnippet,
  getPlayerState,
  getUserPlaylists,
  getPlaylistTracks,
  getLikedTracks,
  setShuffle,
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

  // Snippet editing
  const [editingSnippet, setEditingSnippet] = useState(null); // { trackId, index, label }
  const [editLabel, setEditLabel] = useState("");

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

    const params = new URLSearchParams(window.location.search);
    const err = params.get("error");
    const detail = params.get("detail");
    if (err) {
      if (!t) setUrlError(detail || err);
      window.history.replaceState({}, "", "/");
    }
  }, []);

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

  const jump = useCallback(async (trackUri, positionMs) => {
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
    const res = await playSnippet(t, { trackUri, positionMs, deviceId: targetDevice });
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
      const retry = await playSnippet(newToken, { trackUri, positionMs, deviceId: targetDevice });
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
  }, [playerState]);

  const handleSaveTimestamp = useCallback(async () => {
    if (!playerState) return;
    const t = getStoredToken();
    if (!t) return;
    const label = labelInput.trim() || null;
    const updated = await saveTimestamp(t, playerState.id, Math.floor(estimatedPos), label);
    if (updated) setAllTimestamps((prev) => ({ ...prev, [playerState.id]: updated }));
    setLabelInput("");
  }, [playerState, estimatedPos, labelInput]);

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

  return (
    <main style={s.main}>
      <header style={s.header}>
        <svg viewBox="46 13.5 38 7" style={{ height: "68px", width: "auto", flexShrink: 0, display: "block", margin: "0 auto" }}>
          <defs>
            <linearGradient id="logoGrad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#E0AAFF" />
              <stop offset="100%" stopColor="#3c096c" />
            </linearGradient>
            <filter id="invertFilter" colorInterpolationFilters="sRGB">
              <feColorMatrix type="matrix" values="-1 0 0 0 1  0 -1 0 0 1  0 0 -1 0 1  0 0 0 1 0" />
            </filter>
            <mask id="logoMask">
              <image
                href="/logo.png"
                x="0" y="0" width="130" height="34"
                preserveAspectRatio="xMidYMid meet"
                filter="url(#invertFilter)"
              />
            </mask>
          </defs>
          <rect x="0" y="0" width="130" height="34" fill="url(#logoGrad)" mask="url(#logoMask)" />
        </svg>
        {token && (
          <div style={s.headerRight}>
            <button style={s.btnGhost} onClick={handleLogout}>Log out</button>
          </div>
        )}
      </header>

      {urlError && <p style={s.error}>Login issue: {urlError}</p>}

      {!token ? (
        <div style={s.empty}>
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
          {/* ── Now Playing ── */}
          {!playerState ? (
            isNativeApp ? (
              <div style={s.devicePicker}>
                <p style={s.devicePickerHeading}>Ready to play on this device</p>
                <p style={{ ...s.muted, fontSize: "0.82rem" }}>
                  Tap ▶ on any track below — Snippet will try to play through Spotify on this phone.
                </p>
              </div>
            ) : webPlayerId ? (
              <div style={s.devicePicker}>
                <p style={s.devicePickerHeading}>Ready to play</p>
                <p style={{ ...s.muted, fontSize: "0.82rem" }}>
                  Tap ▶ on any track below — audio will play here in the browser.
                </p>
              </div>
            ) : (
            <div style={s.devicePicker}>
              <p style={s.devicePickerHeading}>Where do you want to play?</p>
              <p style={{ ...s.muted, marginBottom: "1.25rem", fontSize: "0.8rem" }}>
                The browser player is connecting… or open Spotify on another device.
              </p>
              {devices.length === 0 ? (
                <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                  <p style={{ ...s.muted, margin: 0, fontSize: "0.82rem" }}>
                    {loadingDevices ? "Looking for devices…" : "No other devices found."}
                  </p>
                  {!loadingDevices && (
                    <button style={{ ...s.btnGhost, fontSize: "0.75rem", whiteSpace: "nowrap" }} onClick={fetchDevices}>
                      Refresh
                    </button>
                  )}
                </div>
              ) : (
                <div style={s.deviceList}>
                  {devices.map((d) => {
                    const icon = d.type === "Smartphone" ? "📱" : d.type === "Speaker" ? "🔊" : d.type === "TV" ? "📺" : "💻";
                    const isSelected = deviceId === d.id;
                    return (
                      <button
                        key={d.id}
                        style={{ ...s.deviceRow, ...(isSelected ? s.deviceRowActive : {}) }}
                        onClick={() => setDeviceId(d.id)}
                      >
                        <span style={s.deviceIcon}>{icon}</span>
                        <span style={s.deviceName}>{d.name}</span>
                        {isSelected && <span style={s.deviceCheck}>✓</span>}
                      </button>
                    );
                  })}
                </div>
              )}
              {deviceId && (
                <p style={{ ...s.muted, marginTop: "1rem", fontSize: "0.78rem" }}>
                  Ready — tap ▶ on any track below to start playing.
                </p>
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
                  <p style={s.trackName}>{playerState.name}</p>
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

              <div style={s.controls}>
                <button
                  style={s.playPauseBtn}
                  onClick={handlePlayPause}
                  title={playerState.isPlaying ? "Pause" : "Play"}
                >
                  {playerState.isPlaying ? <span style={{ letterSpacing: "2px", fontSize: "1.1rem", lineHeight: 1 }}>❙❙</span> : "▶"}
                </button>
                <div style={s.volumeRow}>
                  <span style={s.volumeIcon}>🔈</span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={volume ?? 50}
                    onChange={handleVolumeChange}
                    style={{...s.volumeSlider, background: `linear-gradient(to right, transparent 0%, transparent ${volume ?? 50}%, #2a2a3a ${volume ?? 50}%, #2a2a3a 100%), ${GRAD}`}}
                    title={`Volume: ${volume ?? 50}%`}
                  />
                  <span style={s.volumeLabel}>{volume ?? 50}%</span>
                </div>
              </div>

              <div style={s.saveRow}>
                <input
                  style={s.input}
                  placeholder={`Label (optional) — at ${formatMs(estimatedPos)}`}
                  value={labelInput}
                  onChange={(e) => setLabelInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSaveTimestamp()}
                />
                <button style={s.btnPrimary} onClick={handleSaveTimestamp}>
                  Save moment
                </button>
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
              </div>
            );
          })()}

          {/* ── My Library ── */}
          <div style={s.librarySection}>
            <p style={s.libraryLabel}>Your Library</p>
            <input
              style={s.searchInput}
              placeholder="Search library…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            <div style={s.libraryBody}>
              {/* Liked Songs */}
              <div style={s.playlistWrap}>
                <button style={s.playlistRow} onClick={handleToggleLiked}>
                  <div style={s.likedArt}>♥</div>
                  <div style={s.playlistMeta}>
                    <span style={s.playlistName}>Liked Songs</span>
                    {likedTracks !== null && (
                      <span style={s.playlistCount}>{likedTracks.length} tracks</span>
                    )}
                  </div>
                  <span style={{ ...s.chevron, marginLeft: "auto" }}>
                    {likedOpen ? "▲" : "▼"}
                  </span>
                </button>

                {(likedOpen || searchQuery) && (
                  <div style={s.trackList}>
                    {likedTracks === null ? (
                      <p style={{ ...s.muted, padding: "0.75rem" }}>Loading…</p>
                    ) : likedTracks.length === 0 ? (
                      <p style={{ ...s.muted, padding: "0.75rem" }}>No liked songs found.</p>
                    ) : (
                      likedTracks.filter((track) => {
                        if (!searchQuery) return true;
                        const q = searchQuery.toLowerCase();
                        return track.name.toLowerCase().includes(q) || track.artists.toLowerCase().includes(q);
                      }).map((track) => {
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
                                      <button
                                        key={i}
                                        style={s.chip}
                                        onClick={() => jump(track.uri, ts.positionMs)}
                                        title={ts.label}
                                      >
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
                                onClick={() => jump(track.uri, 0)}
                                title="Play from start"
                              >
                                <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                              </button>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                )}
              </div>

              {/* Playlists */}
              {playlists.length === 0 ? (
                <p style={{ ...s.muted, padding: "0.5rem 0.25rem" }}>Loading playlists…</p>
              ) : (
                playlists
                .filter((pl) => !searchQuery || pl.name.toLowerCase().includes(searchQuery.toLowerCase()))
                .map((pl) => {
                  const isOpen = openPlaylistId === pl.id;
                  const tracks = (playlistTracks[pl.id] || []).filter((track) => {
                    if (!searchQuery) return true;
                    const q = searchQuery.toLowerCase();
                    return track.name.toLowerCase().includes(q) || track.artists.toLowerCase().includes(q);
                  });
                  const loading = loadingPlaylistId === pl.id;

                  return (
                    <div key={pl.id} style={s.playlistWrap}>
                      <button
                        style={s.playlistRow}
                        onClick={() => handleTogglePlaylist(pl.id)}
                      >
                        {pl.coverArt ? (
                          <img src={pl.coverArt} alt="" style={s.playlistArt} />
                        ) : (
                          <div style={s.playlistArtFallback} />
                        )}
                        <div style={s.playlistMeta}>
                          <span style={s.playlistName}>{pl.name}</span>
                          <span style={s.playlistCount}>{pl.trackCount} tracks</span>
                        </div>
                        <span style={{ ...s.chevron, marginLeft: "auto" }}>
                          {isOpen ? "▲" : "▼"}
                        </span>
                      </button>

                      {(isOpen || searchQuery) && (
                        <div style={s.trackList}>
                          {loading ? (
                            <p style={{ ...s.muted, padding: "0.75rem" }}>Loading…</p>
                          ) : playlistErrors[pl.id] ? (
                            <p style={{ ...s.muted, padding: "0.75rem" }}>{playlistErrors[pl.id]}</p>
                          ) : tracks.length === 0 ? (
                            <p style={{ ...s.muted, padding: "0.75rem" }}>{searchQuery ? "No matches." : "No tracks found."}</p>
                          ) : (
                            tracks.map((track) => {
                              const tss = allTimestamps[track.id] || [];
                              return (
                                <div key={track.id} style={s.trackRow}>
                                  <div style={s.trackLeft}>
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
                                            <button
                                              key={i}
                                              style={s.chip}
                                              onClick={() => jump(track.uri, ts.positionMs)}
                                              title={ts.label}
                                            >
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
                                      onClick={() => jump(track.uri, 0)}
                                      title="Play from start"
                                    >
                                      <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                                    </button>
                                  </div>
                                </div>
                              );
                            })
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
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
                      placeholder="Explore the digital void..."
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
              {!searchQuery ? (
                <p style={{ ...s.muted, textAlign: "center", marginTop: "3rem" }}>
                  Search any song or artist on Spotify
                </p>
              ) : searchLoading ? (
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
                                  <button key={i} style={s.chip} onClick={() => jump(track.uri, ts.positionMs)} title={ts.label}>
                                    {ts.label}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                        <div style={s.trackRight}>
                          <span style={s.trackDuration}>{formatMs(track.durationMs)}</span>
                          <button style={s.playTrackBtn} onClick={() => jump(track.uri, 0)} title="Play from start">
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
        return (
          <div style={s.modalOverlay} onClick={() => setSelectedTrack(null)}>
            <div style={s.modalSheet} onClick={e => e.stopPropagation()}>
              {/* header */}
              <div style={s.modalHeader}>
                <button style={s.modalClose} onClick={() => setSelectedTrack(null)}>✕</button>
                <span style={s.modalTitle}>{selectedTrack.name}</span>
                <div style={{ width: 36 }} />
              </div>

              {/* album art */}
              <div style={s.modalArtWrap}>
                {selectedTrack.albumArt ? (
                  <img src={selectedTrack.albumArt} alt="" style={s.modalArt} />
                ) : (
                  <div style={s.modalArtFallback} />
                )}
              </div>

              {/* track info */}
              <div style={s.modalTrackInfo}>
                <p style={s.modalTrackName}>{selectedTrack.name}</p>
                <p style={s.modalArtist}>{selectedTrack.artists}</p>
              </div>

              {/* seek bar — only if this is the currently playing track */}
              {isCurrentTrack && (
                <div style={s.modalControls}>
                  <input
                    type="range"
                    min={0}
                    max={playerState.durationMs}
                    value={estimatedPos}
                    onChange={handleSeekChange}
                    onMouseUp={handleSeekCommit}
                    onTouchEnd={handleSeekCommit}
                    style={{...s.modalSeek, background: `linear-gradient(to right, transparent 0%, transparent ${playerState.durationMs ? (estimatedPos / playerState.durationMs) * 100 : 0}%, #2a2a3a ${playerState.durationMs ? (estimatedPos / playerState.durationMs) * 100 : 0}%, #2a2a3a 100%), ${GRAD}`}}
                  />
                  <div style={s.modalTimes}>
                    <span>{formatMs(estimatedPos)}</span>
                    <span>{formatMs(playerState.durationMs)}</span>
                  </div>
                </div>
              )}

              {/* pulsing play button */}
              <div style={s.modalBtnRow}>
                {isCurrentTrack ? (
                  <button
                    className={playerState.isPlaying ? undefined : "play-pulse"}
                    style={s.modalPlayPause}
                    onClick={handlePlayPause}
                  >
                    {playerState.isPlaying
                      ? <span style={{ letterSpacing: "3px", fontSize: "1.5rem" }}>❙❙</span>
                      : <svg viewBox="0 0 512 512" width="30" height="30" fill="currentColor" style={{ marginLeft: 5 }}>
                          <path d="M424.4 214.7L72.4 6.6C43.8-10.3 0 6.1 0 47.9V464c0 37.5 40.7 60.1 72.4 41.3l352-208c31.4-18.5 31.5-64.1 0-82.6z" />
                        </svg>
                    }
                  </button>
                ) : (
                  <button
                    className="play-pulse"
                    style={s.modalPlayPause}
                    onClick={() => { jump(selectedTrack.uri, 0); }}
                  >
                    <svg viewBox="0 0 512 512" width="30" height="30" fill="currentColor" style={{ marginLeft: 5 }}>
                      <path d="M424.4 214.7L72.4 6.6C43.8-10.3 0 6.1 0 47.9V464c0 37.5 40.7 60.1 72.4 41.3l352-208c31.4-18.5 31.5-64.1 0-82.6z" />
                    </svg>
                  </button>
                )}
              </div>

              {/* save moment — only if currently playing */}
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

              {/* timestamps */}
              <div style={s.modalTimestamps}>
                <p style={s.modalTsHeading}>
                  {tss.length > 0 ? "Saved Moments" : "No saved moments yet"}
                </p>
                {tss.map((ts, i) => (
                  <button
                    key={i}
                    style={s.modalTsRow}
                    onClick={() => { jump(selectedTrack.uri, ts.positionMs); setSelectedTrack(null); }}
                  >
                    <span style={s.modalTsIcon}>▶</span>
                    <span style={s.modalTsLabel}>{ts.label}</span>
                    <span style={s.modalTsTime}>{formatMs(ts.positionMs)}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        );
      })()}
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
  headerRight: { display: "flex", gap: "0.5rem", flexShrink: 0 },
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
    background: "#120818",
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
  trackName: {
    margin: "0 0 0.2rem", fontWeight: 700, fontSize: "1rem",
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
    letterSpacing: "-0.01em",
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
    textTransform: "uppercase", color: "#4a4a68",
    padding: "0 0.25rem", marginBottom: "0.6rem",
  },
  chevron: { fontSize: "0.6rem", color: "#5a5a78" },
  libraryBody: { display: "flex", flexDirection: "column", gap: "0.4rem" },

  playlistWrap: {
    borderRadius: 12, overflow: "hidden",
    border: "1px solid rgba(224,170,255,0.07)",
    background: "#120818",
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

  // ── Your Snippets ──
  snippetCard: {
    background: "#120818",
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

  // ── Device Picker ──
  devicePicker: {
    background: "#120818",
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
    bottom: "1.5rem",
    left: "50%",
    transform: "translateX(-50%)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "2.25rem",
    padding: "0.875rem 2.75rem",
    background: "rgba(10, 6, 14, 0.9)",
    backdropFilter: "blur(24px)",
    WebkitBackdropFilter: "blur(24px)",
    borderRadius: 9999,
    border: "1px solid rgba(224,170,255,0.1)",
    boxShadow: "0 10px 42px rgba(0,0,0,0.62), 0 2px 8px rgba(0,0,0,0.34), inset 0 1px 0 rgba(255,255,255,0.04)",
    zIndex: 50,
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
    background: "rgba(0,0,0,0.92)",
    backdropFilter: "blur(12px)",
    zIndex: 100,
    display: "flex", alignItems: "stretch", justifyContent: "center",
    overflowY: "auto",
  },
  modalSheet: {
    width: "100%", maxWidth: 600,
    background: "#120818",
    minHeight: "100%",
    padding: "0 1.5rem 6rem",
    display: "flex", flexDirection: "column",
  },
  modalHeader: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "1.25rem 0 0.5rem",
    position: "sticky", top: 0,
    background: "#120818",
    zIndex: 1,
  },
  modalClose: {
    background: "rgba(255,255,255,0.08)", border: "none",
    color: "#c0c0d8", cursor: "pointer",
    width: 36, height: 36, borderRadius: "50%",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: "0.88rem", flexShrink: 0,
  },
  modalTitle: {
    fontSize: "0.88rem", fontWeight: 600, color: "#8888aa",
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
    textAlign: "center", flex: 1, padding: "0 0.75rem",
  },
  modalArtWrap: {
    margin: "1.5rem auto",
    width: "72%", aspectRatio: "1",
    borderRadius: 20,
    overflow: "hidden",
    boxShadow: "0 24px 64px rgba(0,0,0,0.7)",
    flexShrink: 0,
  },
  modalArt: {
    width: "100%", height: "100%", objectFit: "cover", display: "block",
  },
  modalArtFallback: {
    width: "100%", height: "100%",
    background: "linear-gradient(135deg, #1e1e2e, #2a1a3a)",
  },
  modalTrackInfo: {
    textAlign: "center", marginBottom: "1.5rem",
  },
  modalTrackName: {
    margin: "0 0 0.3rem", fontSize: "1.4rem", fontWeight: 800,
    letterSpacing: "-0.03em",
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  },
  modalArtist: {
    margin: 0, color: "#6b6b88", fontSize: "0.92rem",
  },
  modalControls: {
    marginBottom: "0.75rem",
  },
  modalSeek: {
    width: "100%", cursor: "pointer", display: "block",
    marginBottom: "0.4rem", accentColor: ORANGE,
  },
  modalTimes: {
    display: "flex", justifyContent: "space-between",
    fontSize: "0.72rem", color: "#5a5a78", marginBottom: "0.5rem",
  },
  modalBtnRow: {
    display: "flex", justifyContent: "center", marginBottom: "1.75rem",
  },
  modalPlayPause: {
    width: 80, height: 80, borderRadius: "50%",
    background: "linear-gradient(30deg, #E0AAFF 5%, #9D4EDD 45%, #5A189A 72%, #3c096c 100%)",
    border: "none",
    color: "#fff", cursor: "pointer",
    display: "flex", alignItems: "center", justifyContent: "center",
    boxShadow: "0 0 0 0 rgba(255, 100, 0, 0.7)",
  },
  modalSaveRow: {
    display: "flex", gap: "0.5rem", marginBottom: "1.75rem",
  },
  modalTimestamps: {
    borderTop: "1px solid rgba(255,255,255,0.06)",
    paddingTop: "1rem",
  },
  modalTsHeading: {
    margin: "0 0 0.75rem", fontSize: "0.7rem", fontWeight: 700,
    letterSpacing: "0.1em", textTransform: "uppercase", color: "#4a4a68",
  },
  modalTsRow: {
    width: "100%", display: "flex", alignItems: "center", gap: "0.75rem",
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(255,255,255,0.05)",
    borderRadius: 12, padding: "0.7rem 1rem",
    color: "#f0f0f5", cursor: "pointer", textAlign: "left",
    marginBottom: "0.4rem", transition: "background 0.15s",
  },
  modalTsIcon: { color: ORANGE, fontSize: "0.65rem", flexShrink: 0 },
  modalTsLabel: { flex: 1, fontSize: "0.9rem", fontWeight: 500, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  modalTsTime: { color: "#5a5a78", fontSize: "0.78rem", flexShrink: 0 },
};
