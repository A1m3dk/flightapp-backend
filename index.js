import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";
import webpush from "web-push";
import cron from "node-cron";
import { connectDB, TrackedFlight, PushSubscription } from "./db.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const AERODATABOX_KEY = process.env.AERODATABOX_KEY;
const AIRLABS_KEY = process.env.AIRLABS_KEY;

webpush.setVapidDetails(
  "mailto:example@example.com",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

connectDB();

const adbHeaders = {
  "X-RapidAPI-Key": AERODATABOX_KEY,
  "X-RapidAPI-Host": "aerodatabox.p.rapidapi.com",
};

async function fetchFlightData(number, date) {
  const url = "https://aerodatabox.p.rapidapi.com/flights/number/" + number + "/" + date;
  const res = await fetch(url, { headers: adbHeaders });
  if (!res.ok) throw new Error("Flight not found");
  const data = await res.json();
  return data[0];
}

function getDelayMinutes(leg) {
  if (!leg) return 0;
  const scheduled = leg.scheduledTime?.local;
  const actual = leg.actualTime?.local || leg.predictedTime?.local;
  if (!scheduled || !actual) return 0;
  const diffMin = Math.round((new Date(actual) - new Date(scheduled)) / 60000);
  return diffMin > 0 ? diffMin : 0;
}

function getStatusPhase(status) {
  const s = (status || "").toLowerCase();
  if (s.includes("enroute") || s.includes("approach") || s.includes("diverted")) return "AIRBORNE";
  if (s.includes("landed") || s.includes("arrived")) return "ARRIVED";
  if (s.includes("cancel")) return "CANCELLED";
  return "NOT DEPARTED";
}

async function sendPushToSubscription(subscriptionId, title, body) {
  try {
    const record = await PushSubscription.findOne({ subscriptionId });
    if (!record) return;
    await webpush.sendNotification(record.subscription, JSON.stringify({ title, body }));
  } catch (err) {
    console.log("Push failed:", err.message);
  }
}

app.get("/api/flight/:number/:date", async (req, res) => {
  try {
    const data = await fetchFlightData(req.params.number, req.params.date);
    res.json([data]);
  } catch (err) {
    res.status(404).json({ error: "Flight not found" });
  }
});

app.get("/api/aircraft/:reg", async (req, res) => {
  try {
    const url = "https://aerodatabox.p.rapidapi.com/aircrafts/reg/" + req.params.reg;
    const apiRes = await fetch(url, { headers: adbHeaders });
    if (!apiRes.ok) return res.json(null);
    res.json(await apiRes.json());
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/aircraft-photo/:reg", async (req, res) => {
  try {
    const { reg } = req.params;
    const psRes = await fetch("https://api.planespotters.net/pub/photos/reg/" + reg);
    if (psRes.ok) {
      const psData = await psRes.json();
      const psPhoto = psData.photos && psData.photos[0];
      if (psPhoto) {
        return res.json({
          source: "planespotters",
          imageUrl: psPhoto.thumbnail_large?.src || psPhoto.thumbnail?.src,
          photographer: psPhoto.photographer,
          link: psPhoto.link,
        });
      }
    }
    const adRes = await fetch("https://airport-data.com/api/ac_thumb.json?r=" + reg);
    if (adRes.ok) {
      const adData = await adRes.json();
      const adPhoto = adData.data && adData.data[0];
      if (adPhoto) {
        return res.json({
          source: "airport-data",
          imageUrl: adPhoto.image,
          photographer: adPhoto.photographer,
          link: adPhoto.link,
        });
      }
    }
    res.json(null);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/image-proxy", async (req, res) => {
  try {
    const imageUrl = req.query.url;
    if (!imageUrl) return res.status(400).send("Missing url");
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) return res.status(404).send("Not found");
    const contentType = imgRes.headers.get("content-type") || "image/jpeg";
    const buffer = await imgRes.arrayBuffer();
    res.set("Content-Type", contentType);
    res.send(Buffer.from(buffer));
  } catch (err) {
    res.status(500).send("Error");
  }
});

app.get("/api/live-position/:callsign", async (req, res) => {
  try {
    const apiRes = await fetch("https://api.airplanes.live/v2/callsign/" + req.params.callsign);
    if (!apiRes.ok) return res.json(null);
    const data = await apiRes.json();
    const match = data.ac && data.ac[0];
    if (!match) return res.json(null);
    res.json({
      lat: match.lat,
      lon: match.lon,
      altitude: match.alt_baro,
      speed: match.gs,
      heading: match.track,
      onGround: match.alt_baro === "ground",
    });
  } catch (err) {
    res.status(500).json({ error: "Server error", detail: err.message });
  }
});

app.get("/api/live-position-hex/:hex", async (req, res) => {
  try {
    const apiRes = await fetch("https://api.airplanes.live/v2/hex/" + req.params.hex);
    if (!apiRes.ok) return res.json(null);
    const data = await apiRes.json();
    const match = data.ac && data.ac[0];
    if (!match) return res.json(null);
    res.json({
      lat: match.lat,
      lon: match.lon,
      altitude: match.alt_baro,
      speed: match.gs,
      heading: match.track,
      onGround: match.alt_baro === "ground",
    });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/aircraft-history/:reg/:date", async (req, res) => {
  try {
    const { reg, date } = req.params;
    const url = "https://aerodatabox.p.rapidapi.com/flights/reg/" + reg + "/" + date + "/" + date;
    const apiRes = await fetch(url, { headers: adbHeaders });
    if (!apiRes.ok) return res.json([]);
    const data = await apiRes.json();
    res.json(Array.isArray(data) ? data : []);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/vapid-public-key", (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

app.post("/api/push-subscribe", async (req, res) => {
  try {
    const { subscriptionId, subscription } = req.body;
    await PushSubscription.findOneAndUpdate(
      { subscriptionId },
      { subscriptionId, subscription },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.delete("/api/push-subscribe/:subscriptionId", async (req, res) => {
  try {
    await PushSubscription.deleteOne({ subscriptionId: req.params.subscriptionId });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/tracked/:subscriptionId", async (req, res) => {
  try {
    const flights = await TrackedFlight.find({ subscriptionId: req.params.subscriptionId });
    res.json(flights);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/tracked", async (req, res) => {
  try {
    const { subscriptionId, flightNumber, date, route } = req.body;
    const existing = await TrackedFlight.findOne({ subscriptionId, flightNumber, date });
    if (existing) return res.json(existing);
    const created = await TrackedFlight.create({ subscriptionId, flightNumber, date, route });
    res.json(created);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.delete("/api/tracked/:id", async (req, res) => {
  try {
    await TrackedFlight.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

const airportStatsCache = new Map();
const STATS_CACHE_MS = 15 * 60 * 1000;

app.get("/api/airport-stats/:iata", async (req, res) => {
  try {
    const { iata } = req.params;
    const cached = airportStatsCache.get(iata);
    if (cached && Date.now() - cached.timestamp < STATS_CACHE_MS) {
      return res.json(cached.data);
    }

    const url = "https://airlabs.co/api/v9/schedules?dep_iata=" + iata + "&api_key=" + AIRLABS_KEY;
    const apiRes = await fetch(url);
    if (!apiRes.ok) return res.status(apiRes.status).json({ error: "AirLabs error", status: apiRes.status });

    const data = await apiRes.json();
    const flights = Array.isArray(data.response) ? data.response : [];

    let onTime = 0, delayed = 0, cancelled = 0, totalDelayMin = 0, delayedCount = 0;
    flights.forEach((f) => {
      const status = (f.status || "").toLowerCase();
      if (status.includes("cancel")) { cancelled++; return; }
      const delayMin = f.delayed || 0;
      if (delayMin > 15) { delayed++; totalDelayMin += delayMin; delayedCount++; }
      else onTime++;
    });

    const total = onTime + delayed + cancelled;
    const result = {
      iata,
      totalFlights: total,
      onTime,
      delayed,
      cancelled,
      otpPercent: total > 0 ? Math.round((onTime / total) * 100) : null,
      avgDelayMin: delayedCount > 0 ? Math.round(totalDelayMin / delayedCount) : 0,
    };
    airportStatsCache.set(iata, { data: result, timestamp: Date.now() });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "Server error", detail: err.message });
  }
});

app.get("/api/airport-search/:term", async (req, res) => {
  try {
    const { term } = req.params;
    const url = "https://aerodatabox.p.rapidapi.com/airports/search/term?q=" + encodeURIComponent(term) + "&limit=8";
    const apiRes = await fetch(url, { headers: adbHeaders });
    if (!apiRes.ok) return res.json([]);
    const data = await apiRes.json();
    const items = Array.isArray(data.items) ? data.items : [];
    const results = items
      .filter((a) => a.iata)
      .map((a) => ({
        iata: a.iata,
        icao: a.icao,
        name: a.name,
        city: a.municipalityName,
        country: a.countryCode,
      }));
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: "Server error", detail: err.message });
  }
});

const airportResolveCache = new Map();

async function resolveIataToIcao(iata) {
  const cached = airportResolveCache.get(iata);
  if (cached) return cached;
  const url = "https://aerodatabox.p.rapidapi.com/airports/iata/" + iata;
  const apiRes = await fetch(url, { headers: adbHeaders });
  if (!apiRes.ok) return null;
  const data = await apiRes.json();
  const icao = data.icao;
  if (icao) airportResolveCache.set(iata, icao);
  return icao;
}

app.get("/api/route-search/:depIata/:arrIata/:date", async (req, res) => {
  try {
    const { depIata, arrIata, date } = req.params;
    const depIcao = await resolveIataToIcao(depIata.toUpperCase());
    if (!depIcao) return res.status(404).json({ error: "Departure airport not found" });

    await new Promise((resolve) => setTimeout(resolve, 1100));

    const arrIcao = await resolveIataToIcao(arrIata.toUpperCase());

    await new Promise((resolve) => setTimeout(resolve, 1100));

    const windows = [
      [date + "T00:00", date + "T12:00"],
      [date + "T12:00", date + "T23:59"],
    ];

    let allFlights = [];
    for (const [from, to] of windows) {
      const url = "https://aerodatabox.p.rapidapi.com/flights/airports/icao/" + depIcao +
        "/" + from + "/" + to + "?direction=Departure&withCancelled=false";
      const apiRes = await fetch(url, { headers: adbHeaders });
      if (apiRes.ok) {
        const data = await apiRes.json();
        allFlights = allFlights.concat(data.departures || []);
      } else {
        console.log("route-search window fetch failed:", apiRes.status, await apiRes.text());
      }
      await new Promise((resolve) => setTimeout(resolve, 1100));
    }

    console.log("route-search: total flights fetched from " + depIcao + ":", allFlights.length);

    const matches = allFlights.filter((f) => {
      const fIata = f.arrival?.airport?.iata?.toUpperCase();
      const fIcao = f.arrival?.airport?.icao?.toUpperCase();
      return fIata === arrIata.toUpperCase() || (arrIcao && fIcao === arrIcao.toUpperCase());
    });

    console.log("route-search matches found:", matches.length);

    const results = matches.map((f) => ({
      number: f.number,
      airline: f.airline?.name,
      aircraftModel: f.aircraft?.model,
      departureScheduled: f.departure?.scheduledTime?.local,
      arrivalScheduled: f.arrival?.scheduledTime?.local,
      status: f.status,
    }));

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: "Server error", detail: err.message });
  }
});

async function checkAllTrackedFlights() {
  const flights = await TrackedFlight.find({});
  for (const f of flights) {
    try {
      const data = await fetchFlightData(f.flightNumber, f.date);
      const dep = data.departure;
      const arr = data.arrival;

      const depDelay = getDelayMinutes(dep);
      const arrDelay = getDelayMinutes(arr);
      const newStatus = depDelay > 15 || arrDelay > 15 ? "Delayed" : "On time";
      const statusPhase = getStatusPhase(data.status);
      const scheduledDep = dep?.scheduledTime?.local;
      const minsToGo = scheduledDep ? (new Date(scheduledDep) - new Date()) / 60000 : null;

      const updates = { lastStatus: newStatus, lastGate: dep?.gate, lastTerminal: dep?.terminal };

      if (f.lastStatus && f.lastStatus !== newStatus) {
        sendPushToSubscription(f.subscriptionId, f.flightNumber + " status changed", newStatus);
      }
      if (f.lastGate !== dep?.gate && dep?.gate) {
        sendPushToSubscription(f.subscriptionId, f.flightNumber + " gate assigned", "Gate " + dep.gate);
      }
      if (f.lastTerminal !== dep?.terminal && dep?.terminal) {
        sendPushToSubscription(f.subscriptionId, f.flightNumber + " terminal", "Terminal " + dep.terminal);
      }
      if (!f.notifiedCheckin && minsToGo != null && minsToGo <= 24 * 60 && minsToGo > 45) {
        sendPushToSubscription(f.subscriptionId, f.flightNumber + " check-in open", "Online check-in is now open.");
        updates.notifiedCheckin = true;
      }
      if (!f.notifiedBoardingStart && minsToGo != null && minsToGo <= 45 && minsToGo > 0 && statusPhase === "NOT DEPARTED") {
        sendPushToSubscription(f.subscriptionId, f.flightNumber + " boarding", "Boarding is expected to begin soon.");
        updates.notifiedBoardingStart = true;
      }
      if (!f.notifiedBoardingEnd && minsToGo != null && minsToGo <= 15 && minsToGo > -60 && statusPhase !== "AIRBORNE") {
        sendPushToSubscription(f.subscriptionId, f.flightNumber + " boarding closing", "Boarding closes shortly. Head to the gate.");
        updates.notifiedBoardingEnd = true;
      }
      if (!f.notifiedTakeoff && statusPhase === "AIRBORNE") {
        sendPushToSubscription(f.subscriptionId, f.flightNumber + " has taken off", "The flight is now airborne.");
        updates.notifiedTakeoff = true;
      }
      if (!f.notifiedLanding && statusPhase === "ARRIVED") {
        sendPushToSubscription(f.subscriptionId, f.flightNumber + " has landed", "The flight has arrived.");
        updates.notifiedLanding = true;
      }

      const arrivalRef = arr?.actualTime?.local || arr?.predictedTime?.local || arr?.scheduledTime?.local;
      if (arrivalRef) {
        const hoursSinceArrival = (Date.now() - new Date(arrivalRef).getTime()) / (1000 * 60 * 60);
        if (hoursSinceArrival >= 24) {
          await TrackedFlight.findByIdAndDelete(f._id);
          continue;
        }
      }

      await TrackedFlight.findByIdAndUpdate(f._id, updates);
    } catch (err) {
      // skip this flight, keep checking the rest
    }
  }
}

cron.schedule("*/5 * * * *", checkAllTrackedFlights);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log("Backend running on port " + PORT));