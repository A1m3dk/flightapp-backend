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
  const actual = leg.actualTime?.local || leg.revisedTime?.local || leg.predictedTime?.local;
  if (!scheduled || !actual) return 0;
  const diffMin = Math.round((new Date(actual) - new Date(scheduled)) / 60000);
  return diffMin > 0 ? diffMin : 0;
}

function getStatusPhase(status) {
  const s = (status || "").toLowerCase();
  if (s.includes("enroute") || s.includes("approach") || s.includes("diverted") || s.includes("departed")) return "AIRBORNE";
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
    const url = "https://airlabs.co/api/v9/suggest?q=" + encodeURIComponent(term) + "&api_key=" + AIRLABS_KEY;
    const apiRes = await fetch(url);
    if (!apiRes.ok) return res.json([]);
    const data = await apiRes.json();
    const airports = (data.response && data.response.airports) || [];
    const results = airports.slice(0, 8).map((a) => ({
      iata: a.iata_code,
      icao: a.icao_code,
      name: a.name,
      city: a.city,
      country: a.country_code,
    }));
    res.json(results.filter((a) => a.iata));
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
    const { depIata, arrIata } = req.params;
    const url = "https://airlabs.co/api/v9/schedules?dep_iata=" + depIata.toUpperCase() +
      "&arr_iata=" + arrIata.toUpperCase() + "&api_key=" + AIRLABS_KEY;
    const apiRes = await fetch(url);
    if (!apiRes.ok) return res.status(apiRes.status).json({ error: "AirLabs error" });

    const data = await apiRes.json();
    const flights = Array.isArray(data.response) ? data.response : [];

    const results = flights.map((f) => ({
      number: (f.flight_iata || "").trim(),
      airline: f.airline_iata,
      aircraftModel: null,
      departureScheduled: f.dep_time,
      arrivalScheduled: f.arr_time,
      status: f.status,
      codeshare: f.cs_flight_iata || null,
    }));

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: "Server error", detail: err.message });
  }
});

const metarCache = new Map();
const METAR_CACHE_MS = 10 * 60 * 1000;

async function fetchWeatherText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "FlightApp personal project" },
    });
    if (!r.ok) return "";
    return (await r.text()).trim();
  } catch (err) {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

app.get("/api/metar/:icao", async (req, res) => {
  const icao = req.params.icao.toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(icao)) return res.status(400).json({ error: "Invalid airport code" });

  const cached = metarCache.get(icao);
  if (cached && Date.now() - cached.timestamp < METAR_CACHE_MS) return res.json(cached.data);

  const [metar, taf] = await Promise.all([
    fetchWeatherText("https://aviationweather.gov/api/data/metar?ids=" + icao + "&format=raw"),
    fetchWeatherText("https://aviationweather.gov/api/data/taf?ids=" + icao + "&format=raw"),
  ]);

  const data = { icao, metar, taf };
  if (metar || taf) metarCache.set(icao, { data, timestamp: Date.now() });
  res.json(data);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const WIDEBODY = /A330|A340|A350|A380|747|767|777|787/i;

function toMs(t) {
  const s = t && (t.utc || t.local);
  if (!s) return null;
  const d = new Date(s.replace(" ", "T"));
  return isNaN(d.getTime()) ? null : d.getTime();
}

function arrivalEstimate(arr) {
  const revised = toMs(arr?.revisedTime);
  if (revised) return revised;
  const predicted = toMs(arr?.predictedTime);
  if (predicted) return predicted;
  const runway = toMs(arr?.runwayTime);
  if (runway) return runway + 8 * 60000;
  return toMs(arr?.scheduledTime);
}

function formatClock(ms, tz) {
  try {
    return new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz || undefined });
  } catch (err) {
    return new Date(ms).toISOString().slice(11, 16) + " UTC";
  }
}

function pollIntervalMinutes(f) {
  const nowMs = Date.now();
  if (f.lastPhase === "AIRBORNE") {
    const minsToEta = f.etaMs ? (f.etaMs - nowMs) / 60000 : null;
    return minsToEta != null && minsToEta <= 90 ? 10 : 45;
  }
  const depMs = f.depTargetMs || f.scheduledDepMs || new Date(f.date + "T12:00:00Z").getTime();
  const mins = (depMs - nowMs) / 60000;
  if (mins > 2880) return 720;
  if (mins > 720) return 180;
  if (mins > 180) return 60;
  if (mins > 60) return 20;
  if (mins > -90) return 10;
  return 45;
}

async function checkInbound(f, data, depSchedMs, depTargetMs) {
  const reg = data.aircraft?.reg;
  const depIcao = data.departure?.airport?.icao;
  if (!reg || !depIcao || !depSchedMs) return null;

  const url = "https://aerodatabox.p.rapidapi.com/flights/reg/" + reg + "/" + f.date + "/" + f.date;
  const apiRes = await fetch(url, { headers: adbHeaders });
  if (!apiRes.ok) return null;
  const history = await apiRes.json();
  if (!Array.isArray(history)) return null;

  const mine = (f.flightNumber || "").replace(/\s/g, "").toUpperCase();
  const inbound = history
    .filter((h) => {
      const arrSched = toMs(h.arrival?.scheduledTime);
      return (
        (h.number || "").replace(/\s/g, "").toUpperCase() !== mine &&
        h.arrival?.airport?.icao === depIcao &&
        arrSched &&
        arrSched <= depSchedMs
      );
    })
    .sort((a, b) => toMs(b.arrival.scheduledTime) - toMs(a.arrival.scheduledTime))[0];
  if (!inbound) return null;

  const arrivalMs = arrivalEstimate(inbound.arrival);
  if (!arrivalMs) return null;

  const turnaround = WIDEBODY.test(data.aircraft?.model || "") ? 60 : 40;
  const readyMs = arrivalMs + turnaround * 60000;
  const shortfall = Math.round((readyMs - depTargetMs) / 60000);

  return {
    number: inbound.number,
    from: inbound.departure?.airport?.iata || inbound.departure?.airport?.icao || "?",
    arrivalMs,
    shortfall,
    late: shortfall > 10,
    landed: /arriv|land/i.test(inbound.status || ""),
  };
}

async function sendTimeBasedAlerts(f, nowMs) {
  const phase = f.lastPhase || "NOT DEPARTED";
  if (phase !== "NOT DEPARTED" || !f.depTargetMs || !f.scheduledDepMs) return;

  const minsToSched = (f.scheduledDepMs - nowMs) / 60000;
  const minsToTarget = (f.depTargetMs - nowMs) / 60000;
  const updates = {};

  if (!f.notifiedCheckin && minsToSched <= 24 * 60 && minsToTarget > 45) {
    sendPushToSubscription(f.subscriptionId, f.flightNumber + " check-in open", "Online check-in is now open.");
    updates.notifiedCheckin = true;
  }
  if (!f.notifiedBoardingStart && minsToTarget <= 45 && minsToTarget > 0) {
    sendPushToSubscription(f.subscriptionId, f.flightNumber + " boarding", "Boarding is expected to begin soon.");
    updates.notifiedBoardingStart = true;
  }
  if (!f.notifiedBoardingEnd && minsToTarget <= 15 && minsToTarget > -5) {
    sendPushToSubscription(f.subscriptionId, f.flightNumber + " boarding closing", "Boarding closes shortly. Head to the gate.");
    updates.notifiedBoardingEnd = true;
  }

  if (Object.keys(updates).length > 0) {
    await TrackedFlight.findByIdAndUpdate(f._id, updates);
  }
}

let checkRunning = false;

async function checkAllTrackedFlights() {
  if (checkRunning) return;
  checkRunning = true;
  try {
    const flights = await TrackedFlight.find({});
    for (const f of flights) {
      try {
        const nowMs = Date.now();

        if (f.arrivalRefMs && (nowMs - f.arrivalRefMs) / 3600000 >= 24) {
          await TrackedFlight.findByIdAndDelete(f._id);
          continue;
        }

        await sendTimeBasedAlerts(f, nowMs);

        if (f.lastPhase === "ARRIVED" || f.lastPhase === "CANCELLED") continue;

        if (f.lastCheckedAt) {
          const sinceMin = (nowMs - new Date(f.lastCheckedAt).getTime()) / 60000;
          if (sinceMin < pollIntervalMinutes(f)) continue;
        }

        const firstPoll = !f.lastCheckedAt;

        await sleep(1100);
        let data = null;
        try {
          data = await fetchFlightData(f.flightNumber, f.date);
        } catch (err) {
          data = null;
        }
        if (!data) {
          await TrackedFlight.findByIdAndUpdate(f._id, { lastCheckedAt: new Date() });
          continue;
        }


        const dep = data.departure;
        const arr = data.arrival;
        const newStatus = getDelayMinutes(dep) > 15 || getDelayMinutes(arr) > 15 ? "Delayed" : "On time";
        const statusPhase = getStatusPhase(data.status);
        const depSchedMs = toMs(dep?.scheduledTime);
        const depTargetMs = toMs(dep?.revisedTime) || depSchedMs;
        const arrRefMs = toMs(arr?.revisedTime) || toMs(arr?.predictedTime) || toMs(arr?.scheduledTime);
        const minsToGo = depSchedMs ? (depSchedMs - nowMs) / 60000 : null;

        console.log("poll", f.flightNumber, f.date, statusPhase);

        const updates = {
          lastCheckedAt: new Date(),
          lastPhase: statusPhase,
          lastStatus: newStatus,
          lastGate: dep?.gate,
          lastTerminal: dep?.terminal,
        };
        if (depSchedMs) updates.scheduledDepMs = depSchedMs;
        if (depTargetMs) updates.depTargetMs = depTargetMs;
        if (arrRefMs) {
          updates.etaMs = arrRefMs;
          updates.arrivalRefMs = arrRefMs;
        }

        const notify = (title, body) => {
          if (!firstPoll) sendPushToSubscription(f.subscriptionId, title, body);
        };

        if (f.lastStatus && f.lastStatus !== newStatus) {
          notify(f.flightNumber + " status changed", newStatus);
        }
        if (dep?.gate && f.lastGate !== dep.gate) {
          notify(f.flightNumber + (f.lastGate ? " gate changed" : " gate assigned"), "Gate " + dep.gate);
        }
        if (dep?.terminal && f.lastTerminal !== dep.terminal) {
          notify(f.flightNumber + " terminal", "Terminal " + dep.terminal);
        }
        if (statusPhase === "CANCELLED" && !f.notifiedCancelled) {
          notify(f.flightNumber + " cancelled", "This flight has been cancelled. Check with the airline about rebooking.");
          updates.notifiedCancelled = true;
        }
        if (!f.notifiedTakeoff) {
          if (statusPhase === "AIRBORNE") {
            notify(f.flightNumber + " has taken off", "The flight is now airborne.");
            updates.notifiedTakeoff = true;
          } else if (statusPhase === "ARRIVED") {
            updates.notifiedTakeoff = true;
          }
        }
        if (!f.notifiedLanding && statusPhase === "ARRIVED") {
          notify(f.flightNumber + " has landed", "The flight has arrived.");
          updates.notifiedLanding = true;
        }

        if (
          !f.inboundResolved &&
          statusPhase === "NOT DEPARTED" &&
          data.aircraft?.reg &&
          minsToGo != null &&
          minsToGo <= 300 &&
          minsToGo > -30
        ) {
          const sinceInbound = f.lastInboundCheckAt
            ? (nowMs - new Date(f.lastInboundCheckAt).getTime()) / 60000
            : Infinity;
          if (sinceInbound >= 30) {
            updates.lastInboundCheckAt = new Date();
            await sleep(1100);
            let inbound = null;
            try {
              inbound = await checkInbound(f, data, depSchedMs, depTargetMs || depSchedMs);
            } catch (err) {
              console.log("inbound check failed:", f.flightNumber, err.message);
            }
            if (inbound && inbound.late) {
              sendPushToSubscription(
                f.subscriptionId,
                f.flightNumber + " may be delayed",
                "Your aircraft (" + inbound.number + " from " + inbound.from + ") " +
                  (inbound.landed ? "landed" : "is due") + " at " +
                  formatClock(inbound.arrivalMs, dep?.airport?.timeZone) +
                  ". Departure could slip by about " + inbound.shortfall + " min."
              );
              updates.inboundResolved = true;
            } else if (inbound && inbound.landed) {
              updates.inboundResolved = true;
            }
          }
        }

        await TrackedFlight.findByIdAndUpdate(f._id, updates);
      } catch (err) {
        console.log("tracked flight check failed:", f.flightNumber, err.message);
        await TrackedFlight.findByIdAndUpdate(f._id, { lastCheckedAt: new Date() }).catch(() => {});
      }
    }
  } finally {
    checkRunning = false;
  }
}

cron.schedule("*/5 * * * *", checkAllTrackedFlights);

app.get("/api/health", (req, res) => {
  checkAllTrackedFlights().catch((err) => console.log("health-triggered check failed:", err.message));
  res.json({ ok: true, time: new Date().toISOString() });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log("Backend running on port " + PORT));