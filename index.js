// index.js (backend/)
const express = require("express");
const axios = require("axios");
const admin = require("firebase-admin");
const cron = require("node-cron");
const cors = require("cors");
const bodyParser = require("body-parser");

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ========== CONFIG ==========
// base URL folder log
const RAIN_BASE_URL = "http://202.90.198.212/logger/logfile/";
// prefix file
const RAIN_FILENAME_PREFIX = "logARG-";
// station code
const STATION_CODE = "stg1079";
// Firebase
const FIREBASE_DB_URL = "https://evaporasi-499c2-default-rtdb.asia-southeast1.firebasedatabase.app";
// ============================

// init Firebase Admin
const serviceAccount = require("./serviceAccount.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: FIREBASE_DB_URL
});
const rtdb = admin.database();

// format dd-mm-YYYY
function formatDateForFilename(d) {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

// ========== FIX UTAMA DI SINI ==========
// tambahkan .txt pada akhir filename
async function fetchRainLogByDate(dateObj) {
  const filename = `${RAIN_FILENAME_PREFIX}${formatDateForFilename(dateObj)}.txt`;
  const fileUrl = `${RAIN_BASE_URL}${filename}`;

  console.log("Fetching rain file:", fileUrl);

  const resp = await axios.get(fileUrl, { timeout: 10000 });
  return resp.data.toString();
}
// ========================================

function parseRainFromLogText(logText, stationCode) {
  const lines = logText.split(/\r?\n/);
  const hits = [];
  for (let ln of lines) {
    if (!ln || ln.indexOf(stationCode) === -1) continue;

    // format baru: STGxxxx;DDMMYYYYHHMMSS;rain;...
    const parts = ln.split(";");
    if (parts.length < 3) continue;

    const code = parts[0];
    const rawTs = parts[1];
    const rainStr = parts[2];

    // pastikan stasiun cocok persis
    if (code !== stationCode.toUpperCase()) continue;

    // parse datetime DDMMYYYYHHMMSS
    if (rawTs.length !== 14) continue;
    const DD = rawTs.substring(0, 2);
    const MM = rawTs.substring(2, 4);
    const YYYY = rawTs.substring(4, 8);
    const hh = rawTs.substring(8, 10);
    const mm = rawTs.substring(10, 12);
    const ss = rawTs.substring(12, 14);
    const dateObj = new Date(`${YYYY}-${MM}-${DD}T${hh}:${mm}:${ss}`);

    const rain = parseFloat(rainStr);
    console.log("RAIN ENTRY:", {ts: dateObj, rain});

    if (isNaN(rain)) continue;

    hits.push({ ts: dateObj, rain });
  }
  return hits;
}

function sumRainBetween(entries, a, b) {
  return entries
    .filter(e => e.ts.getTime() >= a && e.ts.getTime() < b)
    .reduce((sum, e) => sum + (isNaN(e.rain) ? 0 : e.rain), 0);
}

async function getLatestDistance() {
  const snap = await rtdb.ref("/devices/LIVE").once("value");
  const v = snap.val() || {};
  return {
    distance: v.distance ?? null,
    updatedAt: v.updatedAt ?? null
  };
}

async function getClosestHistoryHeight(timestampMs) {
  const d = new Date(timestampMs);
  const dateKey = formatDateForFilename(d);
  const snap = await rtdb.ref(`/history/${dateKey}`).once("value");
  const entries = snap.val();
  if (!entries) return null;

  const arr = [];
  Object.keys(entries).forEach(key => {
    const rec = entries[key];
    const timeStr = key.includes(":") ? key : (rec.time || key);
    const [hh, mm, ss] = timeStr.split(":").map(n => parseInt(n || "0"));
    const dt = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm, ss);
    arr.push({ ts: dt.getTime(), distance: rec.distance });
  });

  arr.sort((a, b) => Math.abs(a.ts - timestampMs) - Math.abs(b.ts - timestampMs));
  return arr.length ? arr[0] : null;
}

// ==========================
// 10 minutes evaporation
// ==========================
async function computeEvap10min() {
  try {
    const now = Date.now();
    const tenMinAgo = now - 10 * 60 * 1000;

    const latest = await getLatestDistance();
    if (latest.distance === null) return console.warn("no latest distance");

    const prev = await getClosestHistoryHeight(tenMinAgo);
    if (!prev) return console.warn("no prev history");

    // fetch rain logs (today + yesterday)
    const dNow = new Date(now);
    const dYest = new Date(now - 24 * 3600 * 1000);

    let text = "";
    try { text += await fetchRainLogByDate(dYest); } catch (e) {}
    try { text += "\n" + await fetchRainLogByDate(dNow); } catch (e) {}

    const rainEntries = parseRainFromLogText(text, STATION_CODE);
    const rain10 = sumRainBetween(rainEntries, tenMinAgo, now);

    const evap10 = (prev.distance - latest.distance) + rain10;

    await rtdb.ref(`evap10min/${now}`).set({
      timestamp: now,
      evap_mm: evap10,
      h_prev: prev.distance,
      h_now: latest.distance,
      rain_10min: rain10
    });

    console.log("Saved evap10:", evap10);

  } catch (err) {
    console.error("err compute10:", err.message || err);
  }
}

// ==========================
// DAILY 07:00 EVAP
// ==========================
async function computeEvapDailyAt7() {
  try {
    const now = new Date();
    const today7 = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 7, 0, 0);
    const yesterday7 = new Date(today7.getTime() - 24 * 3600 * 1000);

    const hToday = await getClosestHistoryHeight(today7.getTime());
    const hYest = await getClosestHistoryHeight(yesterday7.getTime());
    if (!hToday || !hYest) return console.warn("missing daily height");

    let text = "";
    try { text += await fetchRainLogByDate(yesterday7); } catch (e) {}
    try { text += "\n" + await fetchRainLogByDate(today7); } catch (e) {}

    const rainEntries = parseRainFromLogText(text, STATION_CODE);
    const rain24 = sumRainBetween(rainEntries, yesterday7.getTime(), today7.getTime());

    const evap = (hYest.distance - hToday.distance) + rain24;
    const dateKey = today7.toISOString().slice(0, 10);

    await rtdb.ref(`daily/${dateKey}`).set({
      date: dateKey,
      evap_mm: evap,
      h7_yesterday: hYest.distance,
      h7_today: hToday.distance,
      rain_24h: rain24,
      createdAt: Date.now()
    });

    console.log("Saved daily evap:", dateKey, evap);

  } catch (err) {
    console.error("err computeDaily:", err.message || err);
  }
}

// cron jobs
cron.schedule("*/10 * * * *", () => {
  console.log("cron 10m");
  computeEvap10min();
});
cron.schedule("0 7 * * *", () => {
  console.log("cron daily 07:00");
  computeEvapDailyAt7();
});

// API endpoints
app.get("/api/realtime", async (req, res) => {
  const snap = await rtdb.ref("/devices/LIVE").once("value");
  res.json(snap.val() || {});
});

app.get("/api/evap10/recent", async (req, res) => {
  const snap = await rtdb.ref("/evap10min").orderByKey().limitToLast(100).once("value");
  res.json(snap.val() || {});
});

app.get("/api/daily", async (req, res) => {
  const snap = await rtdb.ref("/daily").once("value");
  res.json(snap.val() || {});
});

app.post("/api/trigger10", async (req, res) => {
  await computeEvap10min();
  res.json({ status: "ok" });
});

app.post("/api/triggerDaily", async (req, res) => {
  await computeEvapDailyAt7();
  res.json({ status: "ok" });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log("Backend listening on", PORT));
