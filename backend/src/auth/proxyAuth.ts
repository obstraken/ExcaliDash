import type { IncomingHttpHeaders } from "http";
import { PrismaClient } from "../generated/client";
import { config } from "../config";

// Only trustworthy behind the portal gateway: it strips client-supplied values
// and sets the verified Google email on the isolated network.
export const readProxyEmail = (headers: IncomingHttpHeaders): string | null => {
  const raw = headers["x-authenticated-email"];
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  return email.length <= 255 && /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(email) ? email : null;
};

const select = { id: true, username: true, email: true, name: true, role: true, mustResetPassword: true, isActive: true };

// The portal email is the account identity; accounts are created on first visit.
export const resolveProxyUser = async (prisma: PrismaClient, email: string) => {
  const role = email === config.proxyAdminEmail ? "ADMIN" : "USER";
  const user =
    (await prisma.user.findUnique({ where: { email }, select })) ??
    (await prisma.user.upsert({
      where: { email },
      update: {},
      create: { email, name: email.split("@")[0], role, passwordHash: "" },
      select,
    }));
  if (user.role === role) return user;
  return prisma.user.update({ where: { id: user.id }, data: { role }, select });
};
