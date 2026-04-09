"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  playSnippet,
  getPlayerState,
  getUserPlaylists,
  getPlaylistTracks,
  getLikedTracks,
} from "../lib/snippet";
import {
  getTimestamps,
  saveTimestamp,
  deleteTimestamp,
  formatMs,
} from "../lib/timestamps";

const STORAGE_KEY = "spotify_access_token";

function getStoredToken() {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(STORAGE_KEY);
}

export default function Home() {
  const [token, setToken] = useState(null);
  const [hydrated, setHydrated] = useState(false);
  const [urlError, setUrlError] = useState(null);

  // Now Playing
  const [playerState, setPlayerState] = useState(null);
  const [labelInput, setLabelInput] = useState("");
  const [estimatedPos, setEstimatedPos] = useState(0);
  const lastPollRef = useRef(null);

  // Incrementing this causes the library + now-playing timestamp lists to re-read from localStorage
  const [, setTsVersion] = useState(0);

  // Library
  const [playlists, setPlaylists] = useState([]);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [openPlaylistId, setOpenPlaylistId] = useState(null);
  const [playlistTracks, setPlaylistTracks] = useState({}); // playlistId → track[]
  const [loadingPlaylistId, setLoadingPlaylistId] = useState(null);

  // Liked Songs
  const [likedOpen, setLikedOpen] = useState(false);
  const [likedTracks, setLikedTracks] = useState(null); // null = not yet loaded

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
      if (!lastPollRef.current?.isPlaying) return;
      const elapsed = Date.now() - lastPollRef.current.time;
      setEstimatedPos(lastPollRef.current.positionMs + elapsed);
    }, 500);
    return () => clearInterval(id);
  }, []);

  // ── Library ─────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!token || !libraryOpen || playlists.length > 0) return;
    getUserPlaylists(token).then(setPlaylists);
  }, [token, libraryOpen, playlists.length]);

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

  const jump = useCallback(
    async (trackUri, positionMs) => {
      const t = getStoredToken();
      if (!t) return;
      const res = await playSnippet(t, { trackUri, positionMs });
      if (res.status === 401) {
        localStorage.removeItem(STORAGE_KEY);
        setToken(null);
        return;
      }
      if (res.ok || res.status === 204) {
        lastPollRef.current = { time: Date.now(), positionMs, isPlaying: true };
        setEstimatedPos(positionMs);
      }
    },
    []
  );

  // ── Timestamps ───────────────────────────────────────────────────────────────

  const handleSaveTimestamp = useCallback(() => {
    if (!playerState) return;
    const label = labelInput.trim() || null;
    saveTimestamp(playerState.id, Math.floor(estimatedPos), label);
    setTsVersion((v) => v + 1);
    setLabelInput("");
  }, [playerState, estimatedPos, labelInput]);

  const handleDelete = useCallback((trackId, index) => {
    deleteTimestamp(trackId, index);
    setTsVersion((v) => v + 1);
  }, []);

  // ── Auth ─────────────────────────────────────────────────────────────────────

  const goLogin = () => {
    window.location.href = "/api/login";
  };

  const handleLogout = () => {
    localStorage.removeItem(STORAGE_KEY);
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

  const progressPct = playerState
    ? Math.min(100, (estimatedPos / playerState.durationMs) * 100)
    : 0;

  const nowPlayingTimestamps = playerState
    ? getTimestamps(playerState.id)
    : [];

  return (
    <main style={s.main}>
      <header style={s.header}>
        <h1 style={s.h1}>Snippet</h1>
        <div style={s.headerRight}>
          {token ? (
            <button style={s.btnGhost} onClick={handleLogout}>Log out</button>
          ) : (
            <button style={s.btnPrimary} onClick={goLogin}>Login with Spotify</button>
          )}
        </div>
      </header>

      {urlError && <p style={s.error}>Login issue: {urlError}</p>}

      {!token ? (
        <div style={s.empty}>
          <p style={s.emptyTitle}>Jump to the best parts.</p>
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
              <div style={s.nowPlaying}>
                {playerState.albumArt && (
                  <img src={playerState.albumArt} alt="Album art" style={s.albumArt} />
                )}
                <div style={s.trackInfo}>
                  <p style={s.trackName}>{playerState.name}</p>
                  <p style={s.artist}>{playerState.artists}</p>
                  <div style={s.progressBar}>
                    <div style={{ ...s.progressFill, width: `${progressPct}%` }} />
                  </div>
                  <div style={s.times}>
                    <span>{formatMs(estimatedPos)}</span>
                    <span>{formatMs(playerState.durationMs)}</span>
                  </div>
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
            </div>
          )}

          {/* ── My Library ── */}
          <div style={s.librarySection}>
            <button
              style={s.libraryToggle}
              onClick={() => setLibraryOpen((o) => !o)}
            >
              <span>My Library</span>
              <span style={s.chevron}>{libraryOpen ? "▲" : "▼"}</span>
            </button>

            {libraryOpen && (
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

                  {likedOpen && (
                    <div style={s.trackList}>
                      {likedTracks === null ? (
                        <p style={{ ...s.muted, padding: "0.75rem" }}>Loading…</p>
                      ) : likedTracks.length === 0 ? (
                        <p style={{ ...s.muted, padding: "0.75rem" }}>No liked songs found.</p>
                      ) : (
                        likedTracks.map((track) => {
                          const tss = getTimestamps(track.id);
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

                {/* Playlists */}
                {playlists.length === 0 && libraryOpen ? (
                  <p style={{ ...s.muted, padding: "0.5rem 0.25rem" }}>Loading playlists…</p>
                ) : (
                  playlists.map((pl) => {
                    const isOpen = openPlaylistId === pl.id;
                    const tracks = playlistTracks[pl.id] || [];
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

                        {isOpen && (
                          <div style={s.trackList}>
                            {loading ? (
                              <p style={{ ...s.muted, padding: "0.75rem" }}>Loading…</p>
                            ) : tracks.length === 0 ? (
                              <p style={{ ...s.muted, padding: "0.75rem" }}>No tracks found.</p>
                            ) : (
                              tracks.map((track) => {
                                const tss = getTimestamps(track.id);
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
            )}
          </div>
        </>
      )}
    </main>
  );
}

const s = {
  main: { padding: "1.5rem", maxWidth: 560, margin: "0 auto" },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: "1.75rem",
  },
  h1: { margin: 0, fontSize: "1.4rem", fontWeight: 700, letterSpacing: "-0.02em" },
  headerRight: { display: "flex", gap: "0.5rem" },
  muted: { color: "#6b7280", fontSize: "0.9rem", lineHeight: 1.6, margin: 0 },
  error: { color: "#fca5a5", marginBottom: "1rem", fontSize: "0.85rem" },

  empty: { marginTop: "3rem", textAlign: "center" },
  emptyTitle: { fontSize: "1.25rem", fontWeight: 600, margin: "0 0 0.5rem" },

  // Now Playing card
  card: {
    background: "#111827",
    borderRadius: 14,
    padding: "1.25rem",
    border: "1px solid #1f2937",
    marginBottom: "1.5rem",
  },
  nowPlaying: { display: "flex", gap: "1rem", marginBottom: "1.25rem" },
  albumArt: {
    width: 76, height: 76, borderRadius: 8,
    flexShrink: 0, objectFit: "cover", background: "#1f2937",
  },
  trackInfo: { flex: 1, minWidth: 0 },
  trackName: {
    margin: "0 0 0.2rem", fontWeight: 600, fontSize: "1rem",
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  },
  artist: { margin: "0 0 0.75rem", color: "#9ca3af", fontSize: "0.82rem" },
  progressBar: {
    height: 4, background: "#374151", borderRadius: 2,
    marginBottom: "0.35rem", overflow: "hidden",
  },
  progressFill: {
    height: "100%", background: "#1db954", borderRadius: 2,
    transition: "width 0.5s linear",
  },
  times: {
    display: "flex", justifyContent: "space-between",
    fontSize: "0.72rem", color: "#6b7280",
  },
  saveRow: { display: "flex", gap: "0.5rem", marginBottom: "1rem" },
  input: {
    flex: 1, padding: "0.5rem 0.75rem", borderRadius: 8,
    border: "1px solid #374151", background: "#1f2937",
    color: "#f9fafb", fontSize: "0.82rem", outline: "none",
  },
  list: {
    listStyle: "none", padding: 0, margin: 0,
    display: "flex", flexDirection: "column", gap: "0.35rem",
  },
  listItem: {
    display: "flex", alignItems: "center", gap: "0.5rem",
    background: "#1f2937", borderRadius: 8, padding: "0.5rem 0.75rem",
  },
  jumpBtn: {
    flex: 1, display: "flex", alignItems: "center", gap: "0.5rem",
    background: "none", border: "none", color: "#f9fafb",
    cursor: "pointer", fontSize: "0.88rem", padding: 0, textAlign: "left", minWidth: 0,
  },
  playIcon: { color: "#1db954", fontSize: "0.7rem", flexShrink: 0 },
  tsLabel: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  tsTime: { color: "#6b7280", fontSize: "0.78rem", flexShrink: 0 },
  deleteBtn: {
    background: "none", border: "none", color: "#4b5563",
    cursor: "pointer", fontSize: "0.8rem", padding: "0 0.15rem",
    flexShrink: 0, lineHeight: 1,
  },

  // Library
  librarySection: { marginTop: "0.5rem" },
  libraryToggle: {
    width: "100%", display: "flex", alignItems: "center",
    justifyContent: "space-between", padding: "0.75rem 1rem",
    background: "#111827", border: "1px solid #1f2937",
    borderRadius: 12, color: "#f9fafb", cursor: "pointer",
    fontSize: "0.95rem", fontWeight: 600,
  },
  chevron: { fontSize: "0.65rem", color: "#6b7280" },
  libraryBody: { marginTop: "0.5rem", display: "flex", flexDirection: "column", gap: "0.35rem" },

  playlistWrap: { borderRadius: 10, overflow: "hidden", border: "1px solid #1f2937" },
  playlistRow: {
    width: "100%", display: "flex", alignItems: "center", gap: "0.75rem",
    padding: "0.6rem 0.75rem", background: "#111827",
    border: "none", color: "#f9fafb", cursor: "pointer", textAlign: "left",
  },
  playlistArt: { width: 40, height: 40, borderRadius: 6, objectFit: "cover", flexShrink: 0 },
  playlistArtFallback: { width: 40, height: 40, borderRadius: 6, background: "#1f2937", flexShrink: 0 },
  likedArt: {
    width: 40, height: 40, borderRadius: 6, flexShrink: 0,
    background: "#4a1030", display: "flex", alignItems: "center",
    justifyContent: "center", fontSize: "1.1rem", color: "#e1306c",
  },
  playlistMeta: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 },
  playlistName: {
    fontSize: "0.88rem", fontWeight: 600,
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  },
  playlistCount: { fontSize: "0.75rem", color: "#6b7280" },

  trackList: { background: "#0d1117", borderTop: "1px solid #1f2937" },
  trackRow: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "0.55rem 0.75rem", borderBottom: "1px solid #161d2b",
    gap: "0.5rem",
  },
  trackLeft: { display: "flex", alignItems: "center", gap: "0.6rem", minWidth: 0, flex: 1 },
  trackArt: { width: 36, height: 36, borderRadius: 5, objectFit: "cover", flexShrink: 0 },
  trackArtFallback: { width: 36, height: 36, borderRadius: 5, background: "#1f2937", flexShrink: 0 },
  trackMeta: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 },
  trackRowName: {
    fontSize: "0.85rem", fontWeight: 500,
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
    display: "block",
  },
  trackRowArtist: { fontSize: "0.75rem", color: "#6b7280", display: "block" },
  chipRow: { display: "flex", flexWrap: "wrap", gap: "0.3rem", marginTop: "0.25rem" },
  chip: {
    padding: "0.15rem 0.5rem", borderRadius: 20,
    background: "#1a2a1a", border: "1px solid #1db954",
    color: "#1db954", fontSize: "0.72rem", cursor: "pointer",
    whiteSpace: "nowrap", maxWidth: 120,
    overflow: "hidden", textOverflow: "ellipsis",
  },
  trackRight: { display: "flex", alignItems: "center", gap: "0.6rem", flexShrink: 0 },
  trackDuration: { fontSize: "0.75rem", color: "#4b5563" },
  playTrackBtn: {
    background: "none", border: "none", color: "#9ca3af",
    cursor: "pointer", fontSize: "0.75rem", padding: "0.25rem",
    borderRadius: 4, lineHeight: 1,
  },

  // Buttons
  btnPrimary: {
    padding: "0.5rem 0.9rem", borderRadius: 8, border: "none",
    background: "#1db954", color: "#041109", fontWeight: 600,
    cursor: "pointer", fontSize: "0.82rem", whiteSpace: "nowrap",
  },
  btnPrimaryLg: {
    marginTop: "1.25rem", padding: "0.65rem 1.5rem",
    borderRadius: 10, border: "none", background: "#1db954",
    color: "#041109", fontWeight: 600, cursor: "pointer", fontSize: "1rem",
  },
  btnGhost: {
    padding: "0.4rem 0.75rem", borderRadius: 8,
    border: "1px solid #374151", background: "transparent",
    color: "#9ca3af", cursor: "pointer", fontSize: "0.82rem",
  },
};
