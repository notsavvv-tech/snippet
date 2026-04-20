import { NextResponse } from "next/server";
import { redis } from "../../../lib/db";

async function resolveUserId(authHeader) {
  const token = authHeader?.replace("Bearer ", "");
  if (!token) return null;
  const res = await fetch("https://api.spotify.com/v1/me", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.id ?? null;
}

function redisKey(userId) {
  return `ts:${userId}`;
}

// GET /api/timestamps — returns { [trackId]: [{positionMs, label}] }
export async function GET(request) {
  const userId = await resolveUserId(request.headers.get("Authorization"));
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const all = await redis.hgetall(redisKey(userId));
  if (!all) return NextResponse.json({});

  const result = {};
  for (const [trackId, val] of Object.entries(all)) {
    result[trackId] = typeof val === "string" ? JSON.parse(val) : val;
  }
  return NextResponse.json(result);
}

// POST /api/timestamps — body: { trackId, positionMs, label }
export async function POST(request) {
  const userId = await resolveUserId(request.headers.get("Authorization"));
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { trackId, positionMs, label } = await request.json();
  if (!trackId || positionMs == null) {
    return NextResponse.json({ error: "Missing trackId or positionMs" }, { status: 400 });
  }

  const existing = await redis.hget(redisKey(userId), trackId);
  const timestamps = existing
    ? (typeof existing === "string" ? JSON.parse(existing) : existing)
    : [];

  timestamps.push({ positionMs, label: label || null });
  timestamps.sort((a, b) => a.positionMs - b.positionMs);

  await redis.hset(redisKey(userId), { [trackId]: JSON.stringify(timestamps) });
  return NextResponse.json(timestamps);
}

// PATCH /api/timestamps — body: { trackId, index, label }
export async function PATCH(request) {
  const userId = await resolveUserId(request.headers.get("Authorization"));
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { trackId, index, label } = await request.json();
  if (!trackId || index == null) {
    return NextResponse.json({ error: "Missing trackId or index" }, { status: 400 });
  }

  const existing = await redis.hget(redisKey(userId), trackId);
  const timestamps = existing
    ? (typeof existing === "string" ? JSON.parse(existing) : existing)
    : [];

  if (index < 0 || index >= timestamps.length) {
    return NextResponse.json({ error: "Index out of range" }, { status: 400 });
  }

  timestamps[index].label = label || null;

  await redis.hset(redisKey(userId), { [trackId]: JSON.stringify(timestamps) });
  return NextResponse.json(timestamps);
}

// DELETE /api/timestamps — body: { trackId, index }
export async function DELETE(request) {
  const userId = await resolveUserId(request.headers.get("Authorization"));
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { trackId, index } = await request.json();
  if (!trackId || index == null) {
    return NextResponse.json({ error: "Missing trackId or index" }, { status: 400 });
  }

  const existing = await redis.hget(redisKey(userId), trackId);
  const timestamps = existing
    ? (typeof existing === "string" ? JSON.parse(existing) : existing)
    : [];

  timestamps.splice(index, 1);

  if (timestamps.length === 0) {
    await redis.hdel(redisKey(userId), trackId);
  } else {
    await redis.hset(redisKey(userId), { [trackId]: JSON.stringify(timestamps) });
  }
  return NextResponse.json(timestamps);
}
