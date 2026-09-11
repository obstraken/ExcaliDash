import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { io as connectSocket, Socket } from "socket.io-client";
import jwt from "jsonwebtoken";
import type { Express } from "express";
import type { Server as HttpServer } from "http";
import { config } from "../config";
import { PrismaClient } from "../generated/client";
import { setupTestDb, getTestPrisma } from "./testUtils";

const admin = { "X-Authenticated-Email": "g.cothiasfaure@obstraken.com" };
const regular = { "X-Authenticated-Email": "Whiteboard-Test@example.test" };

describe("trusted portal authentication", () => {
  let prisma: PrismaClient;
  let app: Express;
  let httpServer: HttpServer;
  let baseUrl: string;
  let adminId: string;
  let regularId: string;
  const sockets: Socket[] = [];
  const originalMode = config.authMode;
  const originalAdmin = config.proxyAdminEmail;

  const openSocket = (headers: Record<string, string>) => new Promise<Socket>((resolve, reject) => {
    const socket = connectSocket(baseUrl, { transports: ["websocket"], extraHeaders: headers, reconnection: false });
    sockets.push(socket);
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", reject);
  });

  beforeAll(async () => {
    config.authMode = "proxy";
    config.proxyAdminEmail = admin["X-Authenticated-Email"];
    setupTestDb();
    prisma = getTestPrisma();
    ({ app, httpServer } = await import("../index"));
    await new Promise<void>(resolve => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("No test port");
    baseUrl = `http://127.0.0.1:${address.port}`;
    // The first account is deliberately the regular one: first-user-admin must never apply.
    const first = await request(app).get("/auth/me").set(regular);
    expect(first.body.user).toMatchObject({ email: "whiteboard-test@example.test", role: "USER" });
    regularId = first.body.user.id;
    adminId = (await request(app).get("/auth/me").set(admin)).body.user.id;
  });

  afterAll(async () => {
    for (const socket of sockets) socket.disconnect();
    await new Promise<void>(resolve => httpServer.close(() => resolve()));
    await prisma?.$disconnect();
    config.authMode = originalMode;
    config.proxyAdminEmail = originalAdmin;
  });

  it("grants ADMIN only to the configured email and reconciles stored roles", async () => {
    expect((await request(app).get("/auth/me").set(admin)).body.user.role).toBe("ADMIN");
    await prisma.user.update({ where: { id: regularId }, data: { role: "ADMIN" } });
    expect((await request(app).get("/auth/me").set(regular)).body.user.role).toBe("USER");
  });

  it("reports an authenticated proxy status without bootstrap or registration", async () => {
    const status = await request(app).get("/auth/status").set(regular);
    expect(status.body).toMatchObject({ authMode: "proxy", authenticated: true, authEnabled: true, bootstrapRequired: false, authOnboardingRequired: false, registrationEnabled: false });
  });

  it("refuses local registration even when the stored flag allows it", async () => {
    await prisma.systemConfig.update({ where: { id: "default" }, data: { registrationEnabled: true } });
    const res = await request(app).post("/auth/register").set(regular).send({ email: "new@example.test", password: "Str0ng!Passw0rd", name: "New" });
    expect(res.status).toBe(403);
    expect(await prisma.user.findUnique({ where: { email: "new@example.test" } })).toBeNull();
  });

  it("ignores missing or malformed identities and JWTs", async () => {
    const token = jwt.sign({ userId: adminId, email: admin["X-Authenticated-Email"], type: "access" }, config.jwtSecret);
    expect((await request(app).get("/auth/me")).status).toBe(401);
    expect((await request(app).get("/auth/me").set("Authorization", `Bearer ${token}`)).status).toBe(401);
    expect((await request(app).get("/auth/me").set("X-Authenticated-Email", "not an email")).status).toBe(401);
    expect((await request(app).get("/drawings").set("X-Authenticated-Email", "")).status).toBe(401);
  });

  it("refuses deactivated accounts explicitly", async () => {
    await prisma.user.update({ where: { id: regularId }, data: { isActive: false } });
    const disabled = await request(app).get("/auth/status").set(regular);
    expect(disabled.status).toBe(403);
    expect(disabled.body.code).toBe("ACCOUNT_DISABLED");
    await expect(openSocket(regular)).rejects.toThrow();
    await prisma.user.update({ where: { id: regularId }, data: { isActive: true } });
  });

  it("keeps private drawings isolated, even from the administrator", async () => {
    const drawing = await prisma.drawing.create({ data: { userId: regularId, name: "Private", elements: "[]", appState: "{}" } });
    expect((await request(app).get(`/drawings/${drawing.id}`).set(regular)).status).toBe(200);
    expect([403, 404]).toContain((await request(app).get(`/drawings/${drawing.id}`).set(admin)).status);
  });

  it("authenticates collaboration sockets from the gateway headers only", async () => {
    await expect(openSocket({})).rejects.toThrow();
    const socket = await openSocket(regular);
    const drawing = await prisma.drawing.create({ data: { userId: adminId, name: "Admin private", elements: "[]", appState: "{}" } });
    const denied = new Promise<{ message: string }>(resolve => socket.once("error", resolve));
    socket.emit("join-room", { drawingId: drawing.id, user: { id: regularId, name: "User" } });
    expect((await denied).message).toContain("do not have access");
  });
});
