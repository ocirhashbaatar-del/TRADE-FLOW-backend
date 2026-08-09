import { createServer } from 'node:http'
import { app } from './app.js'
import { env } from './config/env.js'
import { prisma } from './lib/prisma.js'
import { connectRedis, redis } from './lib/redis.js'
import { createSocketServer } from './socket.js'
import { startJobQueue, stopJobQueue } from './lib/job-queue.js'

const server = createServer(app)
createSocketServer(server)

async function start() {
  await prisma.$connect()
  await connectRedis()
  await startJobQueue()
  server.listen(env.PORT, '0.0.0.0', () => console.log(`TradeFlow API: http://localhost:${env.PORT}\nSwagger: http://localhost:${env.PORT}/api/docs`))
}

async function shutdown(signal: string) {
  console.log(`${signal}: shutting down`)
  server.close(async () => { await stopJobQueue(); await prisma.$disconnect(); if (redis.status === 'ready') await redis.quit(); process.exit(0) })
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
start().catch((error) => { console.error(error); process.exit(1) })
