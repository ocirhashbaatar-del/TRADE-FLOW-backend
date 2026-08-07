import { releaseExpiredReservations } from './inventory.js'

const INTERVAL_MS = 60_000

export function startReservationWorker() {
  let running = false
  const run = async () => {
    if (running) return
    running = true
    try {
      await releaseExpiredReservations()
    } catch (error) {
      console.error('Expired reservation worker failed', error)
    } finally {
      running = false
    }
  }
  void run()
  const timer = setInterval(() => void run(), INTERVAL_MS)
  timer.unref()
  return () => clearInterval(timer)
}
