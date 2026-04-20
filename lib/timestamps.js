export async function fetchAllTimestamps(token) {
  const res = await fetch("/api/timestamps", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return {};
  return res.json();
}

export async function saveTimestamp(token, trackId, positionMs, label) {
  const res = await fetch("/api/timestamps", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ trackId, positionMs, label: label || null }),
  });
  if (!res.ok) return null;
  return res.json(); // returns updated timestamps array for that track
}

export async function updateTimestamp(token, trackId, index, label) {
  const res = await fetch("/api/timestamps", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ trackId, index, label: label || null }),
  });
  if (!res.ok) return null;
  return res.json();
}

export async function deleteTimestamp(token, trackId, index) {
  const res = await fetch("/api/timestamps", {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ trackId, index }),
  });
  if (!res.ok) return null;
  return res.json(); // returns updated timestamps array for that track
}

export function formatMs(ms) {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, "0")}`;
}
