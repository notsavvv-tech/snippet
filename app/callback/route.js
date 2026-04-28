import { NextResponse } from "next/server";

const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI ?? "http://127.0.0.1:3000/callback";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function callbackHtml({ accessToken, refreshToken, expiresIn, error, detail }) {
  const safeAccessToken = accessToken ? JSON.stringify(accessToken) : "null";
  const safeRefreshToken = refreshToken ? JSON.stringify(refreshToken) : "null";
  const safeExpiresIn = Number.isFinite(expiresIn) ? String(expiresIn) : "3600";
  const safeError = error ? JSON.stringify(error) : "null";
  const safeDetail = detail ? JSON.stringify(detail) : "null";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Snippet</title>
    <style>
      :root {
        color-scheme: dark;
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: start;
        padding: 2rem;
        background: linear-gradient(180deg, #14091f 0%, #0a0610 100%);
        color: #f4eef9;
        font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      p {
        margin: 0;
        font-size: 1rem;
      }
    </style>
  </head>
  <body>
    <p id="status">Completing Spotify login…</p>
    <script>
      (function () {
        const accessToken = ${safeAccessToken};
        const refreshToken = ${safeRefreshToken};
        const expiresIn = ${safeExpiresIn};
        const error = ${safeError};
        const detail = ${safeDetail};

        try {
          if (error) {
            window.location.replace("/?error=" + encodeURIComponent(error) + "&detail=" + encodeURIComponent(detail || ""));
            return;
          }

          if (!accessToken) {
            window.location.replace("/?error=token_exchange&detail=" + encodeURIComponent(detail || "Missing access token"));
            return;
          }

          localStorage.setItem("spotify_access_token", accessToken);
          if (refreshToken) {
            localStorage.setItem("spotify_refresh_token", refreshToken);
          }
          localStorage.setItem("spotify_token_expires_at", String(Date.now() + expiresIn * 1000));

          const status = document.getElementById("status");
          if (status) {
            status.textContent = "Spotify connected. Opening Snippet…";
          }

          window.location.replace("/");
        } catch (clientError) {
          window.location.replace("/?error=callback_storage&detail=" + encodeURIComponent(String(clientError)));
        }
      })();
    </script>
  </body>
</html>`;
}

export async function GET(request) {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  if (!clientId) {
    return new NextResponse(
      callbackHtml({
        error: "server_config",
        detail: "SPOTIFY_CLIENT_ID missing on server",
      }),
      {
        status: 500,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }
    );
  }

  const { searchParams } = new URL(request.url);
  const error = searchParams.get("error");
  const errorDescription = searchParams.get("error_description");
  const code = searchParams.get("code");
  const codeVerifier = searchParams.get("state");

  if (error) {
    return new NextResponse(
      callbackHtml({
        error,
        detail: errorDescription || "Spotify authorization failed",
      }),
      {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }
    );
  }

  if (!code) {
    return new NextResponse(
      callbackHtml({
        error: "no_code",
        detail: "No authorization code. Start login from the home page.",
      }),
      {
        status: 400,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }
    );
  }

  if (!codeVerifier) {
    return new NextResponse(
      callbackHtml({
        error: "pkce_missing",
        detail: "Missing PKCE verifier. Please log in again.",
      }),
      {
        status: 400,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }
    );
  }

  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    code_verifier: codeVerifier,
  });

  try {
    const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    const text = await tokenRes.text();
    if (!tokenRes.ok) {
      return new NextResponse(
        callbackHtml({
          error: "token_exchange",
          detail: text || `Spotify token exchange failed with ${tokenRes.status}`,
        }),
        {
          status: tokenRes.status,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }
      );
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return new NextResponse(
        callbackHtml({
          error: "token_parse",
          detail: "Spotify returned an invalid token response.",
        }),
        {
          status: 502,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }
      );
    }

    return new NextResponse(
      callbackHtml({
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? null,
        expiresIn: data.expires_in ?? 3600,
      }),
      {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }
    );
  } catch (requestError) {
    return new NextResponse(
      callbackHtml({
        error: "network",
        detail: escapeHtml(String(requestError)),
      }),
      {
        status: 502,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }
    );
  }
}
