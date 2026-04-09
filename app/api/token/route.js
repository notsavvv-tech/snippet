import { NextResponse } from "next/server";
import { cookies } from "next/headers";

const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI ?? "http://127.0.0.1:3000/callback";
const PKCE_COOKIE = "spotify_pkce_verifier";

/**
 * Exchange authorization code for tokens (PKCE — no client secret).
 */
export async function POST(request) {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json(
      { error: "SPOTIFY_CLIENT_ID missing on server" },
      { status: 500 }
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const code = body?.code;
  if (!code || typeof code !== "string") {
    return NextResponse.json({ error: "Missing code" }, { status: 400 });
  }

  const cookieStore = await cookies();
  const codeVerifier = cookieStore.get(PKCE_COOKIE)?.value;

  if (!codeVerifier) {
    console.error("[api/token] no PKCE cookie — restart login from /api/login");
    return NextResponse.json(
      {
        error:
          "Missing PKCE session. Click “Login with Spotify” again (do not bookmark the callback URL).",
      },
      { status: 400 }
    );
  }

  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    code_verifier: codeVerifier,
  });

  const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  const text = await tokenRes.text();
  console.log("[api/token] Spotify token response status", tokenRes.status);

  cookieStore.delete(PKCE_COOKIE);

  if (!tokenRes.ok) {
    console.error("[api/token] Spotify error", text);
    return NextResponse.json(
      { error: "Token exchange failed", detail: text },
      { status: tokenRes.status }
    );
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Invalid token response" }, { status: 502 });
  }

  return NextResponse.json({
    access_token: data.access_token,
    token_type: data.token_type,
    expires_in: data.expires_in,
    refresh_token: data.refresh_token ?? null,
    scope: data.scope,
  });
}
