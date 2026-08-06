import type { Server as HttpServer } from 'node:http'
import { Server } from 'socket.io'
import { frontendOrigins } from './config/env.js'
import { verifyAccessToken } from './utils/auth.js'
import { prisma } from './lib/prisma.js'

let io: Server
export function createSocketServer(server: HttpServer) {
  io = new Server(server, { cors: { origin: frontendOrigins, credentials: true } })
  io.use((socket, next) => { try { const token = socket.handshake.auth.token as string; socket.data.user = verifyAccessToken(token); next() } catch { next(new Error('Unauthorized')) } })
  io.on('connection', (socket) => {
    const user = socket.data.user as { id: string; tenantId?: string }
    void socket.join(`user:${user.id}`)
    if (user.tenantId) void socket.join(`tenant:${user.tenantId}`)
    socket.on('chat:send', async (input: { receiverId: string; body: string }, callback?: (value: unknown) => void) => {
      if (!input.body?.trim()) return
      const message = await prisma.message.create({ data: { senderId: user.id, receiverId: input.receiverId, body: input.body.trim() } })
      io.to(`user:${input.receiverId}`).emit('chat:message', message); callback?.(message)
    })
  })
  return io
}
export function notifyUser(userId: string, event: string, payload: unknown) { io?.to(`user:${userId}`).emit(event, payload) }
export function notifyTenant(tenantId: string, type: string, payload: Record<string, unknown>) {
  io?.to(`tenant:${tenantId}`).emit('realtime:event', { type, payload, timestamp: new Date().toISOString() })
}
