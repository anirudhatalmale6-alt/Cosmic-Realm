import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import http from "http";
import { Server } from "socket.io";
import { rateLimit } from "express-rate-limit";
import authRouter from "./routes/auth.js";
import playerRouter from "./routes/player.js";
import leaderboardRouter from "./routes/leaderboard.js";
import { setupSocket } from "./socket/handler.js";

const app = express();
const server = http.createServer(app);
const PORT = parseInt(process.env.PORT || "3000");

// Socket.IO
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingInterval: 10000,
  pingTimeout: 5000,
});

// Middleware
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const apiLimiter = rateLimit({
  windowMs: 60_000,
  max: parseInt(process.env.API_RATE_LIMIT || "300"),
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api/", apiLimiter);

const authLimiter = rateLimit({
  windowMs: 60_000,
  max: parseInt(process.env.AUTH_RATE_LIMIT || "20"),
});

// Routes
app.use("/api/auth", authLimiter, authRouter);
app.use("/api/player", playerRouter);
app.use("/api/leaderboard", leaderboardRouter);

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// Socket.IO handlers
setupSocket(io);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[Cosmic Realm] Server running on port ${PORT}`);
});
