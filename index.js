import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());

const AERODATABOX_KEY = process.env.AERODATABOX_KEY;
const OPENSKY_CLIENT_ID = process.env.OPENSKY_CLIENT_ID;
const OPENSKY_CLIENT_SECRET = process.env.OPENSKY_CLIENT_SECRET;

let cachedToken = null;
let tokenExpiresAt = 0;

async function getOpenSkyToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  const res = await fetch(
    "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: OPENSKY_CLIENT_ID,
        client_secret: OPENSKY_CLIENT_SECRET,
      }),
    }
  );

  const rawText = await res.text();

  if (!res.ok) {
    throw new Error("Token request failed, status " + res.status + ": " + rawText.slice(0, 200));
  }

  let data;
  try {
    data = JSON.parse(rawText);
  } catch (e) {
    throw new Error("Token response wasn't JSON: " + rawText.slice(0, 200));
  }

  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

app.get("/api/flight/:number/:date", async (req, res) => {
  try {
    const { number, date } = req.params;
    const url = "https://aerodatabox.p.rapidapi.com/flights/number/" + number + "/" + date;
    const apiRes = await fetch(url, {
      headers: {
        "X-RapidAPI-Key": AERODATABOX_KEY,
        "X-RapidAPI-Host": "aerodatabox.p.rapidapi.com",
      },
    });
    if (!apiRes.ok) return res.status(apiRes.status).json({ error: "Flight not found" });
    const data = await apiRes.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/aircraft/:reg", async (req, res) => {
  try {
    const { reg } = req.params;
    const url = "https://aerodatabox.p.rapidapi.com/aircrafts/reg/" + reg;
    const apiRes = await fetch(url, {
      headers: {
        "X-RapidAPI-Key": AERODATABOX_KEY,
        "X-RapidAPI-Host": "aerodatabox.p.rapidapi.com",
      },
    });
    if (!apiRes.ok) return res.json(null);
    const data = await apiRes.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/aircraft-photo/:reg", async (req, res) => {
  try {
    const { reg } = req.params;
    const apiRes = await fetch("https://api.planespotters.net/pub/photos/reg/" + reg);
    if (!apiRes.ok) return res.json(null);
    const data = await apiRes.json();
    res.json((data.photos && data.photos[0]) || null);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/live-position/:callsign", async (req, res) => {
  try {
    const { callsign } = req.params;
    const token = await getOpenSkyToken();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    const apiRes = await fetch("https://opensky-network.org/api/states/all", {
      headers: { Authorization: "Bearer " + token },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!apiRes.ok) return res.json(null);
    const data = await apiRes.json();
    const clean = callsign.replace(/\s/g, "").toUpperCase();
    const match = data.states && data.states.find(function (s) {
      return s[1] && s[1].trim().toUpperCase() === clean;
    });
    if (!match) return res.json(null);
    res.json({
      lat: match[6],
      lon: match[5],
      altitude: match[7],
      speed: match[9],
      heading: match[10],
      onGround: match[8],
    });
  } catch (err) {
    res.status(500).json({ error: "Server error", detail: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log("Backend running on port " + PORT));