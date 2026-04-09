import { NextResponse } from "next/server";
import { generateCodeChallenge, generateCodeVerifier } from "../../../lib/pkce";

const REDIRECT_URI = "http://127.0.0.1:3000/callback";
const PKCE_COOKIE = "spotify_pkce_verifier";

const SCOPES = [
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "streaming",
  "user-library-read",
].join(" ");

export async function GET() {
  const clientId = process.env.SPOTIFY_CLIENT_ID;

  if (!clientId) {
    console.error("[api/login] SPOTIFY_CLIENT_ID is missing");
    return NextResponse.json(
      { error: "Server missing SPOTIFY_CLIENT_ID. Add it to .env.local" },
      { status: 500 }
    );
  }

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge_method: "S256",
    code_challenge: codeChallenge,
    show_dialog: "true",
  });

  const url = `https://accounts.spotify.com/authorize?${params.toString()}`;
  console.log("[api/login] redirecting to Spotify (authorization code + PKCE)");

  const res = NextResponse.redirect(url);
  res.cookies.set(PKCE_COOKIE, codeVerifier, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });

  return res;
}
