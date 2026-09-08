import express from "express";
import http from "http";
import dotenv from "dotenv";
import cors from "cors";
import { Server } from "socket.io";
import connectDB from "./config/db.js";
import userRoutes from "./routes/userRoutes.js";
import sessionRoutes from "./routes/sessionRoutes.js";
import { notFound, errorHandler } from "./middleware/errorMiddleware.js";

dotenv.config();

connectDB();

const app = express();

const server = http.createServer(app);

const allowedOrigin = [
    'http://localhost:5174',
    'http://localhost:5173',
    process.env.CLIENT_URL, // e.g. https://your-app.vercel.app
].filter(Boolean);

const corsOptions = {
    origin: process.env.CLIENT_URL ? [process.env.CLIENT_URL, 'http://localhost:5173', 'http://localhost:5174'] : '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
};

const io = new Server(server, {
    cors: corsOptions
});

app.use(cors(corsOptions));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.set("io", io);

app.get("/", (req, res) => {
    res.send("API is running");
});

app.use("/api/users", userRoutes);
app.use("/api/sessions", sessionRoutes);

io.on("connection", (socket) => {
    console.log(`A user Connected ${socket.id}`);
    const userId = socket.handshake.query.userId;
    if (userId) {

        socket.join(userId);
        console.log(`User ${socket.id} joined room: ${userId}`);
    }

    socket.on("disconnect", () => {
        console.log(`User Disconnected ${socket.id}`);
    });
});

app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

server.listen(
    PORT,
    console.log(`Server running in ${process.env.NODE_ENV} mode on port ${PORT}`)
);


