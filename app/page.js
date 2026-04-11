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
} from "../lib/snippet";
import {
  fetchAllTimestamps,
  saveTimestamp,
  deleteTimestamp,
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

export default function Home() {
  const [token, setToken] = useState(null);
  const [hydrated, setHydrated] = useState(false);
  const [urlError, setUrlError] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");

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

  // Liked Songs
  const [likedOpen, setLikedOpen] = useState(false);
  const [likedTracks, setLikedTracks] = useState(null); // null = not yet loaded

  // Track detail modal
  const [selectedTrack, setSelectedTrack] = useState(null);

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
    getUserPlaylists(token).then(setPlaylists);
  }, [token, playlists.length]);

  // When searching, eagerly load liked tracks and all playlist tracks
  useEffect(() => {
    if (!searchQuery) return;
    const t = getStoredToken();
    if (!t) return;
    if (likedTracks === null) {
      getLikedTracks(t).then(setLikedTracks);
    }
    playlists.forEach((pl) => {
      if (!playlistTracks[pl.id]) {
        getPlaylistTracks(t, pl.id).then((tracks) => {
          setPlaylistTracks((prev) => ({ ...prev, [pl.id]: tracks }));
        });
      }
    });
  }, [searchQuery, playlists]);

  const handleToggleLiked = useCallback(async () => {
    setLikedOpen((o) => !o);
    if (likedTracks !== null) return; // already loaded
    const t = getStoredToken();
    if (!t) return;
    const tracks = await getLikedTracks(t);
    setLikedTracks(tracks);
  }, [likedTracks]);

  const handleTogglePlaylist = useCallback(
    async (playlistId) => {
      if (openPlaylistId === playlistId) {
        setOpenPlaylistId(null);
        return;
      }
      setOpenPlaylistId(playlistId);
      if (playlistTracks[playlistId]) return; // already cached
      const t = getStoredToken();
      if (!t) return;
      setLoadingPlaylistId(playlistId);
      const tracks = await getPlaylistTracks(t, playlistId);
      setPlaylistTracks((prev) => ({ ...prev, [playlistId]: tracks }));
      setLoadingPlaylistId(null);
    },
    [openPlaylistId, playlistTracks]
  );

  // ── Playback ─────────────────────────────────────────────────────────────────

  const jump = useCallback(async (trackUri, positionMs) => {
    if (!trackUri || trackUri.startsWith("spotify:local:")) return;
    const t = getStoredToken();
    if (!t) return;
    const res = await playSnippet(t, { trackUri, positionMs });
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
      const retry = await playSnippet(newToken, { trackUri, positionMs });
      if (retry.status === 204 || retry.ok) {
        lastPollRef.current = { time: Date.now(), positionMs, isPlaying: true };
        setEstimatedPos(positionMs);
      }
      return;
    }
    if (res.status === 404) {
      alert("No active Spotify device. Open Spotify on any device and start playing something first, then try again.");
      return;
    }
    if (res.status === 403) {
      alert("Spotify Premium is required for playback control.");
      return;
    }
    console.error("[jump] unexpected status", res.status);
  }, []);

  // ── Volume (local optimistic state) ─────────────────────────────────────────

  const [volume, setVolumeState] = useState(null);

  // Sync volume from player state on first load and when it changes externally
  useEffect(() => {
    if (playerState?.volumePercent != null && volume === null) {
      setVolumeState(playerState.volumePercent);
    }
  }, [playerState?.volumePercent, volume]);

  const handlePlayPause = useCallback(async () => {
    const t = getStoredToken();
    if (!t || !playerState) return;
    if (playerState.isPlaying) {
      await pausePlayback(t);
      setPlayerState((prev) => prev ? { ...prev, isPlaying: false } : prev);
      if (lastPollRef.current) lastPollRef.current.isPlaying = false;
    } else {
      await resumePlayback(t);
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
    const t = getStoredToken();
    if (t) await seekToPosition(t, posMs);
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
              <stop offset="0%" stopColor="#ff5500" />
              <stop offset="100%" stopColor="#7b31c7" />
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
          {/* ── Now Playing ── */}
          {!playerState ? (
            <p style={{ ...s.muted, marginBottom: "1.5rem" }}>
              Nothing playing — open Spotify and start a track.
            </p>
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
                    style={{...s.seekSlider, background: `linear-gradient(to right, ${ORANGE} 0%, ${ORANGE} ${playerState.durationMs ? (estimatedPos / playerState.durationMs) * 100 : 0}%, #2a2a3a ${playerState.durationMs ? (estimatedPos / playerState.durationMs) * 100 : 0}%, #2a2a3a 100%)`}}
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
                    style={{...s.volumeSlider, background: `linear-gradient(to right, ${ORANGE} 0%, ${ORANGE} ${volume ?? 50}%, #2a2a3a ${volume ?? 50}%, #2a2a3a 100%)`}}
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
                                ▶
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
                                      ▶
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
        </>
      )}

      {/* ── Track Detail Modal ── */}
      {selectedTrack && (() => {
        const isCurrentTrack = playerState?.id === selectedTrack.id;
        const tss = allTimestamps[selectedTrack.id] || [];
        return (
          <div style={s.modalOverlay} onClick={() => setSelectedTrack(null)}>
            <div style={s.modalSheet} onClick={e => e.stopPropagation()}>
              {/* drag handle */}
              <div style={s.modalHandle} />

              {/* header */}
              <div style={s.modalHeader}>
                <button style={s.modalClose} onClick={() => setSelectedTrack(null)}>✕</button>
                <span style={s.modalTitle}>{selectedTrack.name}</span>
                <div style={{ width: 28 }} />
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

              {/* controls — only if this is the currently playing track */}
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
                    /*Playback progress bar*/
                    style={{...s.modalSeek, background: `linear-gradient(to right, ${ORANGE} 0%, ${ORANGE} ${playerState.durationMs ? (estimatedPos / playerState.durationMs) * 100 : 0}%, #2a2a3a ${playerState.durationMs ? (estimatedPos / playerState.durationMs) * 100 : 0}%, #2a2a3a 100%)`}}
                  />
                  <div style={s.modalTimes}>
                    <span>{formatMs(estimatedPos)}</span>
                    <span>{formatMs(playerState.durationMs)}</span>
                  </div>
                  <div style={s.modalBtnRow}>
                    <button style={s.modalPlayPause} onClick={handlePlayPause}>
                      {playerState.isPlaying
                        ? <span style={{ letterSpacing: "2px", fontSize: "1.3rem" }}>❙❙</span>
                        : <span style={{ fontSize: "1.3rem" }}>▶</span>}
                    </button>
                  </div>
                </div>
              )}

              {/* play from start if not current track */}
              {!isCurrentTrack && (
                <div style={s.modalBtnRow}>
                  <button
                    style={s.modalPlayFromStart}
                    onClick={() => { jump(selectedTrack.uri, 0); }}
                  >
                    ▶ Play
                  </button>
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
    </main>
  );
}

const ORANGE = "#ff5500";
const PURPLE = "#7b31c7";
const GRAD = "linear-gradient(135deg, #ff5500 -124%, #7b31c7 224%)";

const s = {
  main: {
    padding: "1.5rem", maxWidth: 600, margin: "0 auto",
    paddingBottom: "4rem",
  },

  // ── Header ──
  header: {
    display: "flex", alignItems: "center",
    gap: "0.75rem", marginBottom: "2rem",
    padding: "1rem 1.25rem",
    background: "rgba(255,255,255,0.03)",
    borderRadius: 16,
    border: "1px solid rgba(255,255,255,0.06)",
    backdropFilter: "blur(8px)",
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
    background: "#13131f",
    borderRadius: 18,
    border: "1px solid rgba(255,255,255,0.07)",
    marginBottom: "1.5rem",
    overflow: "hidden",
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
  artist: { margin: "0 0 0.6rem", color: "#8888aa", fontSize: "0.82rem" },
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
    background: "none", border: "none", cursor: "pointer",
    fontSize: "0.9rem", color: ORANGE, padding: 0, lineHeight: 1,
  },
  shuffleOff: {
    background: "none", border: "none", cursor: "pointer",
    fontSize: "0.9rem", color: "#3a3a58", padding: 0, lineHeight: 1,
  },

  controls: {
    display: "flex", alignItems: "center", gap: "1rem",
    marginBottom: "1rem",
    padding: "0.75rem 1rem",
    background: "rgba(255,255,255,0.03)",
    borderRadius: 12,
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
    background: "rgba(255,255,255,0.04)",
    borderRadius: 10, padding: "0.55rem 0.85rem",
    border: "1px solid rgba(255,255,255,0.05)",
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
    border: "1px solid rgba(255,255,255,0.06)",
    background: "#13131f",
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
    background: "#1e1e2e",
    border: "1px solid rgba(255,85,0,0.25)",
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
    background: "rgba(0,0,0,0.25)",
    borderTop: "1px solid rgba(255,255,255,0.05)",
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
    background: "rgba(255,85,0,0.12)",
    border: `1px solid rgba(255,85,0,0.35)`,
    color: "#ff7733", fontSize: "0.7rem", cursor: "pointer",
    whiteSpace: "nowrap", maxWidth: 120,
    overflow: "hidden", textOverflow: "ellipsis",
    transition: "background 0.15s",
  },
  trackRight: { display: "flex", alignItems: "center", gap: "0.6rem", flexShrink: 0 },
  trackDuration: { fontSize: "0.73rem", color: "#3a3a58" },
  playTrackBtn: {
    background: "none", border: "none", color: "#5a5a78",
    cursor: "pointer", fontSize: "0.78rem", padding: "0.3rem",
    borderRadius: 6, lineHeight: 1,
    transition: "color 0.15s",
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
    border: "1px solid rgba(255,255,255,0.1)",
    background: "rgba(255,255,255,0.04)",
    color: "#8888aa", cursor: "pointer", fontSize: "0.82rem",
    transition: "border-color 0.15s",
  },

  // ── Track Detail Modal ──
  modalOverlay: {
    position: "fixed", inset: 0,
    background: "rgba(0,0,0,0.75)",
    backdropFilter: "blur(6px)",
    zIndex: 100,
    display: "flex", alignItems: "flex-end", justifyContent: "center",
  },
  modalSheet: {
    width: "100%", maxWidth: 480,
    background: "#0f0f1a",
    borderRadius: "24px 24px 0 0",
    border: "1px solid rgba(255,255,255,0.08)",
    borderBottom: "none",
    maxHeight: "92vh",
    overflowY: "auto",
    padding: "0 1.5rem 3rem",
  },
  modalHandle: {
    width: 40, height: 4, borderRadius: 2,
    background: "rgba(255,255,255,0.15)",
    margin: "12px auto 0",
  },
  modalHeader: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "1rem 0 0.5rem",
  },
  modalClose: {
    background: "rgba(255,255,255,0.07)", border: "none",
    color: "#8888aa", cursor: "pointer",
    width: 28, height: 28, borderRadius: "50%",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: "0.75rem", flexShrink: 0,
  },
  modalTitle: {
    fontSize: "0.85rem", fontWeight: 600, color: "#8888aa",
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
    textAlign: "center", flex: 1, padding: "0 0.5rem",
  },
  modalArtWrap: {
    margin: "1.25rem auto",
    width: "78%", aspectRatio: "1",
    borderRadius: 16,
    overflow: "hidden",
    boxShadow: "0 12px 48px rgba(0,0,0,0.6)",
  },
  modalArt: {
    width: "100%", height: "100%", objectFit: "cover", display: "block",
  },
  modalArtFallback: {
    width: "100%", height: "100%",
    background: "linear-gradient(135deg, #1e1e2e, #2a1a3a)",
  },
  modalTrackInfo: {
    textAlign: "center", marginBottom: "1.25rem",
  },
  modalTrackName: {
    margin: "0 0 0.25rem", fontSize: "1.3rem", fontWeight: 800,
    letterSpacing: "-0.025em",
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  },
  modalArtist: {
    margin: 0, color: "#6b6b88", fontSize: "0.9rem",
  },
  modalControls: {
    marginBottom: "1.25rem",
  },
  modalSeek: {
    width: "100%", cursor: "pointer", display: "block",
    marginBottom: "0.4rem", accentColor: ORANGE,
  },
  modalTimes: {
    display: "flex", justifyContent: "space-between",
    fontSize: "0.72rem", color: "#5a5a78", marginBottom: "1.25rem",
  },
  modalBtnRow: {
    display: "flex", justifyContent: "center", marginBottom: "1.5rem",
  },
  modalPlayPause: {
    width: 64, height: 64, borderRadius: "50%",
    background: GRAD, border: "none",
    color: "#fff", cursor: "pointer",
    display: "flex", alignItems: "center", justifyContent: "center",
    transition: "transform 0.15s",
  },
  modalPlayFromStart: {
    padding: "0.65rem 2rem", borderRadius: 50,
    background: GRAD, border: "none",
    color: "#fff", fontWeight: 700, fontSize: "0.95rem",
    cursor: "pointer",
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
