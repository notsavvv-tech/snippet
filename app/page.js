"use client";

import { useCallback, useEffect, useState } from "react";
import { DEFAULT_SNIPPET, playSnippet, snippetAtPositionMs } from "../lib/snippet";

const STORAGE_KEY = "spotify_access_token";

function getStoredToken() {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(STORAGE_KEY);
}

export default function Home() {
  const [token, setToken] = useState(null);
  const [hydrated, setHydrated] = useState(false);
  const [urlError, setUrlError] = useState(null);

  useEffect(() => {
    setHydrated(true);
    const t = getStoredToken();
    setToken(t);
    console.log("[home] hydrated, token present:", Boolean(t));

    const params = new URLSearchParams(window.location.search);
    const err = params.get("error");
    const detail = params.get("detail");
    if (err) {
      setUrlError(detail || err);
      console.error("[home] login error from query", err, detail);
      window.history.replaceState({}, "", "/");
    }
  }, []);

  const goLogin = useCallback(() => {
    console.log("[home] navigating to /api/login");
    window.location.href = "/api/login";
  }, []);

  const handlePlay = useCallback(async () => {
    const t = getStoredToken();
    if (!t) {
      console.warn("[play] no token — prompt login");
      alert("No Spotify session. Click “Login with Spotify” first.");
      return;
    }

    const res = await playSnippet(t, DEFAULT_SNIPPET);

    if (res.status === 204) {
      console.log("[play] success (204 No Content)");
      return;
    }

    if (res.status === 404) {
      console.warn("[play] no active device (404)");
      alert(
        "No active Spotify device. Open Spotify on desktop or mobile, start any track once, then try again."
      );
      return;
    }

    if (res.status === 401) {
      console.warn("[play] unauthorized — clearing token");
      localStorage.removeItem(STORAGE_KEY);
      setToken(null);
      alert("Session expired. Please log in again.");
      return;
    }

    const text = await res.text();
    console.error("[play] unexpected failure", res.status, text);
    alert(`Playback failed (HTTP ${res.status}). See console for details.`);
  }, []);

  const handleLogout = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setToken(null);
    console.log("[home] logged out (token cleared)");
  }, []);

  /** Example: play same track at 90s — pattern for slider / multiple snippets */
  const handlePlayAt90s = useCallback(async () => {
    const t = getStoredToken();
    if (!t) {
      alert("No Spotify session. Log in first.");
      return;
    }
    const custom = snippetAtPositionMs(DEFAULT_SNIPPET, 90_000);
    const res = await playSnippet(t, custom);
    if (res.status === 204) {
      console.log("[play 90s] ok");
      return;
    }
    if (res.status === 404) {
      alert("No active Spotify device.");
      return;
    }
    console.error("[play 90s]", res.status, await res.text());
  }, []);

  if (!hydrated) {
    return (
      <main style={styles.main}>
        <p>Loading…</p>
      </main>
    );
  }

  return (
    <main style={styles.main}>
      <h1 style={styles.h1}>Snippet</h1>
      <p style={styles.muted}>
        Playback companion — jumps in Spotify only (no audio stored or clipped here).
      </p>

      {urlError ? (
        <p style={styles.error}>Login issue: {urlError}</p>
      ) : null}

      <p style={styles.status}>
        Status: {token ? "Logged in" : "Not logged in"}
      </p>

      <div style={styles.row}>
        <button type="button" style={styles.btnPrimary} onClick={goLogin}>
          Login with Spotify
        </button>
        <button type="button" style={styles.btn} onClick={handlePlay}>
          Play Snippet (1:00)
        </button>
      </div>

      <div style={styles.row}>
        <button type="button" style={styles.btnGhost} onClick={handlePlayAt90s}>
          Play at 1:30 (demo helper)
        </button>
        {token ? (
          <button type="button" style={styles.btnGhost} onClick={handleLogout}>
            Clear token
          </button>
        ) : null}
      </div>
    </main>
  );
}

const styles = {
  main: { padding: "2rem", maxWidth: 520 },
  h1: { margin: "0 0 0.5rem", fontSize: "1.75rem" },
  muted: { color: "#9ca3af", marginBottom: "1rem", lineHeight: 1.5 },
  status: { marginBottom: "1rem", fontSize: "0.9rem" },
  error: { color: "#fca5a5", marginBottom: "1rem" },
  row: { display: "flex", flexWrap: "wrap", gap: "0.75rem", marginBottom: "0.75rem" },
  btn: {
    padding: "0.6rem 1rem",
    borderRadius: 8,
    border: "1px solid #374151",
    background: "#1f2937",
    color: "#f9fafb",
    cursor: "pointer",
    fontSize: "0.95rem",
  },
  btnPrimary: {
    padding: "0.6rem 1rem",
    borderRadius: 8,
    border: "none",
    background: "#1db954",
    color: "#041109",
    fontWeight: 600,
    cursor: "pointer",
    fontSize: "0.95rem",
  },
  btnGhost: {
    padding: "0.5rem 0.85rem",
    borderRadius: 8,
    border: "1px solid #4b5563",
    background: "transparent",
    color: "#d1d5db",
    cursor: "pointer",
    fontSize: "0.85rem",
  },
};
