import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());

const AERODATABOX_KEY = process.env.AERODATABOX_KEY;

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

app.get("/api/live-position/:callsign", async (req, res) => {
  try {
    const { callsign } = req.params;
    const apiRes = await fetch("https://opensky-network.org/api/states/all");
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log("Backend running on port " + PORT));
