import mongoose from "mongoose";

const trackedFlightSchema = new mongoose.Schema({
  flightNumber: String,
  date: String,
  route: String,
  lastStatus: String,
  lastGate: String,
  lastTerminal: String,
  notifiedCheckin: { type: Boolean, default: false },
  notifiedBoardingStart: { type: Boolean, default: false },
  notifiedBoardingEnd: { type: Boolean, default: false },
  notifiedTakeoff: { type: Boolean, default: false },
  notifiedLanding: { type: Boolean, default: false },
  notifiedCancelled: { type: Boolean, default: false },
  inboundResolved: { type: Boolean, default: false },
  lastCheckedAt: Date,
  lastInboundCheckAt: Date,
  lastPhase: String,
  scheduledDepMs: Number,
  depTargetMs: Number,
  etaMs: Number,
  arrivalRefMs: Number,
  subscriptionId: String,
});

const pushSubscriptionSchema = new mongoose.Schema({
  subscriptionId: String,
  subscription: Object,
});

export const TrackedFlight = mongoose.model("TrackedFlight", trackedFlightSchema);
export const PushSubscription = mongoose.model("PushSubscription", pushSubscriptionSchema);

export async function connectDB() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log("MongoDB connected");
}